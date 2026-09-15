import { assertLease, type Lease, type LeaseRequest } from '../entities/lease'
import { assertPhaseTransition, type Phase } from './phase'

export type DispatchPlan = Readonly<{
  leaseId: string
  agentId: string
  role: Lease['role']
  from: Phase
  to: Phase
  scope: readonly string[]
}>

export function planDispatch(
  lease: Lease,
  request: LeaseRequest,
  from: Phase,
  to: Phase
): DispatchPlan {
  assertLease(lease, request)
  assertPhaseTransition(from, to)
  return Object.freeze({
    leaseId: lease.id,
    agentId: lease.agentId,
    role: lease.role,
    from,
    to,
    scope: [...lease.scope]
  })
}
