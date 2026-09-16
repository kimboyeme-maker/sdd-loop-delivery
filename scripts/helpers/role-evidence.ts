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
  assertRoleProvenance(state, event, role)
  // Currency, not authenticity: evidence written under an earlier contract revision was genuine
  // when it was written, but it may not be used to satisfy an obligation of the current one.
  const lease = leaseOf(state, event)
  if (state.contract_revision !== undefined && lease?.contract_revision !== state.contract_revision)
    throw new Error('ROLE_EVIDENCE_CONTRACT_STALE')
}

/** The lease an event's actor names, when the state still records it. */
function leaseOf(
  state: Record<string, unknown>,
  event: Record<string, unknown>
): Record<string, unknown> | undefined {
  const actor = record(event.actor) ? (event.actor as Record<string, unknown>) : undefined
  const issued = record(state.issued_leases)
    ? (state.issued_leases as Record<string, unknown>)
    : undefined
  const value =
    actor && identity(actor.lease_id) && issued && Object.hasOwn(issued, actor.lease_id)
      ? issued[actor.lease_id as string]
      : undefined
  return record(value) ? (value as Record<string, unknown>) : undefined
}

/**
 * Whether this event really was written by the role and lease it names. This is a statement about
 * the past and must stay true forever: a contract amendment retires a lease for future use but
 * cannot make the events it already signed unauthentic. Authentication of history uses this;
 * accepting evidence against a current obligation uses `assertRoleEvidence`, which adds currency.
 */
export function assertRoleProvenance(
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
}
