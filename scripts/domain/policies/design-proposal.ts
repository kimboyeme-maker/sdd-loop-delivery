import { DESIGN_REVIEW_DIMENSIONS, DESIGN_PRESERVATION_BOUNDARIES } from '../../config/constants'
import { isNonEmptyTextList, isTextList } from '../../utils/text'
type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/** Validate proposal content without adopting a route or granting implementation authority.
 * Evidence fields identify required review inputs; their semantic truth still needs review.
 */
export function assertDesignProposal(payload: Item): void {
  if (
    !['proposal_id', 'trigger', 'root_cause'].every((key) => text(payload[key])) ||
    !['BOUNDED', 'MATERIAL'].includes(String(payload.materiality)) ||
    ![
      'problem_evidence',
      'independent_checks',
      'current_route_counterexamples',
      'state_and_evidence_invariants',
      'packet_and_dependency_invariants',
      'falsifiers'
    ].every((key) => isNonEmptyTextList(payload[key])) ||
    !['COORDINATOR_OWNED', 'USER_AUTHORITY_REQUIRED'].includes(
      String(payload.authority_classification)
    ) ||
    !isTextList(payload.unknowns)
  )
    throw new Error('DESIGN_PROPOSAL_INVALID')
  const claims = payload.claims
  if (!Array.isArray(claims) || claims.length !== DESIGN_REVIEW_DIMENSIONS.length)
    throw new Error('DESIGN_PROPOSAL_CLAIMS_INCOMPLETE')
  const ids = new Set<string>(),
    dimensions = new Set<string>()
  for (const value of claims) {
    const claim = object(value)
    if (
      !claim ||
      !['id', 'statement', 'falsifier'].every((key) => text(claim[key])) ||
      !DESIGN_REVIEW_DIMENSIONS.includes(
        claim.dimension as (typeof DESIGN_REVIEW_DIMENSIONS)[number]
      ) ||
      !isNonEmptyTextList(claim.evidence) ||
      ids.has(String(claim.id)) ||
      dimensions.has(String(claim.dimension))
    )
      throw new Error('DESIGN_PROPOSAL_CLAIM_INVALID')
    ids.add(String(claim.id))
    dimensions.add(String(claim.dimension))
  }
  if (!Array.isArray(payload.route_options) || !payload.route_options.length)
    throw new Error('DESIGN_PROPOSAL_ROUTES_REQUIRED')
  const routes = new Set<string>()
  for (const value of payload.route_options) {
    const route = object(value)
    if (
      !route ||
      !['id', 'summary', 'evidence', 'tradeoffs'].every((key) => text(route[key])) ||
      routes.has(String(route.id))
    )
      throw new Error('DESIGN_PROPOSAL_ROUTE_INVALID')
    routes.add(String(route.id))
  }
  if (!routes.has(String(payload.recommended_route_id)))
    throw new Error('DESIGN_PROPOSAL_RECOMMENDATION_INVALID')
  const preservation = object(payload.contract_preservation)
  if (
    !preservation ||
    Object.keys(preservation).length !== DESIGN_PRESERVATION_BOUNDARIES.length ||
    !DESIGN_PRESERVATION_BOUNDARIES.every((key) => Object.hasOwn(preservation, key))
  )
    throw new Error('DESIGN_PROPOSAL_CONTRACT_PRESERVATION_INVALID')
  let change = false
  for (const value of Object.values(preservation)) {
    const boundary = object(value)
    if (
      !boundary ||
      !['PRESERVED', 'CHANGE_REQUIRES_USER'].includes(String(boundary.status)) ||
      !isNonEmptyTextList(boundary.evidence)
    )
      throw new Error('DESIGN_PROPOSAL_CONTRACT_PRESERVATION_INVALID')
    change ||= boundary.status === 'CHANGE_REQUIRES_USER'
  }
  if (
    payload.authority_classification !== (change ? 'USER_AUTHORITY_REQUIRED' : 'COORDINATOR_OWNED')
  )
    throw new Error('DESIGN_PROPOSAL_AUTHORITY_CLASSIFICATION_INVALID')
}
