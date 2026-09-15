import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { sidecarPaths } from '../resource/state'
import { snapshotWorktree, type WorktreeSnapshot } from '../resource/worktree/snapshot'
import { workspacePath } from '../utils/workspace-path'
import { assertPathInScope, normalizeOwner } from '../domain/policies/scope'

/** Exclude only this controller's exact sidecars, never arbitrary product files by suffix. */
export function productSnapshot(
  sdd: string,
  root: string,
  generatedPaths: readonly string[] = []
): WorktreeSnapshot {
  const snapshot = snapshotWorktree(
    root,
    Object.values(sidecarPaths(sdd)).map((path) => relative(root, path)),
    generatedPaths
  )
  // Another SDD's controller state here would enter every delta; parallel SDDs need
  // their own worktrees, so reject it by name instead of a later manifest mismatch.
  const foreign = snapshot.files.find(
    (file) => file.kind !== 'missing' && file.path.endsWith('.loop.json')
  )
  if (foreign)
    throw new Error(
      `WORKTREE_FOREIGN_CONTROLLER_STATE: ${foreign.path} (run each SDD in its own worktree)`
    )
  return snapshot
}

/**
 * Admitted packages actually touched by a delta: each path belongs to the most specific
 * admitted package root containing it. Claims are compared with this, never trusted alone.
 */
export function deltaPackages(
  delta: ReadonlyMap<string, string>,
  admitted: readonly string[],
  owners: WorktreeSnapshot['owners']
): string[] {
  const touched = new Set<string>()
  for (const path of delta.keys()) {
    let best: { name: string; length: number } | undefined
    for (const name of admitted) {
      const root = normalizeOwner(name, owners)
      const length = root === '.' ? 0 : root.length
      if (root !== '.' && path !== root && !path.startsWith(`${root}/`)) continue
      if (!best || length > best.length) best = { name, length }
    }
    if (best) touched.add(best.name)
  }
  return [...touched].sort()
}

/** Current product snapshot observed under a lease's frozen baseline and generated paths. */
export function leaseSnapshot(
  sdd: string,
  lease: Record<string, unknown>
): WorktreeSnapshot | null {
  const baseline = lease.worktree_baseline as WorktreeSnapshot | undefined
  if (!baseline || typeof lease.worktree_root !== 'string') return null
  const generated = Array.isArray(lease.generated_paths) ? (lease.generated_paths as string[]) : []
  return productSnapshot(sdd, lease.worktree_root, [
    ...new Set([...generated, ...baseline.files.map((file) => file.path)])
  ])
}

/** Current product fingerprint observed under a lease's frozen baseline and generated paths. */
export function leaseWorktreeFingerprint(
  sdd: string,
  lease: Record<string, unknown>
): string | null {
  return leaseSnapshot(sdd, lease)?.fingerprint ?? null
}

/** Validate the complete lease delta against a candidate manifest and frozen owner mapping. */
export function assertWorktreeCandidate(
  sdd: string,
  lease: Record<string, unknown>,
  candidate: Record<string, unknown>
): ReadonlyMap<string, string> {
  const baseline = lease.worktree_baseline as WorktreeSnapshot | undefined
  if (!baseline || typeof lease.worktree_root !== 'string')
    throw new Error('CANDIDATE_BASELINE_REQUIRED')
  const generated = lease.generated_paths
  if (
    generated !== undefined &&
    (!Array.isArray(generated) || generated.some((path) => typeof path !== 'string'))
  )
    throw new Error('CANDIDATE_GENERATED_PATHS_INVALID')
  // Ignore rules may change during implementation. Keep observing every baseline path
  // so a newly ignored existing file cannot masquerade as a deletion.
  const observed = [
    ...new Set([
      ...((generated as string[] | undefined) ?? []),
      ...baseline.files.map((file) => file.path)
    ])
  ]
  const current = productSnapshot(sdd, lease.worktree_root, observed)
  if (candidate.worktree_fingerprint !== current.fingerprint)
    throw new Error('CANDIDATE_WORKTREE_CHANGED')
  if (!Array.isArray(candidate.changes) || !Array.isArray(lease.scope))
    throw new Error('CANDIDATE_MANIFEST_REQUIRED')
  if (
    candidate.manifest_sha256 !==
    createHash('sha256').update(JSON.stringify(candidate.changes)).digest('hex')
  )
    throw new Error('CANDIDATE_MANIFEST_HASH_MISMATCH')
  const before = new Map(baseline.files.map((file) => [file.path, file]))
  const after = new Map(current.files.map((file) => [file.path, file]))
  const delta = new Map<string, string>()
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(path),
      b = after.get(path)
    const aExists = a && a.kind !== 'missing',
      bExists = b && b.kind !== 'missing'
    if (!aExists && !bExists) continue
    if (a?.kind === b?.kind && a?.mode === b?.mode && a?.sha256 === b?.sha256) continue
    delta.set(path, !aExists ? 'CREATED' : !bExists ? 'DELETED' : 'MODIFIED')
  }
  const reported = new Map<string, string>()
  const add = (path: unknown, action: string) => {
    if (typeof path !== 'string') throw new Error('CANDIDATE_MANIFEST_INVALID')
    const normalized = workspacePath(path)
    if (reported.has(normalized)) throw new Error('CANDIDATE_MANIFEST_DUPLICATE')
    assertPathInScope(normalized, lease.scope as string[], baseline.owners)
    reported.set(normalized, action)
  }
  for (const value of candidate.changes) {
    if (!value || typeof value !== 'object') throw new Error('CANDIDATE_MANIFEST_INVALID')
    const change = value as Record<string, unknown>
    if (change.action === 'RENAMED') {
      add(change.from_path, 'DELETED')
      add(change.to_path, 'CREATED')
    } else add(change.path, String(change.action))
  }
  if (
    delta.size !== reported.size ||
    [...delta].some(([path, action]) => reported.get(path) !== action)
  )
    throw new Error('CANDIDATE_MANIFEST_DELTA_MISMATCH')
  return delta
}
