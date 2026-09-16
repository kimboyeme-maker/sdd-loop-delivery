import type { Contract } from '../contract'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const list = (value: unknown): Item[] =>
  Array.isArray(value) ? value.map(object).filter((item): item is Item => !!item) : []

/** Review lenses a converged design must have passed after its last normative change. */
const CONVERGENCE_LENSES = ['SYNTHESIS', 'ADVERSARIAL', 'ACCEPTANCE_TOPOLOGY'] as const
/** Unresolved lists that must be empty before a design may claim convergence. */
const CONVERGENCE_OPEN_LISTS = [
  'unresolved_information_questions',
  'pending_authority_confirmations',
  'route_critical_unknowns',
  'blocking_findings',
  'material_findings'
] as const

/**
 * Batch ancestry from the delivery plan: `before(a, b)` is true when batch `a` is `b` or one of
 * its transitive dependencies, i.e. `a` has landed whenever `b` runs.
 */
function batchOrder(contract: Contract) {
  const batches = list(object(contract.delivery_plan)?.batches)
  const ancestors = new Map<string, Set<string>>()
  const byId = new Map(batches.map((batch) => [String(batch.id), batch]))
  const visit = (id: string, trail: Set<string>): Set<string> => {
    const known = ancestors.get(id)
    if (known) return known
    const result = new Set<string>([id])
    if (trail.has(id)) return result
    trail.add(id)
    for (const dependency of texts(byId.get(id)?.depends_on)
      ? (byId.get(id)!.depends_on as string[])
      : [])
      for (const ancestor of visit(dependency, trail)) result.add(ancestor)
    trail.delete(id)
    ancestors.set(id, result)
    return result
  }
  const batchesOf = (key: 'requirement_ids' | 'acceptance_ids', ids: readonly string[]) =>
    batches
      .filter(
        (batch) => texts(batch[key]) && (batch[key] as string[]).some((id) => ids.includes(id))
      )
      .map((batch) => String(batch.id))
  return {
    planned: batches.length > 0,
    batchesOf,
    /** Every producer batch has landed before or with every consumer batch. */
    landed: (producers: readonly string[], consumers: readonly string[]) =>
      consumers.every((consumer) =>
        producers.every((producer) => visit(consumer, new Set()).has(producer))
      )
  }
}

/**
 * Close the implementation work graph that `validate` otherwise only checks for shape: every
 * required value has a producer inside its path or a declared input; a cross-path input names a
 * real producing path and output; paths form no cycle; a producer never lands after the batch
 * that consumes it or verifies it. Names are free: truth comes from explicit producer bindings.
 */
