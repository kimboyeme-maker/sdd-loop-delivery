import { verifyCoordinatorProof } from '../resource/coordinator-evidence'
import { createHash, createHmac } from 'node:crypto'
import { canonicalJson } from '../resource/wire/canonical-json'
import { assertRoleEvidence } from './role-evidence'
type Item = Record<string, unknown>

/** Resolve the authenticated guidance currently bound to this lease, if any.
 * A same-lease update supersedes the dispatch guidance; stale bindings are rejected.
 */
export function currentGuidance(
  state: Item,
  events: readonly Item[],
  lease: Item,
  token: string | undefined
): Readonly<{ id: string; fingerprint: string }> | null {
  const authenticated = (event: Item) => {
    const { signature, ...body } = event
    return (
      event.type === 'runtime_record' &&
      event.role === 'coordinator' &&
      (event.payload as Item)?.action === 'guidance' &&
      (event.coordinator_proof !== undefined
        ? verifyCoordinatorProof(state, event)
        : !!token &&
          signature === createHmac('sha256', token).update(JSON.stringify(body)).digest('hex'))
    )
  }
  const update = events.findLast(
    (event) => authenticated(event) && (event.payload as Item).lease_id === lease.lease_id
  )
  const current =
    update ??
    (lease.guidance_id
      ? events.find((event) => event.event_id === lease.guidance_id && authenticated(event))
      : undefined)
  if (!current) {
    if (lease.guidance_id) throw new Error('GUIDANCE_BINDING_STALE')
    return null
  }
  const guidance = current.payload as Item
  if (
    guidance.agent_id !== lease.agent_id ||
    guidance.authority_epoch !== lease.authority_epoch ||
    guidance.contract_revision !== state.contract_revision ||
    guidance.sdd_fingerprint !== state.sdd_fingerprint ||
    (guidance.packet_id ?? null) !== (lease.packet_id ?? null) ||
    guidance.work_item !== lease.work_item
  )
    throw new Error('GUIDANCE_BINDING_STALE')
  return {
    id: String(current.event_id),
    fingerprint: createHash('sha256').update(canonicalJson(guidance)).digest('hex')
  }
}

/** Build the acknowledgment from the role's own three-field response and the current binding. */
export function guidanceAck(
  binding: Readonly<{ id: string; fingerprint: string }>,
  response: unknown
): Item {
  const value = response as Item | undefined
  const fields = ['next_action', 'check_method', 'stop_condition']
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...fields].sort().join() ||
    fields.some((field) => typeof value[field] !== 'string' || !(value[field] as string).trim())
  )
    throw new Error('GUIDANCE_RESPONSE_REQUIRED')
  return { ...binding, ...value }
}

/** Bind guidance updates to this assignment and require a direct role acknowledgment.
 * The acknowledgment records next action/check/stop conditions; it is not proof
 * of correct understanding. Recovery reporting remains possible without it.
 */
export function requireGuidanceAck(
  state: Item,
  events: readonly Item[],
  lease: Item,
  token: string | undefined,
  payload?: Item,
  eventType?: string
): void {
  const binding = currentGuidance(state, events, lease, token)
  const supplied = payload?.guidance_ack
  if (!binding) {
    if (supplied !== undefined) throw new Error('GUIDANCE_ACK_UNEXPECTED')
    return
  }
  const valid = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const ack = value as Item
    return (
      ack.id === binding.id &&
      ack.fingerprint === binding.fingerprint &&
      ['next_action', 'check_method', 'stop_condition'].every(
        (field) => typeof ack[field] === 'string' && (ack[field] as string).trim()
      )
    )
  }
  if (supplied !== undefined) {
    if (!valid(supplied)) throw new Error('GUIDANCE_ACK_INVALID')
    return
  }
  if (
    ['capability_probe', 'checkpoint', 'implementation_escalation', 'plan_challenge'].includes(
      eventType ?? ''
    )
  )
    return
  for (const event of [...events].reverse()) {
    const actor = event.actor as Item | undefined
    if (
      actor?.lease_id !== lease.lease_id ||
      actor?.agent_id !== lease.agent_id ||
      !valid((event.payload as Item)?.guidance_ack)
    )
      continue
    assertRoleEvidence(state, event, String(lease.role))
    return
  }
  throw new Error('GUIDANCE_ACK_REQUIRED')
}
