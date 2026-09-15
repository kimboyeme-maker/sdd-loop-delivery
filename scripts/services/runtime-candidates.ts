import { eventsWithId } from '../utils/event-index'
import { leaseSlots } from '../helpers/lease-slots'
import { assertProductRoleHistory } from '../helpers/product-role'
import { assertDesignIndependence } from '../helpers/design-independence'
import { verifyCoordinatorProof } from '../resource/coordinator-evidence'
type Item = Record<string, unknown>
const object = (value: unknown): Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {}

/** List historical role candidates without granting a lease or asserting live host control.
 * The latest authenticated observation is required; never revive an earlier healthy report.
 */
export function runtimeCandidates(state: Item, events: readonly Item[]): Item[] {
  const known = new Map<string, unknown>(Object.entries(object(state.agent_roles)))
  for (const lease of Object.values(object(state.issued_leases))) {
    const entry = object(lease)
    if (typeof entry.agent_id === 'string' && !known.has(entry.agent_id))
      known.set(entry.agent_id, entry.role)
  }
  for (const event of events) {
    const payload = object(event.payload)
    if (
      event.type === 'runtime_record' &&
      payload.action === 'observe' &&
      typeof payload.agent_id === 'string' &&
      !known.has(payload.agent_id)
    )
      known.set(payload.agent_id, payload.agent_role)
  }
  return [...known]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent_id, role]) => {
      const reasons: string[] = []
      try {
        if (role !== 'operator' && role !== 'architect') throw Error('RUNTIME_ROLE_UNRECORDED')
        assertProductRoleHistory(state, events, agent_id, role)
        if (role === 'architect') assertDesignIndependence(state, events, agent_id)
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : 'RUNTIME_HISTORY_INVALID')
      }
      const latest = events.findLast(
        (event) =>
          event.type === 'runtime_record' &&
          object(event.payload).agent_id === agent_id &&
          object(event.payload).action === 'observe'
      )
      const host = object(object(latest?.payload).host)
      if (
        !latest ||
        eventsWithId(events, latest.event_id).length !== 1 ||
        !verifyCoordinatorProof(state, latest)
      )
        reasons.push('RUNTIME_HOST_OBSERVATION_REQUIRED')
      if (host.controllable !== true) reasons.push('RUNTIME_CONTROL_UNCONFIRMED')
      const grants = [...leaseSlots(state), state.preparation]
        .map(object)
        .filter((grant) => grant.agent_id === agent_id)
      return {
        agent_id,
        role,
        eligible: reasons.length === 0,
        reasons,
        observation_id: latest?.event_id ?? null,
        host_status: host.status ?? 'unknown',
        active_grants: grants.map((grant) => ({
          lease_id: grant.lease_id ?? null,
          prepared_id: grant.prepared_id ?? null
        })),
        requires_dispatch: true,
        host_liveness_verified: false
      }
    })
}
