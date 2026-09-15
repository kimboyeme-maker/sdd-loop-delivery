import type { Contract } from '../contract'
import { assertAcceptanceExecution } from './acceptance-execution'
import { assertTestFileName } from './test-naming'
import {
  assertDesignConvergence,
  assertImplementationGraph,
  assertSharedMechanismWrites
} from './delivery-graph'
import { migrationInventory } from './migration-admission'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const texts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(text)

/** Fingerprints a required runtime resolution binds, so resolver drift is detectable. */
const RESOLUTION_FINGERPRINTS = [
  'source_fingerprint',
  'lockfile_fingerprint',
  'tool_runtime_version',
  'workspace_link_fingerprint',
  'resolver_mode'
] as const

/**
 * Authoring rules that are mechanical: the source/runtime inventory split, complete deferral
 * metadata, behavior-named owning tests, and each acceptance case's atomic execution and oracle
 * sensitivity (also checked at admission, reported here while the author can still fix it). They apply to
 * documents that declare `design_detail` (current authoring output); documents accepted under an
 * older schema keep that schema until a normal amendment adopts the current one.
 */
export function assertAuthoringClosure(contract: Contract): void {
  if (!Object.hasOwn(contract, 'design_detail')) return
  const inventory = object(contract.inventory_authorities)
  if (!inventory) throw new Error('CONTRACT_INVENTORY_AUTHORITIES_REQUIRED')
  const source = object(inventory.SOURCE_INVENTORY)
  if (!source || !texts(source.roots) || !text(source.method) || !texts(source.evidence))
    throw new Error('CONTRACT_SOURCE_INVENTORY_INVALID')
  const runtime = object(inventory.RUNTIME_RESOLUTION)
  if (
    !runtime ||
    !text(runtime.reason) ||
    (runtime.applicability === 'REQUIRED'
      ? RESOLUTION_FINGERPRINTS.some((field) => !text(runtime[field]))
      : runtime.applicability !== 'NOT_APPLICABLE')
  )
    throw new Error('CONTRACT_RUNTIME_RESOLUTION_INVALID')
  for (const requirement of contract.requirements as unknown as Item[]) {
    if (requirement.deferred === undefined) continue
    const deferred = object(requirement.deferred)
    if (
      !deferred ||
      ['owner', 'trigger', 'impact', 'approved_by'].some((field) => !text(deferred[field]))
    )
      throw new Error('CONTRACT_DEFERRAL_METADATA_REQUIRED')
    if (requirement.kind === 'must-ship' && deferred.approved_by !== 'user')
      throw new Error('MUST_SHIP_DEFERRAL_REQUIRES_USER')
  }
  const readers = object(contract.migration)?.readers
  for (const reader of Array.isArray(readers) ? readers : [])
    if (text(object(reader)?.owning_test)) assertTestFileName(String(object(reader)!.owning_test))
  // Graph truth, convergence consistency, shared-mechanism scope and migration shape are
  // mechanical, so authors see them at validate instead of at admission.
  assertImplementationGraph(contract)
  assertDesignConvergence(contract)
  assertSharedMechanismWrites(contract)
  migrationInventory(contract)
  if (Array.isArray(contract.acceptance)) assertAcceptanceExecution(contract)
}