export function assertImplementationGraph(contract: Contract): void {
  const logic = object(contract.implementation_logic)
  if (!logic) return
  const paths = list(logic.paths)
  const byId = new Map(paths.map((path) => [String(path.id), path]))
  const edges = new Map<string, Set<string>>()
  const order = batchOrder(contract)
  /** Paths that publish each output name; an ENTRY input with such a name must say which it is. */
  const publishers = new Map<string, string[]>()
  for (const path of paths)
    for (const name of texts(path.outputs) ? (path.outputs as string[]) : [])
      publishers.set(name, [...(publishers.get(name) ?? []), String(path.id)])
  for (const path of paths) {
    const id = String(path.id)
    const available = new Set<string>()
    edges.set(id, new Set())
    for (const input of list(path.inputs)) {
      if (!text(input.name)) throw new Error(`IMPLEMENTATION_LOGIC_INPUT_INVALID: ${id}`)
      const source = input.source
      if (source === 'ENTRY') {
        if (!texts(input.evidence) || !(input.evidence as string[]).length)
          throw new Error(`IMPLEMENTATION_LOGIC_ENTRY_EVIDENCE_REQUIRED: ${id}.${input.name}`)
        // Same name is not proof of the same value, but it is ambiguous: bind the producing path, or
        // declare the value independent of that output.
        const shadowed = (publishers.get(input.name) ?? []).filter((producer) => producer !== id)
        if (shadowed.length && input.independent_of_outputs !== true)
          throw new Error(
            `IMPLEMENTATION_LOGIC_ENTRY_SHADOWS_PRODUCER: ${id}.${input.name}<-${shadowed.join(',')}`
          )
      } else {
        const binding = object(source)
        const producer = binding && text(binding.path) ? byId.get(binding.path) : undefined
        if (!binding || !producer || binding.path === id || !text(binding.output))
          throw new Error(`IMPLEMENTATION_LOGIC_INPUT_SOURCE_INVALID: ${id}.${input.name}`)
        if (!texts(producer.outputs) || !(producer.outputs as string[]).includes(binding.output))
          throw new Error(`IMPLEMENTATION_LOGIC_PRODUCER_OUTPUT_MISSING: ${id}.${input.name}`)
        edges.get(id)!.add(String(binding.path))
      }
      available.add(input.name)
    }
    const steps = list(path.steps)
    // Legacy contracts without per-step value flow keep their shape-only validation.
    if (!steps.length || !steps.every((step) => texts(step.requires) && texts(step.produces)))
      continue
    for (const step of steps) {
      const missing = (step.requires as string[]).find((name) => !available.has(name))
      if (missing)
        throw new Error(`IMPLEMENTATION_LOGIC_PRODUCER_MISSING: ${String(step.id)}.${missing}`)
      for (const name of step.produces as string[]) available.add(name)
    }
    const unproduced = texts(path.outputs)
      ? (path.outputs as string[]).find((name) => !available.has(name))
      : undefined
    if (unproduced) throw new Error(`IMPLEMENTATION_LOGIC_OUTPUT_UNPRODUCED: ${id}.${unproduced}`)
  }
  const pending = new Map([...edges].map(([id, producers]) => [id, producers.size]))
  const ready = [...pending].filter(([, count]) => count === 0).map(([id]) => id)
  for (let index = 0; index < ready.length; index++)
    for (const [consumer, producers] of edges)
      if (producers.has(ready[index]!)) {
        const count = pending.get(consumer)! - 1
        pending.set(consumer, count)
        if (count === 0) ready.push(consumer)
      }
  if (ready.length !== edges.size) throw new Error('IMPLEMENTATION_LOGIC_PATH_CYCLE')
  if (!order.planned) return
  for (const [consumerId, producers] of edges) {
    const consumer = byId.get(consumerId)!
    const consumerBatches = order.batchesOf(
      'requirement_ids',
      texts(consumer.requirement_ids) ? (consumer.requirement_ids as string[]) : []
    )
    for (const producerId of producers) {
      const producer = byId.get(producerId)!
      const producerBatches = order.batchesOf(
        'requirement_ids',
        texts(producer.requirement_ids) ? (producer.requirement_ids as string[]) : []
      )
      if (!order.landed(producerBatches, consumerBatches))
        throw new Error(
          `IMPLEMENTATION_LOGIC_PRODUCER_AFTER_CONSUMER: ${producerId}->${consumerId}`
        )
    }
  }
  // A path's acceptance may only run once the path, and every path it consumes, has landed.
  for (const path of paths) {
    const requirementBatches = order.batchesOf(
      'requirement_ids',
      texts(path.requirement_ids) ? (path.requirement_ids as string[]) : []
    )
    const producerBatches = [...edges.get(String(path.id))!].flatMap((producerId) =>
      order.batchesOf(
        'requirement_ids',
        texts(byId.get(producerId)!.requirement_ids)
          ? (byId.get(producerId)!.requirement_ids as string[])
          : []
      )
    )
    for (const acceptanceId of texts(path.acceptance_ids)
      ? (path.acceptance_ids as string[])
      : []) {
      const verifying = order.batchesOf('acceptance_ids', [acceptanceId])
      if (!order.landed([...requirementBatches, ...producerBatches], verifying))
        throw new Error(
          `IMPLEMENTATION_LOGIC_ACCEPTANCE_BEFORE_PRODUCER: ${acceptanceId}@${String(path.id)}`
        )
    }
  }
}

