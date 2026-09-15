import { roundCheckpoint } from '../helpers/event-checkpoint'
import { eventsWithId } from '../utils/event-index'
import { leaseSlots } from '../helpers/lease-slots'
import { writeRetrospective } from '../services/retrospective'
import { correlateEvent } from '../context/command-context'
import { assertCurrentSource } from '../helpers/source-binding'
import { createHmac, randomUUID } from 'node:crypto'
import {
  COORDINATOR_TOKEN_ENV,
  assertCoordinatorToken,
  assertExpected,
  commitControl,
  loadControl,
  signCoordinatorEvent
} from '../services/control-kernel'
import {
  assertPhaseTransition,
  phaseTransitions,
  ROLE_EVIDENCE_ON_ENTRY,
  type Phase
} from '../domain/policies/phase'
import { assertRoleEvidence } from '../helpers/role-evidence'
import { assertOperatorHandoff } from '../services/operator-handoff'
import { requireAttemptConvergence } from '../helpers/attempt-convergence'
import {
  assertSemanticCoverage,
  assertPacketCoverage,
  assertModificationCoverage,
  assertObservationCoverage,
  mustShipAcceptance
} from '../helpers/role-coverage'
import { readContractDocument } from '../services/contract-document'
import { currentCandidate } from '../helpers/candidate-evidence'
import { currentAdmission } from '../helpers/admission-authority'
import { assertShipEvidence } from '../helpers/ship-evidence'
import { assertTerminalBlocker } from '../domain/policies/authority-decisions'
import { assertAuthenticCurrentEpoch } from '../services/event-authentication'

const TOKEN_ENV = COORDINATOR_TOKEN_ENV
const PHASES = new Set(Object.keys(phaseTransitions()))

