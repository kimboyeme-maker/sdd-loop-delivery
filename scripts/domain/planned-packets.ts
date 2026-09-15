type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const sameList = (left: unknown, right: unknown): boolean =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === right.length &&
  [...left].map(String).sort().join('\0') === [...right].map(String).sort().join('\0')

/**
 * Keep one work graph. When the contract carries a `delivery_plan`, an ADMIT packet reusing a
 * batch ID supplies only execution guidance (outcome, preconditions, causal scope, stop
 * conditions); requirement/acceptance IDs, write packages, test budget and dependencies come
 * from the plan. A restated graph field must equal the plan, so the two cannot drift. Plan
 * dependencies outside this admission are prior-evidence prerequisites, not packet edges.
 * The expanded packets are what the controller signs and every consumer reads.
 */
export function expandPlannedPackets(contract: Item | null, admission: Item): Item {
  const plan = object(contract?.delivery_plan)
  if (!plan || !Array.isArray(plan.batches) || !Array.isArray(admission.execution_packets))
    return admission
  const batches = new Map(
    plan.batches
      .map(object)
      .filter((batch): batch is Item => !!batch && typeof batch.id === 'string')
      .map((batch) => [String(batch.id), batch])
  )
  const admitted = new Set(
    admission.execution_packets.map((value) => String(object(value)?.id ?? ''))
  )
  const packets = admission.execution_packets.map((value) => {
    const packet = object(value)
    const batch = packet ? batches.get(String(packet.id)) : undefined
    if (!packet || !batch) return value
    const dependencies = ((batch.depends_on ?? []) as string[]).filter((id) => admitted.has(id))
    const planned: Item = {
      requirement_ids: batch.requirement_ids,
      acceptance_ids: batch.acceptance_ids,
      modification_packages: batch.modification_packages,
      test_budget: batch.test_budget,
      ...(dependencies.length ? { depends_on_packet_ids: dependencies } : {})
    }
    for (const [field, expected] of Object.entries(planned)) {
      const given = packet[field]
      if (given === undefined) continue
      const budget = object(given),
        plannedBudget = object(expected)
      const equal =
        field === 'test_budget'
          ? budget?.minutes === plannedBudget?.minutes &&
            budget?.max_new_test_files === plannedBudget?.max_new_test_files
          : sameList(given, expected)
      if (!equal)
        throw new Error(`EXECUTION_PACKET_PLAN_RESTATEMENT_MISMATCH: ${packet.id}/${field}`)
    }
    return {
      ...packet,
      ...planned,
      outcome: packet.outcome ?? batch.outcome
    }
  })
  return { ...admission, execution_packets: packets }
}
