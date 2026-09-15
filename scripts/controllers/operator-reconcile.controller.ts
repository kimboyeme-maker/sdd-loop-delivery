import { assertMutablePhase } from '../domain/policies/phase'
import { canonicalJson } from '../resource/wire/canonical-json'
import { leaseWorktreeFingerprint } from '../helpers/worktree-candidate'
import { nextControlRevision } from '../domain/policies/control-revision'
import { correlateEvent } from '../context/command-context'
import { isDeepStrictEqual } from 'node:util'
import { assertOperatorHandoff } from '../services/operator-handoff'
import { assertActiveLease } from '../domain/policies/active-lease'
import { assertCurrentSource } from '../helpers/source-binding'
import { hasPriorNoProgress } from '../helpers/dispatch-metadata'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  COORDINATOR_TOKEN_ENV,
  assertCoordinatorToken,
  assertExpected,
  commitControl,
  loadControl,
  signCoordinatorEvent
} from '../services/control-kernel'

type Item = Record<string, unknown>
const TOKEN_ENV = COORDINATOR_TOKEN_ENV
/** Phases in which an Operator runtime can be observed; later phases have no Operator writer. */
const OPERATOR_PHASES = [
  'OPERATOR_READBACK',
  'READBACK_APPROVED',
  'IMPLEMENTING',
  'OPERATOR_SELF_CHECK'
]
/** Worktree marker for a lease without a frozen baseline; never a fabricated hash. */
const UNBOUND = 'UNBOUND'
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined

/** Validate the Coordinator's observation of the real host return before any state lookup. */
function parseObservation(value: unknown): Item {
  const input = object(value)
  if (
    !input ||
    !['continue', 'replace', 'handoff'].includes(String(input.disposition)) ||
    !['observation_id', 'worktree_fingerprint', 'next_action', 'reason'].every((key) =>
      text(input[key])
    ) ||
    !Array.isArray(input.unfinished) ||
    !input.unfinished.every(text) ||
    (input.no_progress !== undefined && typeof input.no_progress !== 'boolean')
  )
    throw new Error('OPERATOR_OBSERVATION_INVALID')
  const host = object(input.host)
  if (
    !host ||
    !['healthy', 'stopped', 'lost', 'interrupted'].includes(String(host.runtime_status)) ||
    typeof host.writer_stopped !== 'boolean' ||
    typeof host.commands_stopped !== 'boolean' ||
    !text(host.evidence)
  )
    throw new Error('OPERATOR_HOST_OBSERVATION_INVALID')
  canonicalJson(input)
  return input
}

/** Repeated unsupported returns and replacements need a concrete diagnosis, not another prompt. */
function assertDiagnosis(value: unknown, code: string): void {
  const diagnosis = object(value)
  if (
    !diagnosis ||
    !['dispatch_prompt', 'last_tool_result', 'host_state', 'diff_review'].every((key) =>
      text(diagnosis[key])
    )
  )
    throw new Error(code)
}

/**
 * Record a Coordinator's host observation and apply one bounded lease disposition.
 * continue keeps the lease; replace revokes it and records what the successor must read
 * back; handoff consumes existing READY evidence. None writes Operator evidence.
 */
