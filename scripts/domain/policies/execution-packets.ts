/** A packet is a bounded projection of the admitted graph, never a second task graph. */
export function assertExecutionPackets(
  packets: unknown,
  requirements: readonly string[],
  acceptance: readonly string[]
): void {
  if (!Array.isArray(packets) || !packets.length) throw new Error('EXECUTION_PACKETS_REQUIRED')
  const byId = new Map<string, Record<string, unknown>>()
  const coveredRequirements = new Set<string>(),
    coveredAcceptance = new Set<string>()
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  for (const value of packets) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('EXECUTION_PACKET_INVALID')
    const packet = value as Record<string, unknown>
    if (
      typeof packet.id !== 'string' ||
      !packet.id.trim() ||
      typeof packet.outcome !== 'string' ||
      !packet.outcome.trim()
    )
      throw new Error('EXECUTION_PACKET_INVALID')
    if (byId.has(packet.id)) throw new Error('EXECUTION_PACKET_ID_DUPLICATE')
    byId.set(packet.id, packet)
    for (const field of [
      'requirement_ids',
      'acceptance_ids',
      'preconditions',
      'causal_scope',
      'stop_or_escalate'
    ]) {
      const values = packet[field]
      if (!strings(values) || !values.length || new Set(values).size !== values.length)
        throw new Error(`EXECUTION_PACKET_${field.toUpperCase()}_REQUIRED`)
    }
    for (const id of packet.requirement_ids as string[]) coveredRequirements.add(id)
    for (const id of packet.acceptance_ids as string[]) coveredAcceptance.add(id)
    const dependencies = packet.depends_on_packet_ids ?? []
    if (!strings(dependencies) || new Set(dependencies).size !== dependencies.length)
      throw new Error('EXECUTION_PACKET_DEPENDENCIES_INVALID')
  }
  const remaining = new Map<string, number>(),
    consumers = new Map<string, string[]>()
  for (const [id, packet] of byId) {
    const dependencies = (packet.depends_on_packet_ids ?? []) as string[]
    if (dependencies.some((dependency) => dependency === id || !byId.has(dependency)))
      throw new Error('EXECUTION_PACKET_DEPENDENCY_SCOPE_INVALID')
    remaining.set(id, dependencies.length)
    for (const dependency of dependencies)
      consumers.set(dependency, [...(consumers.get(dependency) ?? []), id])
  }
  // Iterative traversal avoids call-stack failures for large, valid packet chains.
  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id)
  for (let index = 0; index < ready.length; index++)
    for (const consumer of consumers.get(ready[index]!) ?? []) {
      const count = remaining.get(consumer)! - 1
      remaining.set(consumer, count)
      if (count === 0) ready.push(consumer)
    }
  if (ready.length !== byId.size) throw new Error('EXECUTION_PACKET_DEPENDENCY_CYCLE')
  if (
    coveredRequirements.size !== new Set(requirements).size ||
    requirements.some((id) => !coveredRequirements.has(id))
  )
    throw new Error('EXECUTION_PACKET_REQUIREMENT_SCOPE_INVALID')
  if (
    coveredAcceptance.size !== new Set(acceptance).size ||
    acceptance.some((id) => !coveredAcceptance.has(id))
  )
    throw new Error('EXECUTION_PACKET_ACCEPTANCE_SCOPE_INVALID')
}