/** Transition the Bun-native phase state with authenticated, journaled evidence. */
export function transition(
  sdd: string,
  role: string,
  expectedState: string,
  expectedRevision: string,
  next: string,
  token = process.env[TOKEN_ENV]
): Readonly<{ protocol: 'transition/v1'; eventId: string; from: Phase; to: Phase }> {
  if (role !== 'coordinator') throw new Error('TRANSITION_COORDINATOR_ONLY')
  if (!PHASES.has(next as Phase)) throw new Error('PHASE_INVALID')
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  const control = loadControl(sdd)
  const { state } = control
  assertCurrentSource(state, sdd)
  const from = state.phase
  if (
    !Number.isSafeInteger(state.revision) ||
    Number(state.revision) < 0 ||
    Number(state.revision) >= Number.MAX_SAFE_INTEGER
  )
    throw new Error('CONTROL_REVISION_INVALID')
  if (!PHASES.has(from as Phase)) throw new Error('PHASE_UNRECORDED')
  assertExpected(state, expectedState, expectedRevision)
  assertCoordinatorToken(state, token)
  assertPhaseTransition(from as Phase, next as Phase)
  const events = control.events()
  // Stage transitions consume direct role evidence. A reply ending is not evidence.
  const roleEvent = (
    type: string,
    role: string,
    explicitId?: string,
    acceptanceIds?: readonly string[]
  ): Record<string, unknown> => {
    const id = explicitId ?? (state.last_role_events as Record<string, unknown> | undefined)?.[type]
    const matches = eventsWithId(events, id)
    const event = matches[0]
    if (
      matches.length !== 1 ||
      !event ||
      event.type !== type ||
      event.state !== from ||
      event.contract_revision !== state.contract_revision
    )
      throw new Error(`ROLE_GATE_MISSING: ${role}/${type} for ${from}`)
    assertRoleEvidence(state, event, role)
    const admission = currentAdmission(state, events, token).payload as Record<string, unknown>
    assertPacketCoverage(state, admission, events, event)
    if (type !== 'implementation') assertSemanticCoverage(state, admission, event)
    if (type === 'implementation' || type === 'verification')
      assertModificationCoverage(
        admission,
        event,
        type === 'verification' && (event.payload as Record<string, unknown>).result !== 'PASS'
      )
    if (type === 'verification') {
      let acceptance: Record<string, unknown>[] | undefined
      if (from === 'FINAL_VERIFY') {
        const contract = readContractDocument(sdd)
        if (!contract) throw new Error('FINAL_VERIFICATION_CONTRACT_REQUIRED')
        acceptance = mustShipAcceptance(contract as unknown as Record<string, unknown>).filter(
          (item) => !acceptanceIds || acceptanceIds.includes(String(item.id))
        )
      }
      assertObservationCoverage(admission, event, acceptance)
    }
    return event.payload as Record<string, unknown>
  }
  if (next !== 'BLOCKED') requireAttemptConvergence(state, events, token)
  if (next === 'CONTRACT_ADMITTED' || (from === 'CONTRACT_AMENDED' && next === 'OPERATOR_READBACK'))
    currentAdmission(state, events, token)
  if (from === 'OPERATOR_READBACK' && next === 'READBACK_APPROVED') {
    const payload = roleEvent('contract_readback', 'operator')
    if (payload.assessment !== 'ACCEPT' || payload.route_assessment !== 'SUPPORTED')
      throw new Error('READBACK_APPROVAL_REQUIRES_OPERATOR_ACCEPT')
  }
  if (from === 'IMPLEMENTING' && next === 'OPERATOR_SELF_CHECK') {
    roleEvent('implementation', 'operator')
    currentCandidate(sdd, state, events)
  }
  if (from === 'OPERATOR_SELF_CHECK' && next === 'ARCHITECT_VERIFY') {
    assertOperatorHandoff(sdd, state, events, token)
  }
  if (
    (from === 'ARCHITECT_VERIFY' && next === 'COORDINATOR_TRIAGE') ||
    (from === 'FINAL_VERIFY' && ['SHIP', 'COORDINATOR_TRIAGE'].includes(next))
  ) {
    const shardVerdicts = (state.final_shard_verdicts ?? {}) as Record<string, string>
    if (from === 'FINAL_VERIFY' && Object.keys(shardVerdicts).length) {
      // Sharded final verification: every planned shard has its own verdict on this revision.
      if (leaseSlots(state).length) throw new Error('FINAL_VERIFICATION_SHARDS_ACTIVE')
      const results = finalVerificationShards(sdd).map((shard) => {
        const eventId = shardVerdicts[shard.id]
        if (!eventId) throw new Error(`FINAL_VERIFICATION_SHARD_MISSING: ${shard.id}`)
        return roleEvent('verification', 'architect', eventId, shard.acceptance_ids).result
      })
      if (next === 'SHIP' && results.some((result) => result !== 'PASS'))
        throw new Error('SHIP_REQUIRES_FINAL_PASS')
    } else {
      const payload = roleEvent('verification', 'architect')
      if (next === 'SHIP' && payload.result !== 'PASS') throw new Error('SHIP_REQUIRES_FINAL_PASS')
    }
  }
  if (
    from === 'COORDINATOR_TRIAGE' &&
    !['CONTRACT_AMENDED', 'BLOCKED'].includes(next) &&
    (Number(state.consecutive_architect_rejections ?? 0) >= 3 ||
      Number(state.consecutive_stagnant_attempts ?? 0) >= 3)
  )
    throw new Error('CONVERGENCE_REVIEW_REQUIRES_READMISSION')
  if (next === 'BLOCKED') {
    if (state.pending_user_decision != null)
      throw new Error('USER_DECISION_CANNOT_TRANSITION_TO_BLOCKED')
    const blocker = events.findLast((event) => {
      const { signature, ...body } = event
      return (
        event.role === 'coordinator' &&
        event.type === 'terminal_blocker' &&
        event.state === from &&
        event.contract_revision === state.contract_revision &&
        signature === createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
      )
    })
    if (!blocker) throw new Error('TERMINAL_BLOCKER_EVIDENCE_REQUIRED')
    // Consume the cause itself, so an authenticated but empty note cannot end the loop.
    assertTerminalBlocker((blocker.payload ?? {}) as Record<string, unknown>)
  }
  if (next === 'SHIP') assertAuthenticCurrentEpoch(state, events, token)
  if (next === 'SHIP') assertShipEvidence(state, events, token, sdd)
  const eventId = `EVT-${randomUUID()}`
  const nextState: Record<string, unknown> = {
    ...state,
    phase: next,
    revision: Number(state.revision) + 1,
    updated_at: new Date().toISOString(),
    // Shard verdicts belong to one FINAL_VERIFY visit; entering or leaving it starts clean.
    ...(from === 'FINAL_VERIFY' || next === 'FINAL_VERIFY' ? { final_shard_verdicts: null } : {}),
    last_role_events: { ...(state.last_role_events as Record<string, unknown> | undefined) }
  }
  for (const type of ROLE_EVIDENCE_ON_ENTRY[next as Phase] ?? [])
    delete (nextState.last_role_events as Record<string, unknown>)[type]
  // A verified, closed round retires the retained Operator baseline; the next round freezes anew.
  if (next === 'ROUND_CLOSED') {
    nextState.operator_worktree_baseline = null
    nextState.packet_candidates = null
    // Round-scoped rules read from here on; see roundCheckpoint.
    nextState.event_checkpoint = roundCheckpoint(nextState, events, control.eventBytes)
  }
  if (from === 'ROUND_CLOSED' && next === 'CONTRACT_DRAFT') {
    const round = state.logical_round,
      max = state.max_rounds
    if (
      !Number.isSafeInteger(round) ||
      Number(round) < 1 ||
      !Number.isSafeInteger(max) ||
      Number(max) < 1
    )
      throw new Error('ROUND_COUNTER_INVALID')
    if (Number(round) >= Number(max)) throw new Error('ROUND_BUDGET_EXHAUSTED')
    Object.assign(nextState, {
      logical_round: Number(round) + 1,
      round_completed_attempts: 0,
      consecutive_stagnant_attempts: 0,
      consecutive_architect_rejections: 0
    })
  }
  // A terminal outcome ends every grant it leaves behind, so resource wind-down (retire, close) can
  // proceed; the outcome, history and product counters stay as they are.
  const revokedGrants: string[] = []
  if (next === 'SHIP' || next === 'BLOCKED') {
    revokedGrants.push(...leaseSlots(state).map((lease) => String(lease.lease_id)))
    const preparation = state.preparation as Record<string, unknown> | null | undefined
    if (preparation?.prepared_id) revokedGrants.push(String(preparation.prepared_id))
    Object.assign(nextState, { active_lease: null, shard_leases: {}, preparation: null })
  }
  const eventBody = correlateEvent({
    event_id: eventId,
    role: 'coordinator',
    type: 'state_transition',
    payload: { from, to: next, ...(revokedGrants.length ? { revoked_grants: revokedGrants } : {}) }
  })
  commitControl(control, nextState, signCoordinatorEvent(state, eventBody, token), token)
  // A terminal delivery immediately leaves its retrospective; failure to write it never undoes the commit.
  let retrospectivePath: string | null = null
  if (next === 'SHIP' || next === 'BLOCKED')
    try {
      retrospectivePath = writeRetrospective(sdd)
    } catch {
      retrospectivePath = null
    }
  return {
    protocol: 'transition/v1',
    eventId,
    from: from as Phase,
    to: next as Phase,
    ...(retrospectivePath ? { retrospective: retrospectivePath } : {})
  }
}

/** Planned final-verification shards of the current contract; sharded verdicts require a plan. */
function finalVerificationShards(sdd: string): { id: string; acceptance_ids: string[] }[] {
  const contract = readContractDocument(sdd) as unknown as Record<string, unknown> | undefined
  const plan = contract?.delivery_plan as Record<string, unknown> | undefined
  const shards = Array.isArray(plan?.final_verification_shards)
    ? plan.final_verification_shards
    : []
  if (!shards.length) throw new Error('FINAL_VERIFICATION_SHARDS_UNPLANNED')
  return shards as { id: string; acceptance_ids: string[] }[]
}
