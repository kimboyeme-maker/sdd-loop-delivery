import { assertTestBudget } from './policies/test-budget'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const ids = (value: unknown, allowEmpty = false): value is string[] =>
  Array.isArray(value) &&
  (allowEmpty || value.length > 0) &&
  value.every(text) &&
  new Set(value).size === value.length

/** One batch must fit a single Operator lease hard deadline (minutes). */
export const MAX_BATCH_MINUTES = 60

/** Scheduling projection returned to the author; it is advisory, never runtime progress. */
export type DeliveryPlanSummary = Readonly<{
  protocol: 'delivery-plan/v1'
  waves: string[][]
  lanes: Record<string, string[]>
  serial_minutes: number
  critical_path_minutes: number
  final_verification_shards: number
  test_minutes: number
}>

/** Two package roots can write the same bytes when equal, nested, or either is the root. */
export function packagesOverlap(a: string, b: string): boolean {
  return a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/**
 * Validate the optional `delivery_plan` projection of the requirement graph.
 * Batches are lease-sized units with explicit write packages. Any two batches without a
 * dependency path between them may run at the same time, so their write packages must be
 * disjoint; lanes only express runtime affinity. Final verification shards must partition
 * the Must-Ship acceptance without a blocking edge crossing shards.
 */
export function assertDeliveryPlan(contract: Item): DeliveryPlanSummary | null {
  if (contract.delivery_plan === undefined) return null
  const plan = object(contract.delivery_plan)
  if (!plan || plan.protocol !== 'delivery-plan/v1' || !Array.isArray(plan.batches))
    throw new Error('DELIVERY_PLAN_INVALID')
  if (!plan.batches.length) throw new Error('DELIVERY_PLAN_INVALID')
  const requirements = new Map<string, Item>()
  for (const value of Array.isArray(contract.requirements) ? contract.requirements : []) {
    const requirement = object(value)
    if (requirement && text(requirement.id)) requirements.set(requirement.id, requirement)
  }
  const acceptanceOf = (id: string): string[] =>
    ids(requirements.get(id)?.acceptance, true)
      ? (requirements.get(id)!.acceptance as string[])
      : []
  const batches = new Map<string, Item>()
  for (const value of plan.batches) {
    const batch = object(value)
    if (
      !batch ||
      !text(batch.id) ||
      !text(batch.lane) ||
      !ids(batch.requirement_ids) ||
      !ids(batch.acceptance_ids) ||
      !ids(batch.modification_packages) ||
      !ids(batch.depends_on ?? [], true) ||
      !Number.isSafeInteger(batch.estimated_minutes) ||
      Number(batch.estimated_minutes) < 1
    )
      throw new Error('DELIVERY_PLAN_BATCH_INVALID')
    if (batches.has(batch.id)) throw new Error('DELIVERY_PLAN_BATCH_DUPLICATE')
    if (Number(batch.estimated_minutes) > MAX_BATCH_MINUTES)
      throw new Error(`DELIVERY_PLAN_BATCH_TOO_LARGE: ${batch.id}`)
    assertTestBudget(
      batch.test_budget,
      'DELIVERY_PLAN',
      Number(batch.estimated_minutes),
      batch.acceptance_ids as string[]
    )
    for (const id of batch.requirement_ids as string[]) {
      const requirement = requirements.get(id)
      if (!requirement || requirement.kind === 'non-goal')
        throw new Error('DELIVERY_PLAN_REQUIREMENT_UNKNOWN')
    }
    const local = new Set((batch.requirement_ids as string[]).flatMap(acceptanceOf))
    if ((batch.acceptance_ids as string[]).some((id) => !local.has(id)))
      throw new Error(`DELIVERY_PLAN_ACCEPTANCE_SCOPE_INVALID: ${batch.id}`)
    batches.set(batch.id, batch)
  }
  // Every delivered requirement and each of its acceptance cases lands in some batch.
  const plannedRequirements = new Set(
    [...batches.values()].flatMap((b) => b.requirement_ids as string[])
  )
  const plannedAcceptance = new Set(
    [...batches.values()].flatMap((b) => b.acceptance_ids as string[])
  )
  for (const [id, requirement] of requirements) {
    if (requirement.kind === 'non-goal') continue
    if (!plannedRequirements.has(id))
      throw new Error(`DELIVERY_PLAN_REQUIREMENT_COVERAGE_INCOMPLETE: ${id}`)
    if (acceptanceOf(id).some((acceptance) => !plannedAcceptance.has(acceptance)))
      throw new Error(`DELIVERY_PLAN_ACCEPTANCE_COVERAGE_INCOMPLETE: ${id}`)
  }
  const dependencies = (id: string) => (batches.get(id)!.depends_on ?? []) as string[]
  for (const id of batches.keys())
    if (dependencies(id).some((dependency) => dependency === id || !batches.has(dependency)))
      throw new Error('DELIVERY_PLAN_DEPENDENCY_UNKNOWN')
  // Kahn order gives waves (earliest start) and a transitive ancestor set per batch.
  const remaining = new Map([...batches.keys()].map((id) => [id, dependencies(id).length]))
  const consumers = new Map<string, string[]>()
  for (const id of batches.keys())
    for (const dependency of dependencies(id))
      consumers.set(dependency, [...(consumers.get(dependency) ?? []), id])
  const order = [...remaining].filter(([, count]) => count === 0).map(([id]) => id)
  for (let index = 0; index < order.length; index++)
    for (const consumer of consumers.get(order[index]!) ?? []) {
      const count = remaining.get(consumer)! - 1
      remaining.set(consumer, count)
      if (count === 0) order.push(consumer)
    }
  if (order.length !== batches.size) throw new Error('DELIVERY_PLAN_DEPENDENCY_CYCLE')
  const ancestors = new Map<string, Set<string>>()
  const level = new Map<string, number>()
  const finish = new Map<string, number>()
  for (const id of order) {
    const set = new Set<string>()
    let wave = 0,
      start = 0
    for (const dependency of dependencies(id)) {
      set.add(dependency)
      for (const ancestor of ancestors.get(dependency)!) set.add(ancestor)
      wave = Math.max(wave, level.get(dependency)! + 1)
      start = Math.max(start, finish.get(dependency)!)
    }
    ancestors.set(id, set)
    level.set(id, wave)
    finish.set(id, start + Number(batches.get(id)!.estimated_minutes))
  }
  // A requirement dependency satisfied in another batch must be scheduled strictly before.
  const providers = new Map<string, string[]>()
  for (const [id, batch] of batches)
    for (const requirement of batch.requirement_ids as string[])
      providers.set(requirement, [...(providers.get(requirement) ?? []), id])
  for (const [id, batch] of batches)
    for (const requirement of batch.requirement_ids as string[])
      for (const dependency of ids(requirements.get(requirement)?.dependencies, true)
        ? (requirements.get(requirement)!.dependencies as string[])
        : [])
        for (const provider of providers.get(dependency) ?? [])
          if (provider !== id && !ancestors.get(id)!.has(provider))
            throw new Error(`DELIVERY_PLAN_REQUIREMENT_ORDER_INVALID: ${id}`)
  const ids_ = [...batches.keys()]
  for (let i = 0; i < ids_.length; i++)
    for (let j = i + 1; j < ids_.length; j++) {
      const a = ids_[i]!,
        b = ids_[j]!
      if (ancestors.get(a)!.has(b) || ancestors.get(b)!.has(a)) continue
      const overlap = (batches.get(a)!.modification_packages as string[]).some((left) =>
        (batches.get(b)!.modification_packages as string[]).some((right) =>
          packagesOverlap(left, right)
        )
      )
      if (overlap) throw new Error(`DELIVERY_PLAN_WRITE_CONFLICT: ${a}/${b}`)
    }
  const shards = assertVerificationShards(plan, contract, requirements)
  const waves: string[][] = []
  for (const id of order) (waves[level.get(id)!] ??= []).push(id)
  const lanes: Record<string, string[]> = {}
  for (const id of order) (lanes[String(batches.get(id)!.lane)] ??= []).push(id)
  return {
    protocol: 'delivery-plan/v1',
    waves: waves.map((wave) => wave.sort()),
    lanes,
    serial_minutes: [...batches.values()].reduce((sum, b) => sum + Number(b.estimated_minutes), 0),
    critical_path_minutes: Math.max(...finish.values()),
    final_verification_shards: shards,
    test_minutes: [...batches.values()].reduce(
      (sum, b) => sum + Number((b.test_budget as Item).minutes),
      0
    )
  }
}

/** Shards partition Must-Ship acceptance; a cross-shard blocking edge would hide evidence. */
function assertVerificationShards(
  plan: Item,
  contract: Item,
  requirements: ReadonlyMap<string, Item>
): number {
  if (plan.final_verification_shards === undefined) return 0
  if (!Array.isArray(plan.final_verification_shards) || !plan.final_verification_shards.length)
    throw new Error('DELIVERY_PLAN_SHARDS_INVALID')
  const mustShip = new Set(
    [...requirements.values()]
      .filter((requirement) => requirement.kind === 'must-ship')
      .flatMap((requirement) => (ids(requirement.acceptance) ? requirement.acceptance : []))
  )
  const shardOf = new Map<string, string>()
  const shardIds = new Set<string>()
  for (const value of plan.final_verification_shards) {
    const shard = object(value)
    if (!shard || !text(shard.id) || shardIds.has(shard.id) || !ids(shard.acceptance_ids))
      throw new Error('DELIVERY_PLAN_SHARDS_INVALID')
    shardIds.add(shard.id)
    for (const id of shard.acceptance_ids as string[]) {
      if (!mustShip.has(id) || shardOf.has(id))
        throw new Error(`DELIVERY_PLAN_SHARD_COVERAGE_INVALID: ${id}`)
      shardOf.set(id, shard.id)
    }
  }
  if (shardOf.size !== mustShip.size) throw new Error('DELIVERY_PLAN_SHARD_COVERAGE_INVALID')
  for (const value of Array.isArray(contract.acceptance) ? contract.acceptance : []) {
    const acceptance = object(value)
    const blocking = object(acceptance?.execution)?.blocking_acceptance_ids
    if (!acceptance || !shardOf.has(String(acceptance.id)) || !Array.isArray(blocking)) continue
    for (const id of blocking)
      if (shardOf.has(String(id)) && shardOf.get(String(id)) !== shardOf.get(String(acceptance.id)))
        throw new Error(`DELIVERY_PLAN_SHARD_BLOCKING_EDGE: ${String(acceptance.id)}/${String(id)}`)
  }
  return shardIds.size
}