/**
 * A contract that claims convergence must agree with itself: no open lists, stability after the
 * last normative change, one PASS per review lens, and a closed evidenced challenge on every path
 * serving Must-Ship work. Drafts (`IN_REVIEW` or absent) are not constrained here.
 */
export function assertDesignConvergence(contract: Contract): void {
  const convergence = object(contract.design_convergence)
  if (!convergence || convergence.status !== 'CONVERGED') return
  for (const key of CONVERGENCE_OPEN_LISTS)
    if (!Array.isArray(convergence[key]) || (convergence[key] as unknown[]).length)
      throw new Error(`DESIGN_CONVERGENCE_INCONSISTENT: ${key}`)
  if (convergence.stable_after_last_normative_change !== true)
    throw new Error('DESIGN_CONVERGENCE_INCONSISTENT: stable_after_last_normative_change')
  // The latest pass per lens decides, not any pass: a PASS recorded before a later FAIL is a stale
  // result, and convergence claimed on it would rest on a review the document has since outrun.
  // Earlier entries stay as history; re-running a lens after a fix is how a FAIL is answered.
  const passes = list(convergence.review_passes)
  for (const lens of CONVERGENCE_LENSES) {
    const latest = passes.findLast((pass) => pass.lens === lens)
    if (!latest || latest.result !== 'PASS' || !text(latest.evidence))
      throw new Error(`DESIGN_CONVERGENCE_INCONSISTENT: ${lens}`)
  }
  const mustShip = new Set(
    contract.requirements.filter((req) => req.kind === 'must-ship').map((req) => req.id)
  )
  for (const path of list(object(contract.implementation_logic)?.paths)) {
    const challenges = list(path.challenges)
    if (challenges.some((challenge) => challenge.result !== 'CLOSED'))
      throw new Error(`DESIGN_CONVERGENCE_CHALLENGE_OPEN: ${String(path.id)}`)
    const servesMustShip =
      texts(path.requirement_ids) &&
      (path.requirement_ids as string[]).some((id) => mustShip.has(id))
    if (
      servesMustShip &&
      !challenges.some(
        (challenge) => texts(challenge.evidence) && (challenge.evidence as string[]).length
      )
    )
      throw new Error(`DESIGN_CONVERGENCE_CHALLENGE_REQUIRED: ${String(path.id)}`)
  }
}

/**
 * Writes to shared mechanisms (manifests, lockfiles, workspaces, registries, schemas, CI) name
 * every manager and write point, and each owner must be inside some batch's modification scope.
 */
export function assertSharedMechanismWrites(contract: Contract): void {
  if (contract.shared_mechanism_writes === undefined) return
  if (!Array.isArray(contract.shared_mechanism_writes))
    throw new Error('SHARED_MECHANISM_WRITE_INVALID')
  const authorized = new Set(
    list(object(contract.delivery_plan)?.batches).flatMap((batch) =>
      texts(batch.modification_packages) ? (batch.modification_packages as string[]) : []
    )
  )
  for (const value of contract.shared_mechanism_writes) {
    const write = object(value)
    if (
      !write ||
      !text(write.mechanism) ||
      !text(write.target) ||
      !['managers', 'write_points', 'owners'].every(
        (key) => texts(write[key]) && (write[key] as string[]).length
      )
    )
      throw new Error('SHARED_MECHANISM_WRITE_INVALID')
    const unauthorized = authorized.size
      ? (write.owners as string[]).find((owner) => !authorized.has(owner))
      : undefined
    if (unauthorized) throw new Error(`SHARED_MECHANISM_OWNER_UNAUTHORIZED: ${unauthorized}`)
  }
}
