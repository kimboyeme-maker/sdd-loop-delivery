import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCommittedAssets, programChildQuiescent } from '../scripts/services/program-evidence'

type Item = Record<string, unknown>

/** A repository holding `files`, committed; returns its path and the commit. */
function repository(files: Record<string, string>): { worktree: string; commit: string } {
  const worktree = mkdtempSync(join(tmpdir(), 'program-evidence-'))
  const git = (...args: string[]) =>
    Bun.spawnSync(
      ['git', '-C', worktree, '-c', 'user.name=fixture', '-c', 'user.email=f@x', ...args],
      { stdout: 'pipe', stderr: 'pipe' }
    )
  Bun.spawnSync(['git', 'init', '-q', worktree])
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(worktree, path, '..'), { recursive: true })
    writeFileSync(join(worktree, path), content)
  }
  git('add', '.')
  git('commit', '-qm', 'fixture')
  const commit = git('rev-parse', 'HEAD').stdout.toString().trim()
  return { worktree, commit }
}

/** The recorded shape of one delivered file, as the handoff freezes it. */
function file(path: string, content: string) {
  return { path, mode: '100644', sha256: createHash('sha256').update(content).digest('hex') }
}

const handoff = (assets: Item) =>
  ({ assets, acceptance_events: { YS01: 'EVT-1' }, candidate_id: 'CAND-1' }) as never

test('a child is quiescent only when no lease, preparation or transaction is open', () => {
  expect(programChildQuiescent({})).toBe(true)
  expect(programChildQuiescent({ active_lease: { lease_id: 'L1' } })).toBe(false)
  // A read-only shard lease still holds a slot, so release must wait for it too.
  expect(programChildQuiescent({ shard_leases: { FV01: { lease_id: 'L2' } } })).toBe(false)
  expect(programChildQuiescent({ preparation: { prepared_id: 'P1' } })).toBe(false)
  expect(programChildQuiescent({ pending_transaction: true })).toBe(false)
})

test('a handoff missing its reconciliation fields cannot be checked against a commit', () => {
  const { worktree, commit } = repository({ 'value.ts': 'export const value = 1\n' })
  try {
    for (const partial of [
      { acceptance_events: {}, candidate_id: 'C' },
      { assets: {}, candidate_id: 'C' },
      { assets: {}, acceptance_events: {} }
    ])
      expect(() => assertCommittedAssets(worktree, commit, partial as never)).toThrow(
        'PROGRAM_HANDOFF_RECONCILIATION_REQUIRED'
      )
  } finally {
    rmSync(worktree, { recursive: true, force: true })
  }
})

test('committed bytes must equal the frozen asset, path by path', () => {
  const content = 'export const value = 1\n'
  const { worktree, commit } = repository({
    'value.ts': content,
    'other.ts': 'export const x = 2\n'
  })
  try {
    const asset = { path: 'value.ts', files: [file('value.ts', content)] }
    expect(() => assertCommittedAssets(worktree, commit, handoff({ AA: asset }))).not.toThrow()

    // The same path with different recorded bytes is a mismatch, not a near-enough match.
    const drifted = { path: 'value.ts', files: [file('value.ts', 'export const value = 2\n')] }
    expect(() => assertCommittedAssets(worktree, commit, handoff({ AA: drifted }))).toThrow(
      'PROGRAM_ASSET_COMMIT_MISMATCH: value.ts'
    )

    // A path the commit does not carry produces an empty set, which cannot equal a recorded file.
    const absent = { path: 'missing.ts', files: [file('missing.ts', content)] }
    expect(() => assertCommittedAssets(worktree, commit, handoff({ AA: absent }))).toThrow(
      'PROGRAM_ASSET_COMMIT_MISMATCH: missing.ts'
    )
  } finally {
    rmSync(worktree, { recursive: true, force: true })
  }
})

test('a directory asset reconciles every file beneath it', () => {
  const one = 'export const a = 1\n'
  const two = 'export const b = 2\n'
  const { worktree, commit } = repository({ 'dist/a.ts': one, 'dist/b.ts': two })
  try {
    const complete = {
      path: 'dist',
      files: [file('dist/a.ts', one), file('dist/b.ts', two)]
    }
    expect(() => assertCommittedAssets(worktree, commit, handoff({ AA: complete }))).not.toThrow()

    // Recording only part of the directory is a mismatch: the commit carries more than was frozen.
    const partial = { path: 'dist', files: [file('dist/a.ts', one)] }
    expect(() => assertCommittedAssets(worktree, commit, handoff({ AA: partial }))).toThrow(
      'PROGRAM_ASSET_COMMIT_MISMATCH: dist'
    )
  } finally {
    rmSync(worktree, { recursive: true, force: true })
  }
})