export function operatorReconcile(
  sdd: string,
  expectedState: string,
  expectedRevision: string,
  leaseId: string,
  agentId: string,
  observation: unknown,
  token = process.env[TOKEN_ENV]
): Readonly<{ protocol: 'operator-reconcile/v1'; eventId: string; disposition: string }> {
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  const input = parseObservation(observation)
  const disposition = String(input.disposition)
  // Authenticate first: an idempotent replay returns before phase and expectation checks.
  const control = loadControl(sdd)
  const { state } = control
  assertCoordinatorToken(state, token)
  if (existsSync(control.paths.journal)) throw new Error('CONTROL_TRANSACTION_PENDING')
  if (input.authority_epoch !== undefined && input.authority_epoch !== state.authority_epoch)
    throw new Error('OPERATOR_OBSERVATION_EPOCH_MISMATCH')
  const events = control.events()
  const payload = {
    ...input,
    lease_id: leaseId,
    agent_id: agentId,
    authority_epoch: state.authority_epoch
  }
  // Same observation ID and payload is idempotent; changed data needs a new ID.
  const prior = events.filter(
    (event) =>
      event.type === 'operator_reconcile' &&
      object(event.payload)?.observation_id === input.observation_id
  )
  if (prior.length) {
    const { signature, ...body } = prior[0]!
    if (
      prior.length > 1 ||
      prior[0]!.role !== 'coordinator' ||
      signature !== createHmac('sha256', token).update(JSON.stringify(body)).digest('hex') ||
      !isDeepStrictEqual(prior[0]!.payload, JSON.parse(JSON.stringify(payload)))
    )
      throw new Error('OPERATOR_OBSERVATION_ID_CONFLICT')
    return { protocol: 'operator-reconcile/v1', eventId: String(prior[0]!.event_id), disposition }
  }
  assertMutablePhase(state.phase)
  assertExpected(state, expectedState, expectedRevision)
  if (!OPERATOR_PHASES.includes(String(state.phase)))
    throw new Error('OPERATOR_RECONCILE_STATE_INVALID')
  const lease = object(object(state.issued_leases)?.[leaseId])
  if (
    !lease ||
    lease.role !== 'operator' ||
    lease.agent_id !== agentId ||
    lease.authority_epoch !== state.authority_epoch ||
    lease.contract_revision !== state.contract_revision ||
    lease.repair_probe_root
  )
    throw new Error('OPERATOR_RECONCILE_LEASE_MISMATCH')
  const active = object(state.active_lease)
  if (active && active.lease_id !== leaseId)
    throw new Error('OPERATOR_RECONCILE_OTHER_WRITER_ACTIVE')
  if (disposition !== 'handoff' && !active)
    throw new Error('OPERATOR_RECONCILE_ACTIVE_LEASE_REQUIRED')
  const current = leaseWorktreeFingerprint(sdd, lease)
  if (input.worktree_fingerprint !== (current ?? UNBOUND))
    throw new Error('OPERATOR_OBSERVATION_WORKTREE_STALE')
  const host = object(input.host)!
  const unfinished = input.unfinished as string[]
  const noProgress = input.no_progress === true
  const repeated = hasPriorNoProgress(
    state,
    events,
    typeof lease.packet_id === 'string' ? lease.packet_id : undefined,
    String(lease.work_item)
  )
  if (noProgress && repeated)
    assertDiagnosis(input.diagnosis, 'OPERATOR_REPEATED_NO_PROGRESS_DIAGNOSIS_REQUIRED')
  const nextState: Item = { ...state, revision: nextControlRevision(state.revision) }
  if (disposition === 'continue') {
    // Normative source drift already fails here; it needs amendment, not a refreshed prompt.
    assertCurrentSource(state, sdd)
    assertActiveLease(state, active!)
    if (host.runtime_status !== 'healthy' || !unfinished.length)
      throw new Error('OPERATOR_CONTINUE_REQUIRES_HEALTHY_UNFINISHED_RUNTIME')
  } else if (disposition === 'replace') {
    if (host.writer_stopped !== true || host.commands_stopped !== true)
      throw new Error('OPERATOR_REPLACE_WRITER_STOP_REQUIRED')
    if (noProgress || repeated)
      assertDiagnosis(input.diagnosis, 'OPERATOR_REPLACE_DIAGNOSIS_REQUIRED')
    nextState.active_lease = null
    // Preserve-and-inspect obligation for the successor's recovery readback.
    nextState.operator_recovery = {
      lease_id: leaseId,
      agent_id: agentId,
      worktree_fingerprint: input.worktree_fingerprint,
      unfinished,
      next_action: input.next_action,
      checkpoint_id: object(state.last_role_events)?.checkpoint ?? null
    }
  } else {
    if (unfinished.length) throw new Error('OPERATOR_HANDOFF_DIRECT_READY_EVIDENCE_REQUIRED')
    const check = assertOperatorHandoff(sdd, state, events, token)
    if (object(check.actor)?.lease_id !== leaseId) throw new Error('HANDOFF_SELF_CHECK_REQUIRED')
  }
  nextState.last_operator_reconcile = {
    observation_id: input.observation_id,
    lease_id: leaseId,
    agent_id: agentId,
    disposition,
    unfinished,
    next_action: input.next_action
  }
  const eventId = `EVT-${randomUUID()}`
  const body = correlateEvent({
    event_id: eventId,
    role: 'coordinator',
    type: 'operator_reconcile',
    authority_epoch: state.authority_epoch,
    contract_revision: state.contract_revision,
    payload
  })
  commitControl(control, nextState, signCoordinatorEvent(state, body, token), token)
  return { protocol: 'operator-reconcile/v1', eventId, disposition }
}
