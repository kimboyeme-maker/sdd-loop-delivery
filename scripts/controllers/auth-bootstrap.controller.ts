import { coordinatorRuntimeReceipt } from '../helpers/coordinator-runtime'
import { correlateEvent } from '../context/command-context'
import { assertCurrentSource } from '../helpers/source-binding'
import { randomUUID } from 'node:crypto'
import { COORDINATOR_TOKEN_ENV, assertExpected } from '../services/control-kernel'
import {
  assertRotationCounters,
  commitAuthorityChange,
  readAuthoritySnapshot,
  rotatedAuthorityState,
  tokenTransactionSecurity
} from '../services/authority-rotation'

/**
 * Establish authority on a native discovery state; this does not approve its design. Bootstrap never
 * repairs malformed counters or replaces an existing (even damaged) credential;
 * those cases need a distinct authenticated recovery decision.
 */
export function authBootstrap(
  sdd: string,
  expectedState: string,
  expectedRevision: string,
  authorized: string,
  token = process.env[COORDINATOR_TOKEN_ENV],
  coordinatorAgentId?: string,
  runtimeReceipt?: unknown,
  capabilityFile?: string
): Readonly<{ protocol: 'auth-bootstrap/v1'; eventId: string }> {
  if (authorized !== 'yes') throw new Error('AUTH_BOOTSTRAP_REQUIRES_USER_AUTHORIZATION')
  // Identity binding is optional at first authority, but never without the actual spawn receipt.
  if ((coordinatorAgentId === undefined) !== (runtimeReceipt === undefined))
    throw new Error('COORDINATOR_RUNTIME_RECEIPT_REQUIRED')
  const runtime =
    coordinatorAgentId === undefined
      ? undefined
      : coordinatorRuntimeReceipt(runtimeReceipt, coordinatorAgentId)
  if (!token) throw new Error('COORDINATOR_TOKEN_REQUIRED')
  const snapshot = readAuthoritySnapshot(sdd)
  const { state } = snapshot
  assertCurrentSource(state, sdd)
  if (Object.hasOwn(state, 'coordinator_token_hash'))
    throw new Error('COORDINATOR_AUTH_ALREADY_INITIALIZED')
  assertExpected(state, expectedState, expectedRevision)
  if (state.active_lease != null) throw new Error('AUTH_BOOTSTRAP_REQUIRES_NO_ACTIVE_LEASE')
  if (state.phase !== 'DISCOVER' || state.preparation != null)
    throw new Error('AUTH_BOOTSTRAP_REQUIRES_DISCOVERY')
  assertRotationCounters(state)
  const eventId = `EVT-${randomUUID()}`
  const body = correlateEvent({
    event_id: eventId,
    state: state.phase,
    contract_revision: state.contract_revision,
    authority_epoch: Number(state.authority_epoch) + 1,
    role: 'coordinator',
    type: 'user_decision',
    payload: {
      action: 'coordinator_auth_bootstrap',
      user_authorized: true,
      ...(runtime ? { coordinator_runtime: runtime } : {})
    }
  })
  commitAuthorityChange(
    snapshot,
    rotatedAuthorityState(state, token, {
      initial: true,
      ...(runtime ? { runtime } : {}),
      ...(capabilityFile ? { capabilityFile } : {})
    }),
    body,
    token,
    tokenTransactionSecurity(token)
  )
  return { protocol: 'auth-bootstrap/v1', eventId }
}
