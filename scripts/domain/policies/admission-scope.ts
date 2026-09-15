import type { Contract } from '../contract'
import { assertExecutionPackets } from './execution-packets'
import { assertTestBudget } from './test-budget'

/** Validate both aggregate coverage and each packet's normative requirement-to-acceptance edges. */
export function assertAdmissionScope(contract: Contract, admission: Record<string, unknown>): void {
  const requirementIds = admission.requirement_ids
  const acceptanceIds = admission.acceptance_ids
  if (
    !Array.isArray(requirementIds) ||
    !requirementIds.length ||
    new Set(requirementIds).size !== requirementIds.length ||
    requirementIds.some(
      (id) =>
        typeof id !== 'string' ||
        !contract.requirements.some((req) => req.id === id && req.kind !== 'non-goal')
    )
  )
    throw new Error('ADMISSION_REQUIREMENT_SCOPE_INVALID')
  const byRequirement = new Map(
    contract.requirements.map((req) => [req.id, new Set(req.acceptance ?? [])])
  )
  const allowedAcceptance = new Set(requirementIds.flatMap((id) => [...byRequirement.get(id)!]))
  if (
    !Array.isArray(acceptanceIds) ||
    !acceptanceIds.length ||
    new Set(acceptanceIds).size !== acceptanceIds.length ||
    acceptanceIds.some((id) => typeof id !== 'string' || !allowedAcceptance.has(id))
  )
    throw new Error('ADMISSION_ACCEPTANCE_SCOPE_INVALID')
  assertExecutionPackets(admission.execution_packets, requirementIds, acceptanceIds)
  const packets = admission.execution_packets as {
    id: string
    requirement_ids: string[]
    acceptance_ids: string[]
    depends_on_packet_ids?: string[]
    modification_packages?: unknown
    test_budget?: unknown
  }[]
  // A packet may narrow its write set to part of the admitted modification authority;
  // an authored delivery plan bounds packets that reuse its batch identifiers.
  const admitted = Array.isArray(admission.modification_packages)
    ? (admission.modification_packages as unknown[])
    : []
  const plan = contract.delivery_plan as { batches?: Record<string, unknown>[] } | undefined
  for (const packet of packets) {
    const own = packet.modification_packages
    if (
      own !== undefined &&
      (!Array.isArray(own) ||
        !own.length ||
        new Set(own).size !== own.length ||
        own.some((name) => typeof name !== 'string' || !admitted.includes(name)))
    )
      throw new Error('EXECUTION_PACKET_MODIFICATION_PACKAGES_INVALID')
    const batch = plan?.batches?.find((item) => item.id === packet.id)
    if (
      batch &&
      (packet.requirement_ids.some((id) => !(batch.requirement_ids as string[]).includes(id)) ||
        (Array.isArray(own) &&
          own.some((name) => !(batch.modification_packages as string[]).includes(name))))
    )
      throw new Error(`EXECUTION_PACKET_PLAN_MISMATCH: ${packet.id}`)
    // Every packet carries an explicit, strict test budget; a planned batch bounds it further.
    const budget = assertTestBudget(
      packet.test_budget,
      'EXECUTION_PACKET',
      undefined,
      packet.acceptance_ids
    )
    const planned = batch?.test_budget as Record<string, unknown> | undefined
    if (
      planned &&
      (budget.minutes > Number(planned.minutes) ||
        budget.max_new_test_files > Number(planned.max_new_test_files))
    )
      throw new Error(`EXECUTION_PACKET_PLAN_MISMATCH: ${packet.id}`)
  }
  const byPacket = new Map(packets.map((packet) => [packet.id, packet]))
  const providers = new Map<string, Set<string>>()
  for (const packet of packets)
    for (const requirement of packet.requirement_ids) {
      const ids = providers.get(requirement) ?? new Set<string>()
      ids.add(packet.id)
      providers.set(requirement, ids)
    }
  const dependencies = new Map(contract.requirements.map((req) => [req.id, req.dependencies ?? []]))
  // Packet shape is established above; do not infer associations from matching counts.
  for (const packet of packets) {
    const localAcceptance = new Set(
      packet.requirement_ids.flatMap((id) => [...byRequirement.get(id)!])
    )
    if (
      packet.acceptance_ids.some((id) => !localAcceptance.has(id)) ||
      packet.requirement_ids.some(
        (id) => !packet.acceptance_ids.some((acceptance) => byRequirement.get(id)!.has(acceptance))
      )
    )
      throw new Error('EXECUTION_PACKET_REQUIREMENT_ACCEPTANCE_MISMATCH')
    // Every admitted producer packet must precede its consumer. Dependencies
    // within one packet are ordered by normative implementation logic instead.
    // Out-of-admission prerequisites require separate prior-evidence validation;
    // this graph check must not fabricate their completion from missing packets.
    const required = new Set<string>()
    for (const requirement of packet.requirement_ids)
      for (const dependency of dependencies.get(requirement) ?? [])
        for (const provider of providers.get(dependency) ?? [])
          if (provider !== packet.id) required.add(provider)
    const visited = new Set<string>()
    const pending = [...(packet.depends_on_packet_ids ?? [])]
    while (pending.length && required.size) {
      const id = pending.pop()!
      if (visited.has(id)) continue
      visited.add(id)
      required.delete(id)
      pending.push(...(byPacket.get(id)!.depends_on_packet_ids ?? []))
    }
    if (required.size) throw new Error('EXECUTION_PACKET_REQUIREMENT_ORDER_INVALID')
  }
}
