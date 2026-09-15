export type RuntimeReuseInput = Readonly<{
  requestedRole: 'Coordinator' | 'Operator' | 'Architect'
  runtimeRole: string
  agentId: string
  expectedAgentId: string
  taskId: string
  runtimeTaskId: string
  leaseValid: boolean
  stopped: boolean
  capabilityIncidentOpen: boolean
}>

export type RuntimeReuseResult = Readonly<{
  reusable: boolean
  reasons: readonly string[]
}>

/** Decide whether an existing runtime may receive a same-task continuation. */
export function assessRuntimeReuse(input: RuntimeReuseInput): RuntimeReuseResult {
  const reasons: string[] = []
  if (input.agentId !== input.expectedAgentId) reasons.push('RUNTIME_IDENTITY_MISMATCH')
  if (input.runtimeRole !== input.requestedRole) reasons.push('RUNTIME_ROLE_MISMATCH')
  if (input.taskId !== input.runtimeTaskId) reasons.push('RUNTIME_TASK_MISMATCH')
  if (!input.leaseValid) reasons.push('RUNTIME_LEASE_INVALID')
  if (input.stopped) reasons.push('RUNTIME_STOPPED')
  if (input.capabilityIncidentOpen) reasons.push('RUNTIME_CAPABILITY_INCIDENT')
  return { reusable: reasons.length === 0, reasons }
}
