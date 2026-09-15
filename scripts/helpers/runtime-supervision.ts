import { eventsWithId } from '../utils/event-index'
import { createHmac } from 'node:crypto'
import { assertRoleEvidence } from './role-evidence'
import { requireGuidanceAck } from './guidance-ack'
type Item = Record<string, unknown>
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()

/** Closing an execution concern requires a later signed check, not another Coordinator assertion. */
export function assertRuntimeSupervision(
  state: Item,
  events: readonly Item[],
  input: Item,
  token: string
): void {
  if (input.action !== 'supervision') return
  const matches = eventsWithId(events, input.basis_event_id)
  const basis = matches[0]
  if (
    !text(input.basis_event_id) ||
    matches.length !== 1 ||
    !basis ||
    !['finding', 'operator_reconcile', 'pipeline_incident', 'recovery'].includes(
      String(basis.type)
    ) ||
    !text(input.work_item) ||
    !text(input.next_action) ||
    !['OPEN', 'RESOLVED'].includes(String(input.disposition))
  )
    throw new Error('SUPERVISION_BASIS_INVALID')
  const assertCoordinator = (event: Item): void => {
    const { signature, ...body } = event
    if (
      event.role !== 'coordinator' ||
      signature !== createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
    )
      throw new Error('SUPERVISION_BASIS_INVALID')
  }
  if (basis.role === 'coordinator') assertCoordinator(basis)
  else assertRoleEvidence(state, basis, String(basis.role))
  if (input.disposition !== 'RESOLVED') return
  // Task/root-cause identity survives replacement; do not filter by the latest agent ID.
  const prior = events.findLast((event) => {
    const payload = event.payload as Item | undefined
    return (
      event.type === 'runtime_record' &&
      payload?.action === 'supervision' &&
      payload.basis_event_id === input.basis_event_id &&
      payload.work_item === input.work_item
    )
  })
  if (!prior || (prior.payload as Item).disposition !== 'OPEN')
    throw new Error('SUPERVISION_OPEN_OBLIGATION_REQUIRED')
  assertCoordinator(prior)
  const checks = eventsWithId(events, input.check_event_id)
  const check = checks[0]
  if (
    !text(input.check_event_id) ||
    checks.length !== 1 ||
    !check ||
    !['checkpoint', 'self_check', 'verification'].includes(String(check.type)) ||
    events.indexOf(check) <= events.indexOf(prior)
  )
    throw new Error('SUPERVISION_RESOLUTION_CHECK_REQUIRED')
  assertRoleEvidence(state, check, String(check.role))
  const payload = check.payload as Item
  const actor = check.actor as Item
  const lease = (state.issued_leases as Record<string, Item>)[String(actor.lease_id)]!
  if (
    lease.work_item !== input.work_item ||
    (payload.result !== 'PASS' && (payload.last_check as Item | undefined)?.outcome !== 'PASS')
  )
    throw new Error('SUPERVISION_RESOLUTION_CHECK_REQUIRED')
  // Recovery checkpoints can omit acknowledgments when submitted, but not when
  // used to close supervision; a changed guidance version requires a new check.
  requireGuidanceAck(state, events.slice(0, events.indexOf(check)), lease, token, payload)
  requireGuidanceAck(state, events, lease, token, payload)
}
