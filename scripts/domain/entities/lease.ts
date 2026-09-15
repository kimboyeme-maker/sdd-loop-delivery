import { isBeforeDeadline } from '../policies/deadline'

export type Lease = Readonly<{
  id: string
  agentId: string
  role: 'Coordinator' | 'Operator' | 'Architect'
  epoch: number
  deadline: number
  scope: readonly string[]
}>

export type LeaseRequest = Readonly<{
  leaseId: string
  agentId: string
  role: Lease['role']
  epoch: number
  now: number
  path?: string
}>

/** Validate authority and a finite expiry before permitting a scoped operation. */
export function assertLease(lease: Lease, request: LeaseRequest): void {
  if (lease.id !== request.leaseId || lease.agentId !== request.agentId)
    throw new Error('LEASE_BINDING_MISMATCH')
  if (lease.role !== request.role || lease.epoch !== request.epoch)
    throw new Error('LEASE_AUTHORITY_MISMATCH')
  // NaN makes ordered comparisons false; Infinity would grant unbounded authority.
  if (!isBeforeDeadline(request.now, lease.deadline)) throw new Error('LEASE_EXPIRED')
  if (request.path && !lease.scope.includes(request.path)) throw new Error('LEASE_SCOPE_DENIED')
}
