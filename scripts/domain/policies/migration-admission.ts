import type { Contract } from '../contract'
import { assertExecutionPackets } from './execution-packets'
import {
  RUNTIME_REMOVAL_CLAIM_DIMENSIONS,
  READER_INVENTORY_EVIDENCE_KINDS
} from '../../config/constants'

type Item = Record<string, unknown>

/** Read only explicit object fields; malformed optional data is never an empty inventory. */
function object(value: unknown, code: string): Item {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code)
  return value as Item
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function ids(value: unknown, code: string, allowEmpty = false): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && !value.length) ||
    !value.every(text) ||
    new Set(value).size !== value.length
  )
    throw new Error(code)
  return value
}

/** Preserve unique definitions before resolving references, rather than silently overwriting duplicates. */
function inventory(
  value: unknown,
  code: string,
  key = 'id',
  allowEmpty = false
): Map<string, Item> {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new Error(code)
  const result = new Map<string, Item>()
  for (const entry of value) {
    const item = object(entry, code),
      id = item[key]
    if (!text(id) || result.has(id)) throw new Error(code)
    result.set(id, item)
  }
  return result
}

function covers(required: readonly string[], available: Iterable<string>): boolean {
  const set = new Set(available)
  return required.every((id) => set.has(id))
}

/**
 * Validate the product's migration inventory, not a cross-engine compatibility layer.
 * The closed source inventory and runtime-removal oracle remain separate obligations.
 * No filesystem observation is inferred from the declarative inventory itself.
 */
export function migrationInventory(contract: Contract):
  | {
      migration: Item
      surfaces: Map<string, Item>
      readers: Map<string, Item>
      acceptance: Map<string, Item>
    }
  | undefined {
  if (contract.migration_applicability !== 'REQUIRED') {
    if (
      contract.migration_applicability !== undefined &&
      contract.migration_applicability !== 'NOT_APPLICABLE'
    )
      throw new Error('MIGRATION_APPLICABILITY_INVALID')
    return undefined
  }
  const code = 'MIGRATION_CONTRACT_INVALID'
  const migration = object(contract.migration, code)
  ids(migration.inventory_roots, code)
  ids(migration.inventory_evidence, code)
  if (!text(migration.inventory_method) || ids(migration.unknown_readers, code, true).length)
    throw new Error(code)
  const surfaces = inventory(migration.legacy_surfaces, code)
  const readers = inventory(migration.readers, code, 'id', true)
  const acceptance = inventory(contract.acceptance, code)
  const requirementIds = contract.requirements.map((req) => req.id)
  const checkScope = (item: Item) => {
    if (
      !covers(ids(item.requirement_ids, code), requirementIds) ||
      !covers(ids(item.acceptance_ids, code), acceptance.keys())
    )
      throw new Error('MIGRATION_CONTRACT_SCOPE_INVALID')
  }
  for (const surface of surfaces.values()) {
    if (
      !text(surface.owner) ||
      !['REMOVE', 'RETAIN_COMPATIBILITY'].includes(String(surface.final_disposition))
    )
      throw new Error(code)
    ids(surface.symbols, code)
    checkScope(surface)
    if (surface.final_disposition !== 'REMOVE') {
      if (
        surface.zero_reader_acceptance_ids != null &&
        ids(surface.zero_reader_acceptance_ids, code, true).length
      )
        throw new Error(code)
      continue
    }
    const zero = ids(surface.zero_reader_acceptance_ids, code)
    if (!covers(zero, surface.acceptance_ids as string[]))
      throw new Error('MIGRATION_CONTRACT_SCOPE_INVALID')
    for (const id of zero) {
      const entry = acceptance.get(id)!
      const claim = object(entry.claim, code)
      const runtime = RUNTIME_REMOVAL_CLAIM_DIMENSIONS.includes(String(claim.dimension))
      if (claim.quantifier !== 'UNIVERSAL' || (claim.dimension !== 'ARCHITECTURE' && !runtime))
        throw new Error('MIGRATION_ZERO_READER_CLAIM_INVALID')
      ids(claim.universe, 'MIGRATION_ZERO_READER_CLAIM_INVALID')
      if (
        runtime &&
        object(entry.oracle_sensitivity, 'MIGRATION_ZERO_READER_CLAIM_INVALID').applicability !==
          'REQUIRED'
      )
        throw new Error('MIGRATION_ZERO_READER_CLAIM_INVALID')
    }
  }
  const modules = new Set<string>()
  for (const reader of readers.values()) {
    if (
      !['module', 'edge', 'target_owner', 'owning_test'].every((key) => text(reader[key])) ||
      !['MIGRATE', 'REMOVE', 'RETAIN_COMPATIBILITY'].includes(String(reader.disposition))
    )
      throw new Error(code)
    if (modules.has(reader.module as string)) throw new Error('MIGRATION_READER_MODULE_DUPLICATE')
    modules.add(reader.module as string)
    ids(reader.evidence, code)
    checkScope(reader)
    const references = ids(reader.legacy_surface_ids, code)
    if (!covers(references, surfaces.keys())) throw new Error('MIGRATION_CONTRACT_SCOPE_INVALID')
    if (
      reader.disposition === 'RETAIN_COMPATIBILITY' &&
      references.some((id) => surfaces.get(id)!.final_disposition === 'REMOVE')
    )
      throw new Error('MIGRATION_READER_RETAINS_REMOVED_SURFACE')
  }
  // Scan candidates that are not readers keep an explicit reason instead of silently dropping out.
  if (migration.dismissed_candidates !== undefined) {
    if (!Array.isArray(migration.dismissed_candidates))
      throw new Error('MIGRATION_DISMISSED_CANDIDATE_INVALID')
    for (const raw of migration.dismissed_candidates) {
      const candidate =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Item) : undefined
      if (!candidate || !text(candidate.module) || !text(candidate.reason))
        throw new Error('MIGRATION_DISMISSED_CANDIDATE_INVALID')
      if (modules.has(candidate.module)) throw new Error('MIGRATION_DISMISSED_CANDIDATE_IS_READER')
    }
  }
  return { migration, surfaces, readers, acceptance }
}

