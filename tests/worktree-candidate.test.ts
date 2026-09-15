import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { productSnapshot, assertWorktreeCandidate } from '../scripts/helpers/worktree-candidate'

test('new ignore rules cannot turn a retained baseline file into an accepted deletion', () => {
  const root = mkdtempSync(join(tmpdir(), 'ignore-delta-')),
    sdd = join(root, 'task.md')
  try {
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0)
    writeFileSync(sdd, 'design')
    writeFileSync(join(root, '.gitignore'), '')
    writeFileSync(join(root, 'keep.ts'), 'user work')
    const baseline = productSnapshot(sdd, root)
    writeFileSync(join(root, '.gitignore'), 'keep.ts\n')
    const lease = {
      worktree_root: root,
      worktree_baseline: baseline,
      scope: ['.gitignore', 'keep.ts']
    }
    const changes = [{ path: '.gitignore', action: 'MODIFIED' }]
    const make = (items: unknown[], fingerprint: string) => ({
      changes: items,
      worktree_fingerprint: fingerprint,
      manifest_sha256: createHash('sha256').update(JSON.stringify(items)).digest('hex')
    })
    expect(() =>
      assertWorktreeCandidate(
        sdd,
        lease,
        make(
          [...changes, { path: 'keep.ts', action: 'DELETED' }],
          productSnapshot(sdd, root).fingerprint
        )
      )
    ).toThrow('CANDIDATE_WORKTREE_CHANGED')
    const observed = productSnapshot(
      sdd,
      root,
      baseline.files.map((file) => file.path)
    )
    expect(() =>
      assertWorktreeCandidate(sdd, lease, make(changes, observed.fingerprint))
    ).not.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ignored generated output has a reproducible CLI fingerprint and cannot be omitted from manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'generated-candidate-')),
    sdd = join(root, 'task.md')
  try {
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0)
    writeFileSync(sdd, 'design')
    writeFileSync(join(root, '.gitignore'), 'generated/\n')
    mkdirSync(join(root, 'generated'))
    writeFileSync(join(root, 'generated', 'api.ts'), 'before')
    const baseline = productSnapshot(sdd, root, ['generated'])
    writeFileSync(join(root, 'generated', 'api.ts'), 'after')
    const view = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, '../scripts/main.ts'),
      'worktree-view',
      '--workspace',
      root,
      '--sdd',
      sdd,
      '--generated-path',
      'generated'
    ])
    expect(view.exitCode).toBe(0)
    const fingerprint = JSON.parse(view.stdout.toString()).fingerprint
    expect(fingerprint).toBe(productSnapshot(sdd, root, ['generated']).fingerprint)
    const lease = {
      worktree_root: root,
      worktree_baseline: baseline,
      generated_paths: ['generated'],
      scope: ['generated']
    }
    const candidate = (changes: unknown[]) => ({
      changes,
      worktree_fingerprint: fingerprint,
      manifest_sha256: createHash('sha256').update(JSON.stringify(changes)).digest('hex')
    })
    expect(() => assertWorktreeCandidate(sdd, lease, candidate([]))).toThrow(
      'CANDIDATE_MANIFEST_DELTA_MISMATCH'
    )
    expect(() =>
      assertWorktreeCandidate(
        sdd,
        lease,
        candidate([{ path: 'generated/api.ts', action: 'MODIFIED' }])
      )
    ).not.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('candidate manifest covers lease delta, preserves dirty baseline and excludes only exact sidecars', () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-delta-')),
    sdd = join(root, 'task.md')
  try {
    const init = Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
    expect(init.exitCode).toBe(0)
    writeFileSync(sdd, '# SDD')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'single-package' }))
    writeFileSync(join(root, 'file.ts'), 'user dirty prefix')
    const baseline = productSnapshot(sdd, root)
    writeFileSync(sdd + '.loop.json', 'controller update')
    expect(productSnapshot(sdd, root).fingerprint).toBe(baseline.fingerprint)
    const view = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, '../scripts/main.ts'),
      'worktree-view',
      '--workspace',
      root,
      '--sdd',
      sdd
    ])
    expect(view.exitCode).toBe(0)
    expect(JSON.parse(view.stdout.toString()).fingerprint).toBe(baseline.fingerprint)
    writeFileSync(join(root, 'file.ts'), 'user dirty prefix + implementation')
    const lease = { worktree_root: root, worktree_baseline: baseline, scope: ['single-package'] }
    const candidate = (changes: unknown[]) => ({
      changes,
      worktree_fingerprint: productSnapshot(sdd, root).fingerprint,
      manifest_sha256: createHash('sha256').update(JSON.stringify(changes)).digest('hex')
    })
    expect(() =>
      assertWorktreeCandidate(sdd, lease, candidate([{ path: 'file.ts', action: 'MODIFIED' }]))
    ).not.toThrow()
    expect(() => assertWorktreeCandidate(sdd, lease, candidate([]))).toThrow(
      'CANDIDATE_MANIFEST_DELTA_MISMATCH'
    )
    expect(() =>
      assertWorktreeCandidate(
        sdd,
        { ...lease, scope: ['other.ts'] },
        candidate([{ path: 'file.ts', action: 'MODIFIED' }])
      )
    ).toThrow('LEASE_SCOPE_DENIED')
    const old = candidate([{ path: 'file.ts', action: 'MODIFIED' }])
    writeFileSync(join(root, 'file.ts'), 'later change')
    expect(() => assertWorktreeCandidate(sdd, lease, old)).toThrow('CANDIDATE_WORKTREE_CHANGED')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
