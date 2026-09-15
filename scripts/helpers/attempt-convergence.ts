import { leaseSlots } from './lease-slots'
import { createHmac } from 'node:crypto'
import { assertExecutionPackets } from '../domain/policies/execution-packets'
type Item = Record<string, unknown>
const object = (value: unknown): Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {}
const texts = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === 'string' && item.trim())
const PHASES = ['COORDINATOR_TRIAGE', 'CONTRACT_DRAFT', 'CONTRACT_AMENDED']
const triggered = (value: Item) =>
  Number(value.consecutive_architect_rejections ?? 0) >= 3 ||
  Number(value.consecutive_stagnant_attempts ?? 0) >= 3

/** Validate the existing three-way diagnosis before recording a route correction. */
export function assertAttemptConvergencePayload(state: Item, payload: Item): void {
  if (!PHASES.includes(String(state.phase))) throw new Error('CONVERGENCE_REVIEW_STATE_INVALID')
  if (leaseSlots(state as Record<string, unknown>).length > 0)
    throw new Error('CONVERGENCE_REVIEW_REQUIRES_NO_ACTIVE_LEASE')
  if (!triggered(state)) throw new Error('CONVERGENCE_REVIEW_TRIGGER_NOT_REACHED')
  if (
    !['THREE_CONSECUTIVE_ARCHITECT_REJECTIONS', 'THREE_CONSECUTIVE_STAGNANT_ATTEMPTS'].includes(
      String(payload.trigger)
    )
  )
    throw new Error('CONVERGENCE_REVIEW_TRIGGER_INVALID')
  const assessments = object(payload.assessments)
  const fields = [
    'coordinator_review_granularity',
    'execution_plan_specificity',
    'operator_execution_quality'
  ]
  if (
    Object.keys(assessments).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(assessments, field))
  )
    throw new Error('CONVERGENCE_REVIEW_ASSESSMENTS_INVALID')
  for (const value of Object.values(assessments)) {
    const item = object(value)
    if (
      !['DEFICIENT', 'ADEQUATE', 'UNDETERMINED'].includes(String(item.result)) ||
      !texts(item.evidence)
    )
      throw new Error('CONVERGENCE_REVIEW_ASSESSMENT_INVALID')
  }
  if (!texts(payload.root_causes)) throw new Error('CONVERGENCE_REVIEW_ROOT_CAUSES_REQUIRED')
  const packets = Array.isArray(payload.revised_work_packets)
    ? payload.revised_work_packets.map(object)
    : []
  const ids = (field: string) => [
    ...new Set(
      packets.flatMap((packet) => (texts(packet[field]) ? (packet[field] as string[]) : []))
    )
  ]
  assertExecutionPackets(
    payload.revised_work_packets,
    ids('requirement_ids'),
    ids('acceptance_ids')
  )
  if (!['AMEND_ROUTE', 'BLOCKED_NEEDS_USER_DECISION'].includes(String(payload.next_action)))
    throw new Error('CONVERGENCE_REVIEW_NEXT_ACTION_INVALID')
}

/** Progress requires a review after the latest authenticated repeated-failure trigger.
 * Use ledger order, not timestamps; changing runtime IDs cannot reset the trigger.
 */
export function requireAttemptConvergence(
  state: Item,
  events: readonly Item[],
  token: string
): void {
  if (!triggered(state)) return
  const authenticated = (event: Item): boolean => {
    const { signature, ...body } = event
    return (
      event.role === 'coordinator' &&
      event.authority_epoch === state.authority_epoch &&
      signature === createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
    )
  }
  const index = events.findLastIndex(
    (event) =>
      event.type === 'finding_decision' &&
      object(event.payload).action === 'attempt_completed' &&
      triggered(object(event.payload)) &&
      authenticated(event)
  )
  if (index < 0) throw new Error('CONVERGENCE_TRIGGER_EVIDENCE_MISSING')
  const trigger = events[index]!,
    payload = object(trigger.payload)
  const kinds = [
    ...(Number(payload.consecutive_architect_rejections ?? 0) >= 3
      ? ['THREE_CONSECUTIVE_ARCHITECT_REJECTIONS']
      : []),
    ...(Number(payload.consecutive_stagnant_attempts ?? 0) >= 3
      ? ['THREE_CONSECUTIVE_STAGNANT_ATTEMPTS']
      : [])
  ]
  const review = events.slice(index + 1).findLast((event) => {
    const data = object(event.payload)
    return (
      event.type === 'convergence_review' &&
      authenticated(event) &&
      PHASES.includes(String(event.state)) &&
      kinds.includes(String(data.trigger)) &&
      (data.trigger_event_id === trigger.event_id ||
        (!Object.hasOwn(data, 'trigger_event_id') &&
          event.contract_revision === trigger.contract_revision))
    )
  })
  if (!review) throw new Error('CONVERGENCE_REVIEW_REQUIRED_AFTER_REPEATED_NON_CONVERGENCE')
}
