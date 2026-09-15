import { workspacePath } from '../../utils/workspace-path'

export type OwnerMapping = Readonly<{ root: string; identity: string }>

export function normalizeOwner(value: string, mappings: readonly OwnerMapping[]): string {
  const roots = new Set(
    mappings
      .filter((mapping) => mapping.root === value || mapping.identity === value)
      .map((mapping) => mapping.root)
  )
  if (roots.size > 1) throw new Error('OWNER_MAPPING_AMBIGUOUS')
  return roots.values().next().value ?? value
}

export function assertPathInScope(
  path: string,
  allowedOwners: readonly string[],
  mappings: readonly OwnerMapping[]
): void {
  const normalizedPath = workspacePath(path)
  const allowed = allowedOwners.some((value) => {
    const owner = normalizeOwner(value, mappings)
    if (owner === '.') return true
    const normalized = workspacePath(owner)
    // A scope entry may be an exact file or a package root.  Prefix matching
    // keeps single-package repositories and nested packages equivalent.
    return normalizedPath === normalized || normalizedPath.startsWith(`${normalized}/`)
  })
  if (!allowed) throw new Error('LEASE_SCOPE_DENIED')
}
