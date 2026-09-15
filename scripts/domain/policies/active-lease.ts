import { isBeforeDeadline } from './deadline'

/** Check native lease time and authority without extending its issued deadline. */
export function assertActiveLease(
  state: Record<string, unknown>,
  lease: Record<string, unknown>,
  now = Date.now()
): void {
  if (
    lease.authority_epoch !== state.authority_epoch ||
    !Number.isSafeInteger(state.authority_epoch) ||
    Number(state.authority_epoch) < 1
  )
    throw new Error('AGENT_LEASE_EPOCH_MISMATCH')
  const issued = typeof lease.issued_at === 'string' ? Date.parse(lease.issued_at) : NaN
  const minutes = lease.hard_deadline_minutes
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(issued) ||
    typeof minutes !== 'number' ||
    !Number.isFinite(minutes) ||
    minutes <= 0 ||
    !Number.isFinite(issued + minutes * 60000)
  )
    throw new Error('AGENT_LEASE_DEADLINE_UNVERIFIABLE')
  if (now < issued) throw new Error('AGENT_LEASE_CLOCK_INVALID')
  if (!isBeforeDeadline(now, issued + minutes * 60000)) throw new Error('AGENT_LEASE_EXPIRED')
}
