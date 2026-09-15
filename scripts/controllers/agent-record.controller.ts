import { committedEventReader, windowStart } from '../resource/store/event-window'
import { loadControl } from '../services/control-kernel'
import { roundScopedEvents } from '../helpers/event-checkpoint'
import { eventsWithId } from '../utils/event-index'
import { parseEvents } from '../resource/store/event-log'
import { findLease, releaseLease, shardAcceptance } from '../helpers/lease-slots'
import { authorizeRoleLease } from '../helpers/role-lease-auth'
import { deriveChecks } from '../helpers/check-derivation'
import { assertNoCounterevidence } from '../helpers/measured-check'
import { packetBudgetSeconds } from '../helpers/test-budget-usage'
import { assertMutablePhase } from '../domain/policies/phase'
import { roleTransactionSecurity } from '../resource/role-transaction'
import { assertContextReadEvidence } from '../services/context-read-evidence'
import { assertOperatorHandoff } from '../services/operator-handoff'
import {
  assertPacketCoverage,
  assertSemanticCoverage,
  assertModificationCoverage,
  assertObservationCoverage,
  mustShipAcceptance
} from '../helpers/role-coverage'
import { canonicalJson } from '../resource/wire/canonical-json'
import { requireOperatorGoalAck } from '../helpers/operator-goal'
import { readContractDocument } from '../services/contract-document'
import { assertExecutionBindings } from '../helpers/execution-bindings'
import { requireGuidanceAck } from '../helpers/guidance-ack'
import { assertProgramExecution } from '../services/program-execution'
import { assertDependencyPlan } from '../schemas/dependency-operation'
import { assertDependencyReviewPlan } from '../helpers/dependency-evidence'
import { assertRoleReceipt } from '../schemas/role-receipt'
import { assertChallengeResponse } from '../helpers/design-challenge'
import { assertOracleSensitivityResults } from '../domain/policies/acceptance-execution'
import { assertTestChanges } from '../helpers/test-changes'
import type { WorktreeSnapshot } from '../resource/worktree/snapshot'
import { nextControlRevision } from '../domain/policies/control-revision'
import { assertDesignIndependence } from '../helpers/design-independence'
import { assertDesignProposal } from '../domain/policies/design-proposal'
import { correlateEvent } from '../context/command-context'
import { assertCurrentSource } from '../helpers/source-binding'
import { assertRoleEventPhase } from '../domain/policies/role-event-phase'
import { signRoleEvent } from '../resource/role-signature'
import {
  assertWorktreeCandidate,
  deltaPackages,
  leaseSnapshot
} from '../helpers/worktree-candidate'
import { currentCandidate, assertCandidateBinding } from '../helpers/candidate-evidence'
import { currentAdmission } from '../helpers/admission-authority'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { decodeState, sidecarPaths } from '../resource/state'
import { commitSidecar } from '../resource/store/sidecar-transaction'
import { chargeCredit, creditWeight } from '../helpers/credit-ledger'
import { assertRoleEvidence } from '../helpers/role-evidence'

const COORDINATOR_TOKEN_ENV = 'SDD_LOOP_COORDINATOR_TOKEN'
const ALLOWED = new Set([
  'dependency_operation_proposal',
  'dependency_safety_review',
  'plan_challenge',
  'implementation_escalation',
  'contract_readback',
  'checkpoint',
  'implementation',
  'self_check',
  'verification',
  'finding',
  'design_proposal',
  'capability_probe',
  'context_refresh',
  'test_run'
])

/**
 * Append directly signed role evidence under the active lease and current source.
 * Implementation and self-check bind the actual candidate before persistence.
 * A self-check FAIL is retained without ending the lease or charging an attempt;
 * only the dedicated failure flow changes product failure counters.
 */
