import { eventsWithId } from '../utils/event-index'
import { createHmac } from 'node:crypto'
import { verifyCoordinatorProof } from '../resource/coordinator-evidence'
import { isNonEmptyTextList } from '../utils/text'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined

/** Authentic Coordinator design decision for the current contract, epoch and source. */
export function authenticDesignResolution(state: Item, event: Item, token?: string): boolean {
  if (
    event.role !== 'coordinator' ||
    event.type !== 'design_resolution' ||
    event.authority_epoch !== state.authority_epoch ||
    event.contract_revision !== state.contract_revision ||
    event.sdd_fingerprint !== state.sdd_fingerprint
  )
    return false
  if (event.coordinator_proof !== undefined) return verifyCoordinatorProof(state, event)
  const { signature, ...body } = event
  return (
    !!token && signature === createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
  )
}

/**
 * An ADMIT may retire older adopted designs only by naming them together with its new
 * authentic CONVERGED resolution and evidence of complete replacement. Renaming a design
 * or wanting a particular Architect is not supersession.
 */
export function assertDesignSupersession(
  state: Item,
  payload: Item,
  events: readonly Item[],
  token?: string
): void {
  const retired = payload.superseded_design_resolution_ids
  if (retired === undefined) {
    if (payload.design_supersession_evidence !== undefined)
      throw new Error('DESIGN_SUPERSESSION_INVALID')
    return
  }
  const replacement = eventsWithId(events, payload.design_resolution_event_id)[0]
  if (
    !isNonEmptyTextList(retired) ||
    new Set(retired).size !== retired.length ||
    retired.includes(String(payload.design_resolution_event_id)) ||
    !isNonEmptyTextList(payload.design_supersession_evidence) ||
    !replacement ||
    object(replacement.payload)?.decision !== 'CONVERGED' ||
    !authenticDesignResolution(state, replacement, token)
  )
    throw new Error('DESIGN_SUPERSESSION_INVALID')
  for (const id of retired) {
    const old = eventsWithId(events, id)
    if (
      old.length !== 1 ||
      old[0]!.role !== 'coordinator' ||
      old[0]!.type !== 'design_resolution' ||
      object(old[0]!.payload)?.decision !== 'CONVERGED'
    )
      throw new Error('DESIGN_SUPERSESSION_INVALID')
  }
}

/** Resolution IDs retired by an epoch-verifiable ADMIT; unverifiable history retires nothing. */
export function supersededDesignResolutions(
  state: Item,
  events: readonly Item[]
): ReadonlySet<string> {
  const retired = new Set<string>()
  for (const event of events) {
    const payload = object(event.payload)
    if (
      event.type !== 'contract_admission' ||
      event.role !== 'coordinator' ||
      payload?.decision !== 'ADMIT' ||
      !Array.isArray(payload.superseded_design_resolution_ids) ||
      event.coordinator_proof === undefined ||
      !verifyCoordinatorProof(state, event)
    )
      continue
    for (const id of payload.superseded_design_resolution_ids)
      if (typeof id === 'string') retired.add(id)
  }
  return retired
}

/**
 * A proposal submitted while a CHALLENGE is open must answer that exact challenge and
 * every required revision: correct the claim, or uphold it with inspectable evidence.
 * Metadata-only resubmission cannot pass; a proposal without an open challenge carries none.
 */
export function assertChallengeResponse(
  state: Item,
  events: readonly Item[],
  payload: Item,
  token?: string
): void {
  const decisions = events.filter((event) => authenticDesignResolution(state, event, token))
  const latest = decisions.at(-1)
  const open = object(latest?.payload)?.decision === 'CHALLENGE' ? latest : undefined
  if (!open) {
    if (
      payload.responds_to_design_resolution_event_id !== undefined ||
      payload.challenge_responses !== undefined
    )
      throw new Error('DESIGN_PROPOSAL_CHALLENGE_RESPONSE_UNEXPECTED')
    return
  }
  if (payload.responds_to_design_resolution_event_id !== open.event_id)
    throw new Error('DESIGN_PROPOSAL_MUST_ANSWER_LATEST_CHALLENGE')
  const required = (object(open.payload)?.required_revisions ?? []) as string[]
  const responses = payload.challenge_responses
  if (!Array.isArray(responses)) throw new Error('DESIGN_PROPOSAL_CHALLENGE_RESPONSE_REQUIRED')
  const answered = new Set<string>()
  for (const value of responses) {
    const response = object(value)
    if (
      !response ||
      typeof response.required_revision !== 'string' ||
      !required.includes(response.required_revision) ||
      answered.has(response.required_revision) ||
      !['CORRECTED', 'UPHELD_WITH_EVIDENCE'].includes(String(response.disposition)) ||
      !isNonEmptyTextList(response.evidence)
    )
      throw new Error('DESIGN_PROPOSAL_CHALLENGE_RESPONSE_INVALID')
    answered.add(response.required_revision)
  }
  if (answered.size !== new Set(required).size)
    throw new Error('DESIGN_PROPOSAL_CHALLENGE_RESPONSE_INCOMPLETE')
  // Answers stay anchored: a revision may correct a challenged claim but not rename it away.
  const challenged = object(open.payload)?.challenged_claim_ids
  const claims = Array.isArray(payload.claims) ? payload.claims.map(object) : []
  if (
    Array.isArray(challenged) &&
    challenged.some((id) => !claims.some((claim) => claim?.id === id))
  )
    throw new Error('DESIGN_PROPOSAL_CHALLENGED_CLAIM_MISSING')
}
