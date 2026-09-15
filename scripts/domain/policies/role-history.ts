import { isRuntimeIdentity } from '../../helpers/runtime-identity'
import { coordinatorHistory } from './coordinator-history'
/** Reuse preserves role history; a new lease or epoch does not erase prior exclusions. */
export function assertProductRoleHistory(
  state: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
  agentId: string,
  role: 'operator' | 'architect'
): void {
  const coordinators = coordinatorHistory(state)
  if (coordinators.includes(agentId)) throw new Error('COORDINATOR_CANNOT_RECEIVE_TASK_ROLE_LEASE')
  const recordedRole = (state.agent_roles as Record<string, unknown> | undefined)?.[agentId]
  if (recordedRole !== undefined && recordedRole !== role)
    throw new Error('AGENT_ROLE_REUSE_FORBIDDEN')
  const leases = state.issued_leases
  if (
    leases !== undefined &&
    (leases === null || typeof leases !== 'object' || Array.isArray(leases))
  )
    throw new Error('RUNTIME_LEASE_HISTORY_INVALID')
  // Unknown records may hide a prior role: never skip them as if no lease existed.
  for (const value of Object.values(leases ?? {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('RUNTIME_LEASE_HISTORY_INVALID')
    const lease = value as Record<string, unknown>
    if (
      !isRuntimeIdentity(lease.agent_id) ||
      !['operator', 'architect'].includes(String(lease.role))
    )
      throw new Error('RUNTIME_LEASE_HISTORY_INVALID')
    if (lease.agent_id === agentId && lease.role !== role)
      throw new Error('RUNTIME_CROSS_ROLE_FORBIDDEN')
  }
  // A retirement remains exclusionary even after a later observation or close result.
  if (
    events.some((event) => {
      const payload = event.payload as Record<string, unknown> | undefined
      return (
        event.type === 'runtime_record' &&
        payload?.agent_id === agentId &&
        (payload.action === 'retire' ||
          (payload.action === 'close_result' && payload.result === 'CLOSED'))
      )
    })
  )
    throw new Error('RUNTIME_RETIRED')
  const observation = events.findLast((event) => {
    const payload = event.payload as Record<string, unknown> | undefined
    return (
      event.type === 'runtime_record' &&
      payload?.agent_id === agentId &&
      payload.action === 'observe'
    )
  })?.payload as Record<string, unknown> | undefined
  if (observation) {
    if (observation.agent_role !== role) throw new Error('AGENT_ROLE_REUSE_FORBIDDEN')
    if (
      observation.authority_epoch !== state.authority_epoch ||
      observation.coordinator_agent_id !== state.coordinator_agent_id
    )
      throw new Error('RUNTIME_OWNER_RECONFIRMATION_REQUIRED')
    const host = observation.host as Record<string, unknown> | undefined
    if (!host || !['healthy', 'idle', 'completed'].includes(String(host.status)))
      throw new Error('RUNTIME_UNAVAILABLE')
  }
}
