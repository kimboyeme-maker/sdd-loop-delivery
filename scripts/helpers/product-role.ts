import { eventsWithId } from '../utils/event-index'
import { assertProductRoleHistory as assertHistory } from '../domain/policies/role-history'
import { verifyCoordinatorProof } from '../resource/coordinator-evidence'
type Item = Record<string, unknown>

/** Check durable role exclusions and authenticate the latest host observation.
 * Never fall back to an older healthy receipt when the latest receipt is invalid.
 * Absence of observations does not manufacture host proof for a newly created role.
 */
export function assertProductRoleHistory(
  state: Item,
  events: readonly Item[],
  agentId: string,
  role: 'operator' | 'architect'
): void {
  assertHistory(state, events, agentId, role)
  const latest = events.findLast((event) => {
    const payload = event.payload as Item | undefined
    return (
      event.type === 'runtime_record' &&
      payload?.agent_id === agentId &&
      payload.action === 'observe'
    )
  })
  if (!latest) return
  const host = (latest.payload as Item).host as Item | undefined
  if (
    eventsWithId(events, latest.event_id).length !== 1 ||
    !verifyCoordinatorProof(state, latest) ||
    host?.controllable !== true
  )
    throw Error('RUNTIME_HOST_OBSERVATION_INVALID')
}
