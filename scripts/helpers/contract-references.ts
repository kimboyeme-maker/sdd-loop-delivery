import { existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { Contract } from '../domain/contract'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** A local Markdown reference, optionally with an anchor; URLs and prose are not references. */
const LOCAL_DOCUMENT = /^(?![a-z][a-z0-9+.-]*:)([^\s#]+\.md)(?:#\S*)?$/i

/** Nearest ancestor holding `.git`, else the SDD directory; references never escape it. */
function repositoryRoot(sdd: string): string {
  let cursor = dirname(resolve(sdd))
  while (true) {
    if (existsSync(resolve(cursor, '.git'))) return cursor
    const parent = dirname(cursor)
    if (parent === cursor) return dirname(resolve(sdd))
    cursor = parent
  }
}

/**
 * Resolve the contract's path-like references by kind. A document or source reference must
 * exist inside the repository; an external reference must carry a URL; evidence strings that
 * name a local Markdown file must point at an existing file next to or under the SDD's root.
 * Draft overlays supply documents that do not exist on disk yet.
 */
export function assertContractReferences(
  contract: Contract,
  sdd: string,
  overlay: readonly string[] = []
): void {
  const root = repositoryRoot(sdd)
  const pending = new Set(overlay.map((path) => resolve(path)))
  const exists = (path: string, base: string) => {
    const target = resolve(base, path)
    const rel = relative(root, target)
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      throw new Error(`CONTRACT_REFERENCE_ESCAPES_ROOT: ${path}`)
    if (!existsSync(target) && !pending.has(target))
      throw new Error(`CONTRACT_REFERENCE_NOT_FOUND: ${path}`)
  }
  const productContract = object(contract.experience_contract)?.product_contract
  const typed = object(productContract)
  if (typed) {
    if (typed.kind === 'external') {
      if (typeof typed.url !== 'string' || !/^https?:\/\//.test(typed.url))
        throw new Error('CONTRACT_REFERENCE_INVALID: product_contract')
    } else if (typed.kind === 'document' || typed.kind === 'source') {
      const paths = strings(typed.paths)
      if (!paths.length) throw new Error('CONTRACT_REFERENCE_INVALID: product_contract')
      for (const path of paths) exists(path, root)
    } else throw new Error('CONTRACT_REFERENCE_INVALID: product_contract')
  }
  const evidence = [
    ...strings(object(contract.migration)?.inventory_evidence),
    ...strings(object(object(contract.inventory_authorities)?.SOURCE_INVENTORY)?.evidence),
    ...(Array.isArray(object(contract.implementation_logic)?.paths)
      ? (object(contract.implementation_logic)!.paths as unknown[]).flatMap((path) =>
          (Array.isArray(object(path)?.challenges)
            ? (object(path)!.challenges as unknown[])
            : []
          ).flatMap((challenge) => strings(object(challenge)?.evidence))
        )
      : [])
  ]
  for (const entry of evidence) {
    const match = LOCAL_DOCUMENT.exec(entry.trim())
    if (match) exists(match[1]!, dirname(resolve(sdd)))
  }
}