/** The current candidate's four bindings, or nothing when no candidate can be resolved yet. */
function candidateBindingFacts(
  sdd: string,
  events: readonly Record<string, unknown>[]
): Record<string, unknown> {
  try {
    const state = decodeState(JSON.parse(readFileSync(sidecarPaths(sdd).state, 'utf8')))
    const { candidate } = currentCandidate(sdd, state, events)
    return Object.fromEntries(
      ['candidate_id', 'environment_fingerprint', 'manifest_sha256', 'worktree_fingerprint'].map(
        (field) => [field, candidate[field]]
      )
    )
  } catch {
    // The later candidate checks report the precise reason.
    return {}
  }
}

export function agentRecord(
  sdd: string,
  agent: 'operator' | 'architect',
  agentId: string,
  leaseId: string,
  expectedState: string,
  expectedRevision: string,
  type: string,
  payload: unknown,
  agentToken: string | undefined,
  coordinatorToken = process.env[COORDINATOR_TOKEN_ENV],
  // Set only by the test-run controller after it has timed the command itself.
  controllerMeasured = false
): Readonly<{ protocol: 'agent-record/v1'; eventId: string }> {
  if (!ALLOWED.has(type)) throw new Error('AGENT_EVENT_TYPE_INVALID')
  if (type === 'test_run' && !controllerMeasured)
    throw new Error('TEST_RUN_REQUIRES_CONTROLLER_MEASUREMENT: use test-run')
  // Role authentication alone cannot grant another role's evidence authority.
  if (agent !== 'operator' && agent !== 'architect') throw new Error('AGENT_ROLE_INVALID')
  if (
    (agent === 'operator' &&
      (type === 'verification' || type === 'finding' || type === 'design_proposal')) ||
    (agent === 'architect' && ['implementation', 'self_check', 'contract_readback'].includes(type))
  )
    throw new Error('AGENT_EVENT_ROLE_FORBIDDEN')
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('EVENT_PAYLOAD_MUST_BE_OBJECT')
  // Results are filled from controller facts before validation, so the signed record holds those
  // facts rather than role transcription: verification checks from the contract and the cited
  // measured runs, and candidate bindings from the current authenticated candidate. Supplied values
  // are kept and still have to match.
  if (type === 'verification' || type === 'self_check') {
    let recorded: Record<string, unknown>[] = []
    try {
      recorded = loadControl(sdd).events()
    } catch {
      // The authoritative reads below report an unreadable or unverifiable log precisely.
    }
    const supplied = payload as Record<string, unknown>
    payload = {
      ...candidateBindingFacts(sdd, recorded),
      ...supplied,
      ...(type === 'verification' && Array.isArray(supplied.checks)
        ? {
            checks: deriveChecks(
              (readContractDocument(sdd) ?? {}) as unknown as Record<string, unknown>,
              recorded,
              supplied.checks
            )
          }
        : {})
    }
  }
  // Validate before candidate/readback code accesses caller-supplied properties.
  canonicalJson(payload)
  assertRoleReceipt(type, payload as Record<string, unknown>)
  const paths = sidecarPaths(sdd)
  if (!existsSync(paths.state)) throw new Error('LOOP_NOT_INITIALIZED')
  const stateBytes = readFileSync(paths.state)
  const readAll = committedEventReader(paths.events, () => state as Record<string, unknown>)
  const readWindow = committedEventReader(
    paths.events,
    () => state as Record<string, unknown>,
    'window'
  )
  const state = decodeState(JSON.parse(stateBytes.toString('utf8')))
  assertMutablePhase(state.phase)
  assertRoleEventPhase(
    agent,
    type,
    state.phase,
    findLease(state as Record<string, unknown>, leaseId)?.verification_mode
  )
  assertCurrentSource(state, sdd)
  if (String(state.phase ?? '') !== expectedState) throw new Error('EXPECTED_STATE_MISMATCH')
  if (String(state.contract_revision ?? '') !== expectedRevision)
    throw new Error('EXPECTED_REVISION_MISMATCH')
  // A controller-measured run registers against lease-scoped and round-scoped facts only, so it reads
  // the round window; every other record may consult history as a whole.
  const priorEvents =
    type === 'test_run'
      ? roundScopedEvents(
          state as Record<string, unknown>,
          () =>
            windowStart(state as Record<string, unknown>).count
              ? [...parseEvents(readWindow())]
              : null,
          () => parseEvents(readAll())
        )
      : parseEvents(readAll())
  const { lease, credential } = authorizeRoleLease(state as Record<string, unknown>, priorEvents, {
    agent,
    agentId,
    leaseId,
    agentToken,
    type
  })
  requireOperatorGoalAck(state, priorEvents, lease, payload as Record<string, unknown>, type)
  if (type === 'context_refresh') {
    const refresh = payload as Record<string, unknown>
    if (
      agent !== 'operator' ||
      typeof refresh.read_result !== 'string' ||
      typeof refresh.summary !== 'string' ||
      !refresh.summary.trim()
    )
      throw Error('CONTEXT_REFRESH_READ_EVIDENCE_REQUIRED')
    // Derive reusable facts from complete validated pages, never a caller-supplied ledger.
    const reading = assertContextReadEvidence(sdd, refresh.read_result, {
      role: agent,
      agentId,
      packetId:
        typeof (lease as Record<string, unknown>).packet_id === 'string'
          ? String((lease as Record<string, unknown>).packet_id)
          : undefined
    })
    payload = { ...refresh, read_result: true, reading }
  }
  requireGuidanceAck(
    state,
    priorEvents,
    lease as Record<string, unknown>,
    coordinatorToken,
    payload as Record<string, unknown>,
    type
  )
  if (type === 'design_proposal') {
    if ((lease as Record<string, unknown>).verification_mode !== 'design-counsel')
      throw new Error('DESIGN_PROPOSAL_REQUIRES_COUNSEL_LEASE')
    assertDesignProposal(payload as Record<string, unknown>)
    assertChallengeResponse(
      state,
      priorEvents,
      payload as Record<string, unknown>,
      coordinatorToken
    )
  }
  if (type === 'dependency_operation_proposal')
    assertDependencyPlan(payload as Record<string, unknown>)
  if (type === 'dependency_safety_review') {
    if ((lease as Record<string, unknown>).verification_mode !== 'design-counsel')
      throw new Error('DEPENDENCY_SAFETY_REVIEW_REQUIRES_COUNSEL_LEASE')
    assertDependencyReviewPlan(
      state,
      priorEvents,
      payload as Record<string, unknown>,
      coordinatorToken
    )
  }
  const revision = nextControlRevision(state.revision)
  const eventId = `EVT-${randomUUID()}`
  let packetCandidate: Record<string, unknown> | undefined
  if (type === 'implementation') {
    assertProgramExecution(
      sdd,
      state,
      (lease as Record<string, unknown>).packet_id,
      'implementation',
      typeof (lease as Record<string, unknown>).worktree_root === 'string'
        ? String((lease as Record<string, unknown>).worktree_root)
        : undefined
    )
    const candidate = (payload as Record<string, unknown>).candidate
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error('CANDIDATE_INVALID')
    // Validate all binding fields before accepting an event that becomes the latest candidate.
    assertCandidateBinding(
      candidate as Record<string, unknown>,
      candidate as Record<string, unknown>
    )
    const delta = assertWorktreeCandidate(
      sdd,
      lease as Record<string, unknown>,
      candidate as Record<string, unknown>
    )
    const baseline = (lease as Record<string, unknown>).worktree_baseline as WorktreeSnapshot
    // The package claim must name exactly the admitted packages the real delta touches.
    const admitted = currentAdmission(state, priorEvents, coordinatorToken).payload as Record<
      string,
      unknown
    >
    const claimed = [
      ...new Set(((payload as Record<string, unknown>).changed_packages as string[]) ?? [])
    ].sort()
    const actual = deltaPackages(
      delta,
      (admitted.modification_packages as string[] | undefined) ?? [],
      baseline.owners
    )
    if (claimed.join('\0') !== actual.join('\0'))
      throw new Error('OPERATOR_WORKTREE_PACKAGE_CLAIM_MISMATCH')
    assertTestChanges(
      (payload as Record<string, unknown>).test_changes,
      new Set(baseline.files.filter((file) => file.kind !== 'missing').map((file) => file.path)),
      delta
    )
    // Tests stay inside the packet: no new files beyond its budget, and every changed test
    // proves one of the packet's own acceptance cases, never an unrelated failing gate.
    const leasePacket = (
      Array.isArray(admitted.execution_packets)
        ? (admitted.execution_packets as Record<string, unknown>[])
        : []
    ).find((item) => item.id === (lease as Record<string, unknown>).packet_id)
    const testScope = (leasePacket?.acceptance_ids ?? admitted.acceptance_ids ?? []) as string[]
    const newTestFileLimit = leasePacket
      ? Number(
          (leasePacket.test_budget as Record<string, unknown> | undefined)?.max_new_test_files ?? 0
        )
      : (Array.isArray(admitted.execution_packets)
          ? (admitted.execution_packets as Record<string, unknown>[])
          : []
        ).reduce(
          (sum, item) =>
            sum +
            Number(
              (item.test_budget as Record<string, unknown> | undefined)?.max_new_test_files ?? 0
            ),
          0
        )
    const testChanges = (payload as Record<string, unknown>).test_changes as Record<
      string,
      unknown
    >[]
    if (testChanges.filter((item) => item.action === 'CREATED').length > newTestFileLimit)
      throw new Error('TEST_SPRAWL_FORBIDDEN')
    if (
      testChanges.some((item) =>
        (item.acceptance_ids as string[]).some((id) => !testScope.includes(id))
      )
    )
      throw new Error('TEST_CHANGE_SCOPE_INVALID')
    // Record each packet's candidate so a prepared Architect can check it while the next packet
    // proceeds; those checks inform verification and never replace it.
    const packetId = (lease as Record<string, unknown>).packet_id
    const packet = (
      Array.isArray(admitted.execution_packets)
        ? (admitted.execution_packets as Record<string, unknown>[])
        : []
    ).find((item) => item.id === packetId)
    if (typeof packetId === 'string' && packet) {
      const acceptance = new Set((packet.acceptance_ids as string[] | undefined) ?? [])
      const snapshot = leaseSnapshot(sdd, lease as Record<string, unknown>)
      if (
        !snapshot ||
        snapshot.fingerprint !== (candidate as Record<string, unknown>).worktree_fingerprint
      )
        throw new Error('CANDIDATE_WORKTREE_CHANGED')
      packetCandidate = {
        packet_id: packetId,
        implementation_event_id: eventId,
        candidate_id: (candidate as Record<string, unknown>).candidate_id,
        worktree_fingerprint: snapshot.fingerprint,
        acceptance_ids: [...acceptance]
      }
    }
  }
  const body = correlateEvent({
    // Verification is a terminal role result, not an arbitrary progress message.
    event_id: eventId,
    state: state.phase,
    contract_revision: state.contract_revision,
    role: agent,
    type,
    payload,
    ...(type === 'design_proposal'
      ? { contract_revision: state.contract_revision, sdd_fingerprint: state.sdd_fingerprint }
      : {}),
    actor: {
      agent_id: agentId,
      lease_id: leaseId,
      authority_epoch: state.authority_epoch,
      dispatch_event_id: (lease as Record<string, unknown>).dispatch_event_id
    }
  })
  if (type === 'self_check') {
    const check = payload as Record<string, unknown>
    const events = priorEvents
    // Multi-packet implementations release their lease before the aggregate
    // self-check. Bind current product bytes, not an obsolete lease identity.
    const { event: candidateEvent, candidate } = currentCandidate(sdd, state, events)
    assertCandidateBinding(check, candidate)
    // A self-check cites controller-measured test_run events taken on this candidate; their total
    // stays within the claimed packets' budget. A packet admitted with a zero test budget hands off
    // on its candidate receipt alone; any other READY handoff needs measured runs.
    const runIds = Array.isArray(check.test_run_event_ids)
      ? (check.test_run_event_ids as string[])
      : []
    const admission = currentAdmission(state, events, coordinatorToken).payload as Record<
      string,
      unknown
    >
    const budgetSeconds = packetBudgetSeconds(
      admission,
      (check.execution_packet_ids as string[] | undefined) ?? []
    )
    if (check.handoff_status === 'READY_FOR_ARCHITECT' && budgetSeconds > 0 && !runIds.length)
      throw new Error('SELF_CHECK_TEST_RUNS_REQUIRED')
    let spent = 0
    for (const id of runIds) {
      const matches = eventsWithId(events, id)
      const run = matches[0]
      const data = run?.payload as Record<string, unknown> | undefined
      if (
        matches.length !== 1 ||
        !run ||
        !data ||
        run.type !== 'test_run' ||
        run.role !== 'operator' ||
        run.contract_revision !== state.contract_revision ||
        data.controller_measured !== true ||
        (data.inputs as Record<string, unknown> | undefined)?.candidate_event_id !==
          candidateEvent.event_id ||
        events.indexOf(run) < events.indexOf(candidateEvent)
      )
        throw new Error('TEST_RUN_EVIDENCE_INVALID')
      assertRoleEvidence(state, run, 'operator')
      if (check.handoff_status === 'READY_FOR_ARCHITECT' && data.outcome !== 'PASS')
        throw new Error('SELF_CHECK_READY_REQUIRES_PASSING_RUNS')
      if (check.handoff_status === 'READY_FOR_ARCHITECT')
        assertNoCounterevidence(events, run, data.acceptance_ids as string[])
      if (
        (data.acceptance_ids as string[]).some(
          (acceptance) => !(admission.acceptance_ids as string[]).includes(acceptance)
        )
      )
        throw new Error('TEST_RUN_SCOPE_INVALID')
      spent += Number(data.duration_seconds)
    }
    if (spent > budgetSeconds)
      throw new Error('TEST_BUDGET_EXCEEDED: escalate instead of widening tests')
  }
  // A measured run advances the round test clock (Operator) and the credit ledger even when it
  // overran: the time was spent. The next run then stops on the exhausted budget.
  let creditAfter: Record<string, unknown> | undefined
  if (type === 'test_run') {
    const duration = Number((payload as Record<string, unknown>).duration_seconds)
    creditAfter = chargeCredit(state, Math.ceil(duration / 60) * creditWeight('test_minute'), {
      allowOverrun: true
    })
  }
  if (type === 'verification') {
    const verdict = payload as Record<string, unknown>
    const events = priorEvents
    if ((lease as Record<string, unknown>).verification_mode === 'design-counsel')
      throw new Error('DESIGN_COUNSEL_CANNOT_VERIFY_PRODUCT')
    assertDesignIndependence(state, events, agentId)
    const { candidate } = currentCandidate(sdd, state, events)
    // An environment-drift report identifies the same product candidate while
    // explicitly reporting why the execution environment cannot be reused.
    assertCandidateBinding(verdict, candidate, verdict.result === 'INCONCLUSIVE_ENVIRONMENT')
    assertExecutionBindings(
      state,
      readContractDocument(sdd) as unknown as Record<string, unknown>,
      lease as Record<string, unknown>,
      verdict,
      events,
      currentAdmission(state, events, coordinatorToken).payload as Record<string, unknown>
    )
    const contract = readContractDocument(sdd)
    if (state.phase === 'FINAL_VERIFY' && !contract)
      throw new Error('FINAL_VERIFICATION_CONTRACT_REQUIRED')
    assertObservationCoverage(
      currentAdmission(state, events, coordinatorToken).payload as Record<string, unknown>,
      { payload: verdict },
      state.phase === 'FINAL_VERIFY'
        ? mustShipAcceptance(contract as unknown as Record<string, unknown>).filter((item) => {
            const shard = shardAcceptance(lease as Record<string, unknown>)
            return !shard || shard.includes(String(item.id))
          })
        : undefined
    )
    const covered = new Set((verdict.acceptance_ids as string[] | undefined) ?? [])
    const sensitive = ((contract?.acceptance ?? []) as Record<string, unknown>[])
      .filter(
        (item) =>
          covered.has(String(item.id)) &&
          (item.oracle_sensitivity as Record<string, unknown> | undefined)?.applicability ===
            'REQUIRED'
      )
      .map((item) => String(item.id))
    if (verdict.result === 'PASS')
      assertOracleSensitivityResults(sensitive, verdict.oracle_sensitivity_results)
  }
  const event = `${JSON.stringify(signRoleEvent(body, credential))}\n`
  const events = priorEvents
  if (
    type === 'contract_readback' &&
    (payload as Record<string, unknown>).assessment === 'ACCEPT'
  ) {
    const admission = currentAdmission(state, events, coordinatorToken).payload as Record<
      string,
      unknown
    >
    // Reject an incomplete accepted route at its producer, before it can replace
    // the last valid readback and later stall the transition consumer.
    assertPacketCoverage(state, admission, events, body)
    assertSemanticCoverage(state, admission, body)
  }
  let endsLease =
    [
      'verification',
      'design_proposal',
      'implementation_escalation',
      'dependency_operation_proposal',
      'dependency_safety_review'
    ].includes(type) ||
    (type === 'self_check' &&
      (payload as Record<string, unknown>).handoff_status === 'READY_FOR_ARCHITECT')
  if (type === 'implementation') {
    const admission = currentAdmission(state, events, coordinatorToken).payload as Record<
      string,
      unknown
    >
    assertPacketCoverage(state, admission, events, body, false)
    assertModificationCoverage(admission, body)
    endsLease = Array.isArray(admission.execution_packets) && admission.execution_packets.length > 1
  }
  const nextState = {
    ...state,
    updated_at: new Date().toISOString(),
    last_role_events: {
      ...(state.last_role_events as Record<string, unknown> | undefined),
      [type]: eventId
    },
    ...(endsLease ? releaseLease(state as Record<string, unknown>, leaseId) : {}),
    ...(endsLease
      ? {
          issued_leases: {
            ...(state.issued_leases as Record<string, unknown>),
            [leaseId]: {
              ...(state.issued_leases as Record<string, Record<string, unknown>>)[leaseId],
              ended_at: new Date().toISOString()
            }
          }
        }
      : {}),
    // A shard verdict is indexed by shard so the final transition can require every shard.
    ...(type === 'verification' &&
    typeof (lease as Record<string, unknown>).verification_shard === 'string'
      ? {
          final_shard_verdicts: {
            ...((state.final_shard_verdicts ?? {}) as Record<string, unknown>),
            [String((lease as Record<string, unknown>).verification_shard)]: eventId
          }
        }
      : {}),
    ...(creditAfter ? { credit_ledger: creditAfter } : {}),
    ...(packetCandidate
      ? {
          packet_candidates: {
            ...(state.packet_candidates as Record<string, unknown> | null | undefined),
            [String(packetCandidate.packet_id)]: packetCandidate
          }
        }
      : {}),
    revision
  }
  if (
    type === 'self_check' &&
    (payload as Record<string, unknown>).handoff_status === 'READY_FOR_ARCHITECT'
  ) {
    // Validate the exact proposed signed event/state before revoking the lease.
    // A rejected handoff leaves the Operator authorized to complete its work.
    assertOperatorHandoff(sdd, nextState, [...events, JSON.parse(event)], coordinatorToken)
  }
  const security = roleTransactionSecurity(state, lease as Record<string, unknown>, credential)
  commitSidecar(paths, Buffer.from(JSON.stringify(nextState)), Buffer.from(event), security, {
    state: stateBytes
  })
  return { protocol: 'agent-record/v1', eventId }
}
