import { eventsWithId } from '../utils/event-index'
import { createHmac } from 'node:crypto'
import { DESIGN_REVIEW_DIMENSIONS } from '../config/constants'
import { assertDesignProposal } from '../domain/policies/design-proposal'
import { assertRoleEvidence } from './role-evidence'
import { isNonEmptyTextList } from '../utils/text'
type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/** Bind Coordinator review to a current, directly signed Architect proposal.
 * Convergence chooses a proposed route; it does not amend the SDD or grant user authority.
 */
export function assertDesignResolution(
  state: Item,
  payload: Item,
  events: readonly Item[],
  token: string
): void {
  if (
    !text(payload.proposal_event_id) ||
    !['CHALLENGE', 'CONVERGED'].includes(String(payload.decision)) ||
    !isNonEmptyTextList(payload.evidence)
  )
    throw new Error('DESIGN_RESOLUTION_INVALID')
  const matches = eventsWithId(events, payload.proposal_event_id),
    proposal = matches[0]
  if (
    matches.length !== 1 ||
    !proposal ||
    proposal.type !== 'design_proposal' ||
    proposal.contract_revision !== state.contract_revision ||
    proposal.sdd_fingerprint !== state.sdd_fingerprint ||
    object(proposal.actor)?.authority_epoch !== state.authority_epoch
  )
    throw new Error('DESIGN_RESOLUTION_PROPOSAL_INVALID')
  assertRoleEvidence(state, proposal, 'architect')
  const data = object(proposal.payload)
  if (!data) throw new Error('DESIGN_RESOLUTION_PROPOSAL_INVALID')
  assertDesignProposal(data)
  if (
    events
      .slice(events.indexOf(proposal) + 1)
      .some((event) =>
        [
          'design_proposal',
          'contract_amendment',
          'amend',
          'coordinator_takeover',
          'timeout_decision'
        ].includes(String(event.type))
      )
  )
    throw new Error('DESIGN_RESOLUTION_PROPOSAL_STALE')
  const review = payload.review_coverage
  if (!Array.isArray(review) || review.length !== DESIGN_REVIEW_DIMENSIONS.length)
    throw new Error('DESIGN_REVIEW_COVERAGE_INCOMPLETE')
  const dimensions = new Set<string>()
  let failed = false
  for (const value of review) {
    const item = object(value)
    if (
      !item ||
      !DESIGN_REVIEW_DIMENSIONS.includes(
        item.dimension as (typeof DESIGN_REVIEW_DIMENSIONS)[number]
      ) ||
      dimensions.has(String(item.dimension)) ||
      !['PASS', 'FAIL'].includes(String(item.result)) ||
      !isNonEmptyTextList(item.evidence)
    )
      throw new Error('DESIGN_REVIEW_COVERAGE_INVALID')
    dimensions.add(String(item.dimension))
    failed ||= item.result === 'FAIL'
  }
  if (payload.decision === 'CHALLENGE') {
    if (
      !failed ||
      !['counterexamples', 'required_revisions', 'challenged_claim_ids'].every((key) =>
        isNonEmptyTextList(payload[key])
      )
    )
      throw new Error('DESIGN_CHALLENGE_NOT_ADVERSARIAL')
    const ids = payload.challenged_claim_ids as string[],
      claims = data.claims as Item[]
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !claims.some((claim) => claim.id === id))
    )
      throw new Error('DESIGN_CHALLENGE_CLAIM_REFERENCE_INVALID')
    return
  }
  if (failed) throw new Error('DESIGN_CONVERGENCE_REVIEW_NOT_CLEAN')
  if (
    !text(payload.selected_route_id) ||
    !isNonEmptyTextList(payload.rejected_failure_modes) ||
    !isNonEmptyTextList(payload.falsifier_evidence) ||
    !Array.isArray(payload.unknowns) ||
    payload.unknowns.length
  )
    throw new Error('DESIGN_CONVERGENCE_INCOMPLETE')
  if (!(data.route_options as Item[]).some((route) => route.id === payload.selected_route_id))
    throw new Error('DESIGN_RESOLUTION_ROUTE_NOT_PROPOSED')
  if ((data.unknowns as unknown[]).length) throw new Error('DESIGN_RESOLUTION_UNKNOWNS_REMAIN')
  if (payload.authority_classification !== data.authority_classification)
    throw new Error('DESIGN_RESOLUTION_AUTHORITY_MISMATCH')
  const authenticDecision = (event: Item) => {
    const { signature, ...body } = event
    return (
      event.role === 'coordinator' &&
      event.type === 'design_resolution' &&
      event.authority_epoch === state.authority_epoch &&
      event.contract_revision === state.contract_revision &&
      event.sdd_fingerprint === state.sdd_fingerprint &&
      signature === createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
    )
  }
  // Objections belong to the current contract, not the runtime that proposed it.
  // Replacing an Architect must preserve the same closure obligation.
  const pending = events.filter((event, index) => {
    const review = object(event.payload)
    if (review?.decision !== 'CHALLENGE' || !authenticDecision(event)) return false
    const targets = eventsWithId(events, review.proposal_event_id)
    if (targets.length !== 1) throw new Error('DESIGN_CHALLENGE_RESOLUTION_INVALID')
    assertRoleEvidence(state, targets[0]!, 'architect')
    if (!isNonEmptyTextList(review.required_revisions))
      throw new Error('DESIGN_CHALLENGE_RESOLUTION_INVALID')
    return !events.slice(index + 1).some(
      (later) =>
        authenticDecision(later) &&
        object(later.payload)?.decision === 'CONVERGED' &&
        (() => {
          const anchors = events.filter(
            (entry) => entry.event_id === object(later.payload)?.resolved_challenge_event_id
          )
          const anchor = anchors[0]
          return (
            anchors.length === 1 &&
            !!anchor &&
            authenticDecision(anchor) &&
            object(anchor.payload)?.decision === 'CHALLENGE' &&
            events.indexOf(anchor) >= index &&
            events.indexOf(anchor) < events.indexOf(later)
          )
        })() &&
        (review.required_revisions as string[]).every((required) => {
          const responses = object(later.payload)?.challenge_resolutions
          return (
            Array.isArray(responses) &&
            responses.some((value) => {
              const response = object(value)
              return (
                response?.required_revision === required &&
                ['RESOLVED', 'REJECTED_WITH_EVIDENCE'].includes(String(response.disposition)) &&
                isNonEmptyTextList(response.evidence)
              )
            })
          )
        })
    )
  })
  const latestChallenge = pending.at(-1)
  if (latestChallenge && payload.resolved_challenge_event_id !== latestChallenge.event_id)
    throw new Error('DESIGN_CHALLENGE_RESOLUTION_REQUIRED')
  const resolutions = payload.challenge_resolutions ?? []
  if (!Array.isArray(resolutions)) throw new Error('DESIGN_CHALLENGE_RESOLUTION_INVALID')
  if (payload.resolved_challenge_event_id == null) {
    if (resolutions.length) throw new Error('DESIGN_CONVERGENCE_INCOMPLETE')
    return
  }
  const challenges = eventsWithId(events, payload.resolved_challenge_event_id),
    challenge = challenges[0]
  if (!text(payload.resolved_challenge_event_id) || challenges.length !== 1 || !challenge)
    throw new Error('DESIGN_CHALLENGE_RESOLUTION_INVALID')
  const { signature, ...body } = challenge,
    prior = object(challenge.payload)
  if (
    challenge.type !== 'design_resolution' ||
    challenge.role !== 'coordinator' ||
    prior?.decision !== 'CHALLENGE' ||
    challenge.contract_revision !== state.contract_revision ||
    challenge.sdd_fingerprint !== state.sdd_fingerprint ||
    challenge.authority_epoch !== state.authority_epoch ||
    signature !== createHmac('sha256', token).update(JSON.stringify(body)).digest('hex') ||
    !isNonEmptyTextList(prior.required_revisions)
  )
    throw new Error('DESIGN_CHALLENGE_RESOLUTION_INVALID')
  const challengedProposals = eventsWithId(events, prior.proposal_event_id)
  if (challengedProposals.length !== 1 || events.indexOf(challenge) >= events.indexOf(proposal))
    throw new Error('DESIGN_CHALLENGE_RESOLUTION_PROPOSAL_MISMATCH')
  const covered = new Set<string>()
  for (const value of resolutions) {
    const item = object(value)
    if (
      !item ||
      !text(item.required_revision) ||
      covered.has(item.required_revision) ||
      !['RESOLVED', 'REJECTED_WITH_EVIDENCE'].includes(String(item.disposition)) ||
      !isNonEmptyTextList(item.evidence)
    )
      throw new Error('DESIGN_CHALLENGE_RESOLUTION_INVALID')
    covered.add(item.required_revision)
  }
  // The latest reference anchors the review; coverage includes every still-open objection.
  const required = new Set<string>(prior.required_revisions)
  for (const event of pending) {
    const review = object(event.payload)!
    for (const revision of review.required_revisions as string[]) required.add(revision)
  }
  if (covered.size !== required.size || [...required].some((value) => !covered.has(value)))
    throw new Error('DESIGN_CHALLENGE_RESOLUTION_INCOMPLETE')
}
