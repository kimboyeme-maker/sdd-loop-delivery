import { assertRoleEvidence } from './role-evidence'
import { assertDesignIndependence } from './design-independence'
type Item = Record<string, unknown>

/** Apply the same reviewer provenance and design exclusions at every result consumer.
 * Consumers still check candidate, chronology, coverage and the original implementer's identity.
 */
export function assertVerificationReviewer(
  state: Item,
  events: readonly Item[],
  event: Item
): void {
  assertRoleEvidence(state, event, 'architect')
  const actor = event.actor as Item
  assertDesignIndependence(state, events, String(actor.agent_id), event.state === 'FINAL_VERIFY')
  const lease = (state.issued_leases as Record<string, Item>)[String(actor.lease_id)]!
  if (lease.verification_mode === 'design-counsel')
    throw new Error('DESIGN_COUNSEL_CANNOT_VERIFY_PRODUCT')
}
