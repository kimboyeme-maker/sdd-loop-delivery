import { eventsWithId } from '../utils/event-index'
import { assertDesignResolution } from './design-resolution'
import { createHmac } from 'node:crypto'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(text)
}

/**
 * Bind readmission's repair explanation to the pending failure and current packet
 * inventory. This prerequisite does not clear failure state: all admission gates
 * must succeed together before recovery may be committed.
 */
export function assertExecutionFailureReview(
  state: Record<string, unknown>,
  payload: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
  token: string
): void {
  const review = object(payload.execution_failure_review)
  // A supplied resolution is never decorative metadata. Validate it even on
  // initial admission or a non-design repair route, not only DESIGN_REPAIR.
  if (
    review?.route_change_kind === 'DESIGN_REPAIR' ||
    Object.hasOwn(payload, 'design_resolution_event_id')
  )
    assertDesignResolutionReference(state, payload, events, token)
  if (state.pending_execution_failure == null) return
  const pending = object(state.pending_execution_failure)
  if (
    !pending ||
    !text(pending.root_cause_key) ||
    !review ||
    review.root_cause_key !== pending.root_cause_key ||
    !texts(review.cause_evidence) ||
    !texts(review.execution_topology_findings) ||
    !texts(review.revised_execution_packet_ids) ||
    new Set(review.revised_execution_packet_ids).size !==
      review.revised_execution_packet_ids.length ||
    !text(review.route_change) ||
    !text(review.falsifier)
  )
    throw new Error('EXECUTION_FAILURE_REVIEW_REQUIRED_BEFORE_READMISSION')
  const packets = payload.execution_packets
  if (!Array.isArray(packets)) throw new Error('EXECUTION_FAILURE_REVIEW_PACKET_INVALID')
  const ids = packets.map((item) => object(item)?.id)
  if (
    ids.some((id) => !text(id)) ||
    new Set(ids).size !== ids.length ||
    review.revised_execution_packet_ids.some((id) => !ids.includes(id))
  )
    throw new Error('EXECUTION_FAILURE_REVIEW_PACKET_INVALID')
}

/** Verify the selected route's current, signed resolution before it can support admission. */
export function assertDesignResolutionReference(
  state: Record<string, unknown>,
  payload: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
  token: string
): void {
  const matches = eventsWithId(events, payload.design_resolution_event_id)
  const event = matches[0]
  if (!text(payload.design_resolution_event_id) || matches.length !== 1 || !event)
    throw new Error('DESIGN_RESOLUTION_REQUIRED_BEFORE_READMISSION')
  const { signature, ...body } = event
  const resolution = object(event.payload)
  if (
    event.role !== 'coordinator' ||
    event.type !== 'design_resolution' ||
    resolution?.decision !== 'CONVERGED' ||
    resolution.authority_classification !== 'COORDINATOR_OWNED' ||
    !Number.isSafeInteger(state.authority_epoch) ||
    Number(state.authority_epoch) < 1 ||
    event.authority_epoch !== state.authority_epoch ||
    !text(state.contract_revision) ||
    event.contract_revision !== state.contract_revision ||
    !text(state.sdd_fingerprint) ||
    event.sdd_fingerprint !== state.sdd_fingerprint ||
    !text(payload.selected_route_id) ||
    resolution.selected_route_id !== payload.selected_route_id ||
    signature !== createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
  )
    throw new Error('CONTRACT_ADMISSION_DESIGN_RESOLUTION_INVALID')
  const index = events.indexOf(event)
  if (
    events
      .slice(index + 1)
      .some((item) =>
        ['timeout_decision', 'contract_amendment', 'coordinator_takeover'].includes(
          String(item.type)
        )
      )
  )
    throw new Error('CONTRACT_ADMISSION_DESIGN_RESOLUTION_STALE')
  // Recheck the complete producer contract against the history that preceded its decision.
  assertDesignResolution(state, resolution, events.slice(0, index), token)
}
