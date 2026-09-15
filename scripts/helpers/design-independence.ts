import { eventsWithId } from '../utils/event-index'
import { assertRoleEvidence } from './role-evidence'
import { supersededDesignResolutions } from './design-challenge'
type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined

/** Conservatively retain authors of converged material designs across authority epochs.
 * Historical Coordinator decisions are exclusionary only here: they never grant authority.
 * A lifecycle restart cannot erase a directly signed proposal's authorship.
 */
export function assertDesignIndependence(
  state: Item,
  events: readonly Item[],
  agentId: string,
  finalVerification = state.phase === 'FINAL_VERIFY'
): void {
  const retired = supersededDesignResolutions(state, events)
  for (const resolution of events) {
    const decision = object(resolution.payload)
    if (
      resolution.role !== 'coordinator' ||
      resolution.type !== 'design_resolution' ||
      decision?.decision !== 'CONVERGED' ||
      // A completely replaced design no longer anchors its author.
      retired.has(String(resolution.event_id))
    )
      continue
    const matches = eventsWithId(events, decision.proposal_event_id),
      proposal = matches[0]
    if (matches.length !== 1 || !proposal || proposal.type !== 'design_proposal')
      throw new Error('DESIGN_AUTHOR_HISTORY_UNVERIFIABLE')
    const data = object(proposal.payload)
    if (!data || !['MATERIAL', 'BOUNDED'].includes(String(data.materiality)))
      throw new Error('DESIGN_AUTHOR_HISTORY_UNVERIFIABLE')
    // Verify under the proposal's historical contract, not today's execution scope.
    if (typeof proposal.contract_revision !== 'string' || !proposal.contract_revision.trim())
      throw new Error('DESIGN_AUTHOR_HISTORY_UNVERIFIABLE')
    assertRoleEvidence(
      { ...state, contract_revision: proposal.contract_revision },
      proposal,
      'architect'
    )
    if (data.materiality === 'MATERIAL' && object(proposal.actor)?.agent_id === agentId)
      throw new Error('ARCHITECT_ADOPTED_MATERIAL_DESIGN_AUTHOR')
  }
  if (!finalVerification) return
  // An adopted replacement route makes its reviewer a design author for final acceptance.
  // Keep this exclusion across epochs; ordinary bounded verification remains eligible.
  for (const event of events) {
    const decision = object(event.payload)
    if (
      event.role !== 'coordinator' ||
      event.type !== 'coordinator_dependency_decision' ||
      decision?.replacement_route_adopted !== true
    )
      continue
    const matches = eventsWithId(events, decision.review_event_id)
    const review = matches[0]
    if (
      matches.length !== 1 ||
      !review ||
      review.type !== 'dependency_safety_review' ||
      typeof review.contract_revision !== 'string'
    )
      throw new Error('DEPENDENCY_ROUTE_AUTHOR_HISTORY_UNVERIFIABLE')
    assertRoleEvidence(
      { ...state, contract_revision: review.contract_revision },
      review,
      'architect'
    )
    if (object(review.actor)?.agent_id === agentId)
      throw new Error('DEPENDENCY_ROUTE_AUTHOR_REQUIRES_INDEPENDENT_FINAL_ARCHITECT')
  }
}
