import { createHmac } from 'node:crypto'
import { verifyCoordinatorProof } from '../resource/coordinator-evidence'
import { verifyRoleEvent } from '../resource/role-signature'
import { assertRoleEvidence } from '../helpers/role-evidence'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined

/** Events that start a new Coordinator authority; earlier history belongs to prior epochs. */
function isAuthorityStart(event: Item): boolean {
  const action = object(event.payload)?.action
  return (
    event.role === 'coordinator' &&
    ((event.type === 'user_decision' && action === 'coordinator_auth_bootstrap') ||
      event.type === 'coordinator_takeover' ||
      (event.type === 'recovery' && action === 'bootstrap_coordinator_restart'))
  )
}

/** One event is authentic when its own role's verification material accepts it. */
function authentic(state: Item, events: readonly Item[], event: Item, token?: string): boolean {
  if (event.role === 'coordinator') {
    if (event.coordinator_proof !== undefined) return verifyCoordinatorProof(state, event)
    const { signature, ...body } = event
    return (
      !!token &&
      signature === createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
    )
  }
  const actor = object(event.actor)
  if (typeof actor?.prepared_id === 'string') {
    // Preparation evidence is verified with the key from its Coordinator-signed grant.
    const grant = events.find(
      (item) =>
        item.type === 'preparation_grant' &&
        object(item.payload)?.prepared_id === actor.prepared_id &&
        authentic(state, events, item, token)
    )
    const key = object(grant?.payload)?.event_public_key
    return typeof key === 'string' && verifyRoleEvent(event, key)
  }
  try {
    assertRoleEvidence(state, event, String(event.role))
    return true
  } catch {
    return false
  }
}

/**
 * Authenticate every event written under the current Coordinator authority. Per-use checks
 * only verify the events a gate reads; an inserted unsigned event would otherwise shadow
 * the history those gates reason about. Coordinator HMAC events need the current token.
 */
export function currentEpochAuthentication(
  state: Item,
  events: readonly Item[],
  token?: string
): Readonly<{ status: string; checked: number; failed_event_id?: string }> {
  const start = events.findLastIndex(isAuthorityStart)
  if (start < 0) return { status: 'NO_COORDINATOR_AUTHORITY', checked: 0 }
  const segment = events.slice(start)
  for (const event of segment) {
    if (event.role === 'coordinator' && event.coordinator_proof === undefined && !token)
      return { status: 'COORDINATOR_TOKEN_REQUIRED', checked: 0 }
    if (!authentic(state, events, event, token))
      return {
        status: 'UNAUTHENTIC_EVENT',
        checked: 0,
        failed_event_id: String(event.event_id ?? 'unknown')
      }
  }
  return { status: 'AUTHENTIC_CURRENT_EPOCH', checked: segment.length }
}

/** Terminal acceptance requires the whole current-authority history to authenticate. */
export function assertAuthenticCurrentEpoch(
  state: Item,
  events: readonly Item[],
  token?: string
): void {
  const result = currentEpochAuthentication(state, events, token)
  if (result.status !== 'AUTHENTIC_CURRENT_EPOCH')
    throw new Error(
      `EVENT_AUTHENTICATION_FAILED: ${result.status} ${result.failed_event_id ?? ''}`.trim()
    )
}
