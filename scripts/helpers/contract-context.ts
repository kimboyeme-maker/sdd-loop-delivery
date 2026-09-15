type Item = Record<string, unknown>

/** Narrow only requirement/acceptance arrays; retain global authority, migration and implementation logic. */
export function contractContext(contract: Item, packet?: Item): Item {
  const result = structuredClone(contract)
  if (!packet) return result
  const requirements = contract.requirements as Item[]
  const byId = new Map(requirements.map((item) => [item.id, item]))
  const selected = new Set<unknown>(packet.requirement_ids as string[])
  for (const item of requirements) if (item.kind === 'non-goal') selected.add(item.id)
  const pending = [...selected]
  while (pending.length) {
    const requirement = byId.get(pending.pop())
    if (!requirement) throw new Error('CONTEXT_REQUIREMENT_UNKNOWN')
    for (const dependency of (requirement.dependencies ?? []) as string[]) {
      if (!selected.has(dependency)) {
        selected.add(dependency)
        pending.push(dependency)
      }
    }
  }
  const acceptance = new Set<unknown>(packet.acceptance_ids as string[])
  for (const item of requirements)
    if (selected.has(item.id))
      for (const id of (item.acceptance ?? []) as string[]) acceptance.add(id)
  result.requirements = (result.requirements as Item[]).filter((item) => selected.has(item.id))
  result.acceptance = (result.acceptance as Item[]).filter((item) => acceptance.has(item.id))
  return result
}
