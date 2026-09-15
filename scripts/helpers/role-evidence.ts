import { verifyRoleEvent } from '../resource/role-signature'

/** External event/state values must be records before identity comparisons are meaningful. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Bind a historical role event to its issued lease before consuming its product claims. */
export function assertRoleEvidence(
  state: Record<string, unknown>,
  event: Record<string, unknown>,
  role: string
): void {
  const actor = record(event.actor) ? event.actor : undefined
  const issued = record(state.issued_leases) ? state.issued_leases : undefined
  const value =
    actor && identity(actor.lease_id) && issued && Object.hasOwn(issued, actor.lease_id)
      ? issued[actor.lease_id]
      : undefined
  const lease = record(value) ? value : undefined
  if (
    !actor ||
    !lease ||
    !['operator', 'architect'].includes(role) ||
    !identity(event.event_id) ||
    !identity(actor.agent_id) ||
    !Number.isSafeInteger(actor.authority_epoch) ||
    Number(actor.authority_epoch) < 1 ||
    (lease.lease_id !== undefined && lease.lease_id !== actor.lease_id) ||
    event.role !== role ||
    lease.role !== role ||
    actor.agent_id !== lease.agent_id ||
    actor.authority_epoch !== lease.authority_epoch ||
    typeof lease.event_public_key !== 'string' ||
    !verifyRoleEvent(event, lease.event_public_key)
  )
    throw new Error('ROLE_EVIDENCE_PROVENANCE_INVALID')
  if (state.contract_revision !== undefined && lease.contract_revision !== state.contract_revision)
    throw new Error('ROLE_EVIDENCE_CONTRACT_STALE')
}
