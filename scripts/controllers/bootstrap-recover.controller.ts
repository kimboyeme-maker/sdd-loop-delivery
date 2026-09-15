import { parseEvents } from '../resource/store/event-log'
import { coordinatorTransactionSecurity } from '../resource/coordinator-evidence'
import { isRuntimeIdentity } from '../helpers/runtime-identity'
import { coordinatorRuntimeReceipt } from '../helpers/coordinator-runtime'
import { correlateEvent } from '../context/command-context'
import { randomUUID } from 'node:crypto'
import { COORDINATOR_TOKEN_ENV, assertExpected } from '../services/control-kernel'
import {
  NEW_COORDINATOR_TOKEN_ENV,
  assertRotationCounters,
  capabilityPair,
  commitAuthorityChange,
  readAuthoritySnapshot,
  rotatedAuthorityState
} from '../services/authority-rotation'

/** Event types that prove delivery work began; recovery is only safe before any of them. */
const DELIVERY_EVENT_TYPES = [
  'dispatch',
  'implementation',
  'verification',
  'finding',
  'requirement_status',
  'finding_status',
  'timeout_decision'
]

/** Recover Coordinator capability only before any delivery work has started. */
export function bootstrapRecover(
  sdd: string,
  expectedState: string,
  expectedRevision: string,
  reason: string,
  stopped: string,
  nextId: string,
  oldToken = process.env[COORDINATOR_TOKEN_ENV],
  newToken = process.env[NEW_COORDINATOR_TOKEN_ENV],
  runtimeReceipt?: unknown,
  capabilityFile?: string
): Readonly<{ protocol: 'bootstrap-recover/v1'; eventId: string; authorityEpoch: number }> {
  if (stopped !== 'yes') throw new Error('BOOTSTRAP_RECOVERY_REQUIRES_STOP_CONFIRMATION')
  if (!reason.trim() || !isRuntimeIdentity(nextId))
    throw new Error('BOOTSTRAP_RECOVERY_METADATA_INVALID')
  if (runtimeReceipt === undefined) throw new Error('COORDINATOR_RUNTIME_RECEIPT_REQUIRED')
  const runtime = coordinatorRuntimeReceipt(runtimeReceipt, nextId)
  const tokens = capabilityPair(oldToken, newToken, 'BOOTSTRAP_RECOVERY_REQUIRES_NEW_CAPABILITY')
  const snapshot = readAuthoritySnapshot(sdd)
  const { state } = snapshot
  assertExpected(state, expectedState, expectedRevision)
  if (state.coordinator_token_hash !== tokens.oldHash) throw new Error('COORDINATOR_AUTH_INVALID')
  // Absence is valid for optional ledgers; malformed values are not proof of no work.
  const emptyMap = (key: string) =>
    state[key] === undefined ||
    (state[key] !== null &&
      typeof state[key] === 'object' &&
      !Array.isArray(state[key]) &&
      Object.keys(state[key] as object).length === 0)
  const deliveryHistory = parseEvents(snapshot.eventBytes).some(
    (event) =>
      !event ||
      typeof event !== 'object' ||
      Array.isArray(event) ||
      (event as Record<string, unknown>).role === 'operator' ||
      (event as Record<string, unknown>).role === 'architect' ||
      DELIVERY_EVENT_TYPES.includes(String((event as Record<string, unknown>).type))
  )
  if (
    state.phase !== 'DISCOVER' ||
    state.preparation != null ||
    state.active_lease != null ||
    !emptyMap('issued_leases') ||
    state.completed_attempts !== 0 ||
    state.total_execution_failures !== 0 ||
    (state.round_completed_attempts !== undefined && state.round_completed_attempts !== 0) ||
    !emptyMap('findings') ||
    !emptyMap('requirement_evidence') ||
    deliveryHistory
  )
    throw new Error('BOOTSTRAP_RECOVERY_NOT_SAFE')
  assertRotationCounters(state)
  const epoch = Number(state.authority_epoch) + 1
  const eventId = `EVT-${randomUUID()}`
  const body = correlateEvent({
    event_id: eventId,
    role: 'coordinator',
    type: 'recovery',
    payload: {
      action: 'bootstrap_coordinator_restart',
      from_coordinator_agent_id: state.coordinator_agent_id ?? null,
      to_coordinator_agent_id: nextId,
      from_authority_epoch: state.authority_epoch ?? 0,
      to_authority_epoch: epoch,
      reason,
      host_confirmed_previous_writers_stopped: true,
      coordinator_runtime: runtime
    }
  })
  commitAuthorityChange(
    snapshot,
    rotatedAuthorityState(state, tokens.newToken, {
      initial: false,
      runtime,
      ...(capabilityFile ? { capabilityFile } : {})
    }),
    body,
    tokens.newToken,
    // Recovery rotates like takeover: the approving authority authenticates the journal.
    coordinatorTransactionSecurity(state, tokens.oldToken)
  )
  return { protocol: 'bootstrap-recover/v1', eventId, authorityEpoch: epoch }
}
