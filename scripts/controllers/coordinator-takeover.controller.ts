import { leaseSlots } from '../helpers/lease-slots'
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

/** Rotate Coordinator authority atomically while preserving the product state. */
export function coordinatorTakeover(
  sdd: string,
  expectedState: string,
  expectedRevision: string,
  reason: string,
  authorized: string,
  stopped: string,
  nextId: string,
  oldToken = process.env[COORDINATOR_TOKEN_ENV],
  newToken = process.env[NEW_COORDINATOR_TOKEN_ENV],
  runtimeReceipt?: unknown,
  capabilityFile?: string
): Readonly<{
  protocol: 'coordinator-takeover/v1'
  eventId: string
  authorityEpoch: number
  coordinatorAgentId: string
}> {
  if (authorized !== 'yes') throw new Error('COORDINATOR_TAKEOVER_REQUIRES_USER_AUTHORIZATION')
  if (stopped !== 'yes') throw new Error('COORDINATOR_TAKEOVER_REQUIRES_STOP_CONFIRMATION')
  if (!reason.trim() || !isRuntimeIdentity(nextId))
    throw new Error('COORDINATOR_TAKEOVER_METADATA_INVALID')
  // Reject a wrong spawn before generating authority or rotating the epoch.
  if (runtimeReceipt === undefined) throw new Error('COORDINATOR_RUNTIME_RECEIPT_REQUIRED')
  const runtime = coordinatorRuntimeReceipt(runtimeReceipt, nextId)
  const tokens = capabilityPair(oldToken, newToken, 'COORDINATOR_TAKEOVER_REQUIRES_NEW_CAPABILITY')
  const snapshot = readAuthoritySnapshot(sdd)
  const { state } = snapshot
  assertExpected(state, expectedState, expectedRevision)
  if (state.coordinator_token_hash !== tokens.oldHash) throw new Error('COORDINATOR_AUTH_INVALID')
  if (leaseSlots(state).length || state.preparation != null)
    throw new Error('COORDINATOR_TAKEOVER_REQUIRES_INACTIVE_NONTERMINAL')
  if (['SHIP', 'CANCELLED', 'BLOCKED'].includes(expectedState))
    throw new Error('COORDINATOR_TAKEOVER_REQUIRES_INACTIVE_NONTERMINAL')
  assertRotationCounters(state)
  const epoch = Number(state.authority_epoch) + 1
  const eventId = `EVT-${randomUUID()}`
  const body = correlateEvent({
    event_id: eventId,
    role: 'coordinator',
    type: 'coordinator_takeover',
    payload: {
      from_coordinator_agent_id: state.coordinator_agent_id ?? null,
      to_coordinator_agent_id: nextId,
      from_authority_epoch: state.authority_epoch ?? 0,
      to_authority_epoch: epoch,
      reason,
      all_previous_writers_stopped: true,
      coordinator_runtime: runtime
    }
  })
  commitAuthorityChange(
    snapshot,
    rotatedAuthorityState(state, tokens.newToken, {
      initial: false,
      runtime,
      ...(capabilityFile ? { capabilityFile } : {}),
      extra: { active_lease: null, preparation: null }
    }),
    body,
    tokens.newToken,
    // The old authority approves these exact after-images; its public key survives rotation.
    coordinatorTransactionSecurity(state, tokens.oldToken),
    // An authorized takeover may adopt an interrupted commit's extra tail, never altered history.
    true
  )
  return {
    protocol: 'coordinator-takeover/v1',
    eventId,
    authorityEpoch: epoch,
    coordinatorAgentId: nextId
  }
}
