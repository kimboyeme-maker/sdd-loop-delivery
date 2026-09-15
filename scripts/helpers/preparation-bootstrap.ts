import { verifyRoleEvent } from '../resource/role-signature'
type Item = Record<string, unknown>
const phases = ['OPEN', 'REAUTHENTICATE', 'READY']

/** Authenticate the persisted preparation prefix before resuming or consuming it. */
export function preparationBootstrapCount(
  state: Item,
  grant: Item,
  events: readonly Item[]
): number {
  const completed = grant.capability_probe_phases ?? []
  if (
    !Array.isArray(completed) ||
    completed.length > phases.length ||
    completed.some((phase, index) => phase !== phases[index])
  )
    throw new Error('CAPABILITY_PROBE_SEQUENCE_INVALID')
  const probes = events.filter(
    (event) =>
      event.type === 'capability_probe' &&
      (event.actor as Item | undefined)?.prepared_id === grant.prepared_id
  )
  if (probes.length !== completed.length) throw new Error('PREPARATION_BOOTSTRAP_EVIDENCE_INVALID')
  for (const [index, event] of probes.entries()) {
    const actor = event.actor as Item
    if (
      event.role !== 'architect' ||
      actor.agent_id !== grant.agent_id ||
      actor.authority_epoch !== state.authority_epoch ||
      event.contract_revision !== state.contract_revision ||
      (event.payload as Item)?.phase !== phases[index] ||
      typeof grant.event_public_key !== 'string' ||
      !verifyRoleEvent(event, grant.event_public_key)
    )
      throw new Error('PREPARATION_BOOTSTRAP_EVIDENCE_INVALID')
  }
  return completed.length
}
