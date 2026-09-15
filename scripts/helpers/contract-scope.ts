import { createHash } from 'node:crypto'
import { canonicalJson } from '../resource/wire/canonical-json'
type Item = Record<string, unknown>
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const object = (value: unknown): Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {}
const sorted = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value as string[])].sort() : []

/** Lineage identity is independent of the mutable route admission. */
export function contractLineageFingerprint(contract: Item): string | null {
  const value = contract.lineage
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? hash(value) : null
}

/** Bind each requirement to its acceptance semantics; package reach is tracked separately. */
export function requirementFingerprints(contract: Item): Record<string, string> {
  if (!Array.isArray(contract.acceptance) || !Array.isArray(contract.requirements))
    throw new Error('CONTRACT_SCOPE_STRUCTURE_REQUIRED')
  const acceptance = new Map((contract.acceptance as Item[]).map((item) => [item.id, item]))
  return Object.fromEntries(
    (contract.requirements as Item[])
      .filter((item) => item.kind !== 'non-goal')
      .map((requirement) => {
        const cases = ((requirement.acceptance ?? []) as string[]).map((id) => {
          const entry = acceptance.get(id)
          if (!entry) throw new Error('REQUIREMENT_ACCEPTANCE_REFERENCE_INVALID')
          const { packages: _packages, ...semantics } = entry
          return semantics
        })
        return [String(requirement.id), hash({ requirement, acceptance: cases })]
      })
  )
}

/** Freeze business scope for future amendments, using native canonical bytes only. */
export function contractScopeSnapshot(contract: Item): Item {
  if (!Array.isArray(contract.acceptance) || !Array.isArray(contract.requirements))
    throw new Error('CONTRACT_SCOPE_STRUCTURE_REQUIRED')
  const semantic = JSON.parse(JSON.stringify(contract)) as Item
  for (const item of semantic.requirements as Item[]) {
    delete item.title
    delete item.status
  }
  for (const item of semantic.acceptance as Item[]) {
    delete object(item.execution).timeout_seconds
    delete object(item.oracle_sensitivity).reason
  }
  const ownership = object(contract.ownership)
  return {
    comparison_policy: 'semantic-scope/v2',
    runtime_removal_metadata_version: 1,
    objective: contract.objective ?? null,
    product: ownership.product ?? null,
    approval_authority: ownership.approval_authority ?? null,
    packages: sorted(ownership.packages),
    requirement_fingerprints: requirementFingerprints(contract),
    semantic_requirement_fingerprints: requirementFingerprints(semantic),
    acceptance_packages: Object.fromEntries(
      (contract.acceptance as Item[]).map((item) => [String(item.id), sorted(item.packages)])
    )
  }
}

/** Compute every changed normative scope component; never guess missing historical authority. */
export function contractScopeDelta(previous: unknown, current: Item): Item {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous))
    return { baseline_missing: true }
  const before = previous as Item,
    delta: Item = {}
  for (const field of ['objective', 'product', 'approval_authority'])
    if (canonicalJson(before[field] ?? null) !== canonicalJson(current[field] ?? null))
      delta[field] = { from: before[field] ?? null, to: current[field] ?? null }
  const oldPackages = sorted(before.packages),
    packages = sorted(current.packages)
  if (canonicalJson(oldPackages) !== canonicalJson(packages))
    delta.packages = {
      added: packages.filter((id) => !oldPackages.includes(id)),
      removed: oldPackages.filter((id) => !packages.includes(id))
    }
  const old = object(before.semantic_requirement_fingerprints),
    next = object(current.semantic_requirement_fingerprints)
  const added = Object.keys(next)
    .filter((id) => !Object.hasOwn(old, id))
    .sort()
  const removed = Object.keys(old)
    .filter((id) => !Object.hasOwn(next, id))
    .sort()
  const changed = Object.keys(next)
    .filter((id) => Object.hasOwn(old, id) && old[id] !== next[id])
    .sort()
  if (added.length || removed.length || changed.length)
    delta.requirements = { added, removed, changed }
  if (
    canonicalJson(before.acceptance_packages ?? null) !== canonicalJson(current.acceptance_packages)
  )
    delta.acceptance_packages = {
      from: before.acceptance_packages ?? null,
      to: current.acceptance_packages
    }
  return delta
}
