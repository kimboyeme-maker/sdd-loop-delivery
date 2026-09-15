import { eventsWithId } from '../utils/event-index'
import { leaseSlots } from '../helpers/lease-slots'
import { nextControlRevision } from '../domain/policies/control-revision'
import { correlateEvent } from '../context/command-context'
import { assertVerificationReviewer } from '../helpers/verification-reviewer'
import { randomUUID } from 'node:crypto'
import {
  COORDINATOR_TOKEN_ENV,
  commitControl,
  openCoordinatorCommand,
  signCoordinatorEvent
} from '../services/control-kernel'

const TOKEN_ENV = COORDINATOR_TOKEN_ENV

/** Record one bounded Coordinator attempt without changing product evidence. */
export function attempt(
  sdd: string,
  role: string,
  expectedState: string,
  expectedRevision: string,
  progress: string,
  token = process.env[TOKEN_ENV]
): Readonly<{ protocol: 'attempt/v1'; eventId: string; attempt: number }> {
  if (role !== 'coordinator') throw new Error('ROLE_ATTEMPT_FORBIDDEN')
  if (progress !== 'progress' && progress !== 'stagnant')
    throw new Error('ATTEMPT_PROGRESS_INVALID')
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  const control = openCoordinatorCommand(sdd, token, expectedState, expectedRevision)
  const { state } = control
  const current = String(state.phase ?? '')
  if (leaseSlots(state as Record<string, unknown>).length > 0)
    throw new Error('ATTEMPT_ACTIVE_LEASE')
  if (current !== 'COORDINATOR_TRIAGE') throw new Error('ATTEMPT_REQUIRES_COORDINATOR_TRIAGE')
  // Defaults apply only to absent optional fields, never corrupted persisted values.
  const counter = (value: unknown, fallback: number): number => {
    const count = value === undefined ? fallback : value
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      throw new Error('ATTEMPT_COUNTER_INVALID')
    return count
  }
  // The product contract allows six attempts per round. max_rounds controls
  // opening another logical round, not the number of attempts in this one.
  const max = 6
  // Round allocation is separate from this attempt limit, but corrupt persisted
  // allocation must not survive a successful accounting mutation.
  if (counter(state.max_rounds, 6) < 1) throw new Error('ATTEMPT_COUNTER_INVALID')
  const completed = counter(state.round_completed_attempts, 0)
  const total = counter(state.completed_attempts, 0)
  const stagnant = counter(state.consecutive_stagnant_attempts, 0)
  if (completed >= max) throw new Error('ATTEMPT_BUDGET_EXHAUSTED')
  if (
    total === Number.MAX_SAFE_INTEGER ||
    (progress === 'stagnant' && stagnant === Number.MAX_SAFE_INTEGER)
  )
    throw new Error('ATTEMPT_COUNTER_INVALID')
  const events = control.events()
  const lastRoleEvents = state.last_role_events as Record<string, unknown> | undefined
  const reference = lastRoleEvents?.verification
  const matches = eventsWithId(events, reference)
  const verification = matches[0]
  if (reference != null) {
    if (
      matches.length !== 1 ||
      !verification ||
      verification.type !== 'verification' ||
      verification.contract_revision !== state.contract_revision
    )
      throw Error('ATTEMPT_VERIFICATION_REFERENCE_INVALID')
    // Counter resets must consume authentic reviewer evidence, never a matching ID alone.
    assertVerificationReviewer(state, events, verification)
  }
  const result =
    verification?.role === 'architect'
      ? (verification.payload as Record<string, unknown> | undefined)?.result
      : undefined
  if (result === 'INCONCLUSIVE_ENVIRONMENT')
    throw new Error('ENVIRONMENT_INCONCLUSIVE_IS_PIPELINE_INCIDENT: use pipeline-failure')
  let rejections = counter(state.consecutive_architect_rejections, 0)
  if (['FAIL', 'NOT_RUN', 'INCONCLUSIVE'].includes(String(result))) {
    if (rejections === Number.MAX_SAFE_INTEGER) throw new Error('ATTEMPT_COUNTER_INVALID')
    rejections++
  } else if (result === 'PASS') rejections = 0
  const nextAttempt = completed + 1
  const nextState = {
    ...state,
    updated_at: new Date().toISOString(),
    completed_attempts: total + 1,
    consecutive_execution_failures: 0,
    last_execution_failure_root: null,
    consecutive_architect_rejections: rejections,
    round_completed_attempts: nextAttempt,
    consecutive_stagnant_attempts: progress === 'stagnant' ? stagnant + 1 : 0,
    revision: nextControlRevision(state.revision)
  }
  const eventId = `EVT-${randomUUID()}`
  const body = correlateEvent({
    event_id: eventId,
    state: state.phase,
    authority_epoch: state.authority_epoch,
    contract_revision: state.contract_revision,
    role: 'coordinator',
    type: 'finding_decision',
    payload: {
      action: 'attempt_completed',
      attempt: nextAttempt,
      total_attempts: total + 1,
      progress,
      architect_result: result ?? 'UNRECORDED',
      consecutive_architect_rejections: rejections,
      consecutive_stagnant_attempts: nextState.consecutive_stagnant_attempts,
      state_after: current
    }
  })
  commitControl(control, nextState, signCoordinatorEvent(state, body, token), token)
  return { protocol: 'attempt/v1', eventId, attempt: nextAttempt }
}
