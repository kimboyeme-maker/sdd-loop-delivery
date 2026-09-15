import { packagesOverlap } from './delivery-plan'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(text) &&
  new Set(value).size === value.length

/** Where a product runs; create-sdd's platform guides close each one's lifecycle and gates. */
export const DELIVERY_PLATFORMS = [
  'web',
  'mini-program',
  'ios',
  'android',
  'flutter',
  'harmonyos',
  'desktop',
  'server',
  'cli',
  'library',
  // A library other apps embed natively: C/C++/Rust core with platform bindings.
  'native-sdk'
] as const
/** Platforms with a user interface; they need an experience contract. */
export const UI_PLATFORMS: ReadonlySet<string> = new Set([
  'web',
  'mini-program',
  'ios',
  'android',
  'flutter',
  'harmonyos',
  'desktop'
])
/** Platforms whose navigation units are page paths or screen IDs rather than URL paths. */
export const APP_PLATFORMS: ReadonlySet<string> = new Set([
  'mini-program',
  'ios',
  'android',
  'flutter',
  'harmonyos',
  'desktop'
])
/** Surfaces a core may feed; `library` is a published programmatic API. */
const ADAPTER_KINDS = new Set(['cli', 'service', 'documents', 'ui', 'worker', 'library'])

/** Validate optional `delivery_platforms`; returns the declared list or null when absent. */
export function assertDeliveryPlatforms(contract: Item): string[] | null {
  if (contract.delivery_platforms === undefined) return null
  const platforms = contract.delivery_platforms
  if (
    !ids(platforms) ||
    platforms.some((platform) => !(DELIVERY_PLATFORMS as readonly string[]).includes(platform))
  )
    throw new Error('DELIVERY_PLATFORMS_INVALID')
  if (contract.product_archetype === undefined) throw new Error('PRODUCT_ARCHETYPE_REQUIRED')
  return platforms
}

export type ArchitectureSummary = Readonly<{
  protocol: 'core-adapters/v1'
  core_packages: string[]
  adapters: number
  kinds: string[]
}>

/**
 * Validate the optional `architecture` projection: one core, thin adapters on disjoint packages,
 * and — when a delivery plan exists — every adapter batch scheduled after every core batch so
 * adapters translate a settled core API instead of racing it.
 */
export function assertArchitecture(contract: Item): ArchitectureSummary | null {
  if (contract.architecture === undefined) return null
  const architecture = object(contract.architecture)
  const core = object(architecture?.core)
  if (!architecture || architecture.protocol !== 'core-adapters/v1' || !core || !ids(core.packages))
    throw new Error('ARCHITECTURE_INVALID')
  const corePackages = core.packages as string[]
  const adapters = Array.isArray(architecture.adapters) ? architecture.adapters.map(object) : []
  if (!adapters.length) throw new Error('ARCHITECTURE_ADAPTERS_REQUIRED')
  const seen = new Set<string>()
  const adapterPackages: string[] = []
  for (const adapter of adapters) {
    if (
      !adapter ||
      !text(adapter.id) ||
      seen.has(adapter.id) ||
      !ADAPTER_KINDS.has(String(adapter.kind)) ||
      !ids(adapter.packages)
    )
      throw new Error('ARCHITECTURE_ADAPTER_INVALID')
    seen.add(adapter.id)
    for (const path of adapter.packages as string[]) {
      if (corePackages.some((corePath) => packagesOverlap(corePath, path)))
        throw new Error(`ARCHITECTURE_CORE_ADAPTER_OVERLAP: ${adapter.id}`)
      if (adapterPackages.some((other) => packagesOverlap(other, path)))
        throw new Error(`ARCHITECTURE_ADAPTER_OVERLAP: ${adapter.id}`)
      adapterPackages.push(path)
    }
  }
  const plan = object(contract.delivery_plan)
  if (plan && Array.isArray(plan.batches)) {
    const batches = plan.batches.map(object).filter((batch): batch is Item => !!batch)
    const depends = new Map(
      batches.map((batch) => [String(batch.id), (batch.depends_on ?? []) as string[]])
    )
    const ancestors = (id: string, found = new Set<string>()): Set<string> => {
      for (const dependency of depends.get(id) ?? [])
        if (!found.has(dependency)) {
          found.add(dependency)
          ancestors(dependency, found)
        }
      return found
    }
    const writes = (batch: Item, roots: readonly string[]) =>
      ((batch.modification_packages ?? []) as string[]).some((path) =>
        roots.some((root) => packagesOverlap(root, path))
      )
    const coreBatches = batches
      .filter((batch) => writes(batch, corePackages))
      .map((b) => String(b.id))
    for (const batch of batches) {
      const id = String(batch.id)
      if (coreBatches.includes(id) || !writes(batch, adapterPackages)) continue
      const before = ancestors(id)
      if (coreBatches.some((coreId) => !before.has(coreId)))
        throw new Error(`ARCHITECTURE_ADAPTER_BEFORE_CORE: ${id}`)
    }
  }
  return {
    protocol: 'core-adapters/v1',
    core_packages: corePackages,
    adapters: adapters.length,
    kinds: [...new Set(adapters.map((adapter) => String(adapter!.kind)))]
  }
}