/**
 * Bind migration inventory, removal probes and every reader to the admitted packet graph.
 * STAGED requires reader migration to precede removal; COORDINATED_ATOMIC instead
 * requires explicit atomicity evidence. Neither mode permits dropping a reader,
 * substituting an inventory scan for a runtime oracle, or changing packet scope.
 */
export function assertMigrationAdmission(contract: Contract, payload: Item): void {
  const source = migrationInventory(contract)
  if (!source) {
    if (payload.migration_closure != null) {
      const closure = object(payload.migration_closure, 'MIGRATION_CLOSURE_NOT_APPLICABLE_INVALID')
      if (closure.applicability !== 'NOT_APPLICABLE' || !text(closure.reason))
        throw new Error('MIGRATION_CLOSURE_NOT_APPLICABLE_INVALID')
    }
    return
  }
  const { migration, surfaces, readers, acceptance } = source
  const closure = object(payload.migration_closure, 'MIGRATION_CLOSURE_REQUIRED')
  if (closure.applicability !== 'REQUIRED') throw new Error('MIGRATION_CLOSURE_REQUIRED')
  if (ids(closure.unresolved_reader_ids, 'MIGRATION_READER_CLOSURE_UNRESOLVED', true).length)
    throw new Error('MIGRATION_READER_CLOSURE_UNRESOLVED')
  if (closure.cutover_mode !== 'STAGED' && closure.cutover_mode !== 'COORDINATED_ATOMIC')
    throw new Error('MIGRATION_CUTOVER_MODE_INVALID')
  const factIds = ids(closure.inventory_fact_ids, 'MIGRATION_INVENTORY_FACTS_REQUIRED')
  const facts = inventory(
    object(payload.fact_closure, 'ADMISSION_FACTS_REQUIRED').facts,
    'ADMISSION_FACTS_REQUIRED'
  )
  if (factIds.some((id) => facts.get(id)?.status !== 'CONFIRMED_PASS'))
    throw new Error('MIGRATION_INVENTORY_FACT_NOT_PASS')
  const early = object(payload.early_falsifier_result, 'MIGRATION_EARLY_FALSIFIER_MISMATCH')
  const assumptions = inventory(payload.assumptions_checked, 'MIGRATION_EARLY_FALSIFIER_MISMATCH')
  const targets = ids(early.target_assumption_ids, 'MIGRATION_EARLY_FALSIFIER_MISMATCH')
  if (
    early.probe_kind !== 'MIGRATION_READER_INVENTORY' ||
    early.method !== migration.inventory_method ||
    !targets.some((id) => assumptions.get(id)?.category === 'MIGRATION_READER_CLOSURE') ||
    !covers(factIds, ids(early.evidence_fact_ids, 'MIGRATION_EARLY_FALSIFIER_MISMATCH'))
  )
    throw new Error('MIGRATION_EARLY_FALSIFIER_MISMATCH')
  assertExecutionPackets(
    payload.execution_packets,
    ids(payload.requirement_ids, 'ADMISSION_REQUIREMENT_SCOPE_INVALID'),
    ids(payload.acceptance_ids, 'ADMISSION_ACCEPTANCE_SCOPE_INVALID')
  )
  const packets = inventory(payload.execution_packets, 'EXECUTION_PACKETS_REQUIRED')
  const removed = [...surfaces]
    .filter(([, surface]) => surface.final_disposition === 'REMOVE')
    .map(([id]) => id)
  const runtime = inventory(
    closure.legacy_runtime_authority,
    'MIGRATION_LEGACY_RUNTIME_AUTHORITY_INVALID',
    'legacy_surface_id',
    true
  )
  if (runtime.size !== removed.length || !covers(removed, runtime.keys()))
    throw new Error('MIGRATION_LEGACY_RUNTIME_AUTHORITY_SCOPE_INVALID')
  for (const [id, review] of runtime) {
    ids(review.evidence, 'MIGRATION_LEGACY_RUNTIME_AUTHORITY_INVALID')
    const surface = surfaces.get(id)!
    const refined = (surface.zero_reader_acceptance_ids as string[]).filter((aid) =>
      RUNTIME_REMOVAL_CLAIM_DIMENSIONS.includes(
        String(object(acceptance.get(aid)!.claim, 'MIGRATION_ZERO_READER_CLAIM_INVALID').dimension)
      )
    )
    const reviewAcceptance =
      review.acceptance_ids == null
        ? []
        : ids(review.acceptance_ids, 'MIGRATION_LEGACY_RUNTIME_ACCEPTANCE_INVALID', true)
    if (refined.length) {
      if (review.applicability !== 'REQUIRED' || !covers(refined, reviewAcceptance))
        throw new Error('MIGRATION_REFINED_ZERO_READER_RUNTIME_PROOF_REQUIRED')
      const covered = factIds.flatMap((factId) => {
        const fact = facts.get(factId)!
        return READER_INVENTORY_EVIDENCE_KINDS.includes(String(fact.evidence_kind))
          ? ids(fact.covered_universe, 'MIGRATION_REFINED_ZERO_READER_INVENTORY_INCOMPLETE', true)
          : []
      })
      if (
        refined.some(
          (aid) =>
            !covers(
              object(acceptance.get(aid)!.claim, 'MIGRATION_ZERO_READER_CLAIM_INVALID')
                .universe as string[],
              covered
            )
        )
      )
        throw new Error('MIGRATION_REFINED_ZERO_READER_INVENTORY_INCOMPLETE')
    }
    if (review.applicability === 'NOT_APPLICABLE') {
      if (!text(review.reason) || reviewAcceptance.length)
        throw new Error('MIGRATION_LEGACY_RUNTIME_NOT_APPLICABLE_INVALID')
      continue
    }
    if (
      review.applicability !== 'REQUIRED' ||
      !['forbidden_behavior', 'probe_method', 'observed_result'].every((key) =>
        text(review[key])
      ) ||
      !['INDEPENDENT_FIXTURE', 'CROSS_IMPLEMENTATION'].includes(
        String(review.oracle_independence)
      ) ||
      !reviewAcceptance.length
    )
      throw new Error('MIGRATION_LEGACY_RUNTIME_PROBE_INVALID')
    if (!covers(reviewAcceptance, surface.acceptance_ids as string[]))
      throw new Error('MIGRATION_LEGACY_RUNTIME_ACCEPTANCE_SCOPE_INVALID')
    for (const aid of reviewAcceptance) {
      const entry = acceptance.get(aid)!
      if (
        !RUNTIME_REMOVAL_CLAIM_DIMENSIONS.includes(
          String(object(entry.claim, 'MIGRATION_LEGACY_RUNTIME_ACCEPTANCE_INVALID').dimension)
        ) ||
        object(entry.oracle_sensitivity, 'MIGRATION_LEGACY_RUNTIME_ACCEPTANCE_INVALID')
          .applicability !== 'REQUIRED'
      )
        throw new Error('MIGRATION_LEGACY_RUNTIME_ACCEPTANCE_INVALID')
    }
  }
  const readerBindings = inventory(
    closure.reader_packet_bindings,
    'MIGRATION_READER_PACKET_BINDING_INVALID',
    'reader_id',
    true
  )
  const removalBindings = inventory(
    closure.removal_packet_bindings,
    'MIGRATION_REMOVAL_PACKET_BINDING_INVALID',
    'legacy_surface_id',
    true
  )
  if (readerBindings.size !== readers.size || !covers([...readers.keys()], readerBindings.keys()))
    throw new Error('MIGRATION_READER_PACKET_SCOPE_INVALID')
  if (removalBindings.size !== removed.length || !covers(removed, removalBindings.keys()))
    throw new Error('MIGRATION_REMOVAL_PACKET_SCOPE_INVALID')
  const packetFor = (binding: Item, code: string): Item => {
    if (!text(binding.packet_id) || !packets.has(binding.packet_id)) throw new Error(code)
    return packets.get(binding.packet_id)!
  }
  // Cache ancestor sets only within this validation; a later admission may change the graph.
  const ancestors = new Map<string, Set<string>>()
  const predecessors = (id: string): Set<string> => {
    const cached = ancestors.get(id)
    if (cached) return cached
    const found = new Set<string>(),
      pending = [...((packets.get(id)!.depends_on_packet_ids ?? []) as string[])]
    while (pending.length) {
      const current = pending.pop()!
      if (found.has(current)) continue
      found.add(current)
      pending.push(...((packets.get(current)!.depends_on_packet_ids ?? []) as string[]))
    }
    ancestors.set(id, found)
    return found
  }
  for (const [id, reader] of readers) {
    const packet = packetFor(readerBindings.get(id)!, 'MIGRATION_READER_PACKET_UNKNOWN')
    if (
      !covers(reader.requirement_ids as string[], packet.requirement_ids as string[]) ||
      !covers(reader.acceptance_ids as string[], packet.acceptance_ids as string[])
    )
      throw new Error('MIGRATION_READER_PACKET_COVERAGE_INVALID')
    for (const surfaceId of reader.legacy_surface_ids as string[]) {
      const removal = removalBindings.get(surfaceId)
      if (!removal) continue
      const target = packetFor(removal, 'MIGRATION_REMOVAL_PACKET_UNKNOWN')
      if (
        closure.cutover_mode === 'STAGED' &&
        (packet.id === target.id || !predecessors(target.id as string).has(packet.id as string))
      )
        throw new Error('MIGRATION_READER_NOT_ORDERED_BEFORE_REMOVAL')
    }
  }
  for (const [id, binding] of removalBindings) {
    const packet = packetFor(binding, 'MIGRATION_REMOVAL_PACKET_UNKNOWN'),
      surface = surfaces.get(id)!
    const runtimeIds = runtime.get(id)!.acceptance_ids ?? []
    if (
      !covers(surface.requirement_ids as string[], packet.requirement_ids as string[]) ||
      !covers(
        [...(surface.zero_reader_acceptance_ids as string[]), ...(runtimeIds as string[])],
        packet.acceptance_ids as string[]
      )
    )
      throw new Error('MIGRATION_REMOVAL_PACKET_COVERAGE_INVALID')
  }
  if (closure.cutover_mode === 'COORDINATED_ATOMIC')
    ids(closure.atomicity_evidence, 'MIGRATION_ATOMICITY_EVIDENCE_REQUIRED')
}
