import { test, expect } from 'bun:test'
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  chmodSync,
  mkdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotWorktree } from '../scripts/resource/worktree/snapshot'

test('batched ignored paths preserve complete deterministic fingerprints', () => {
  const root = mkdtempSync(join(tmpdir(), 'batched-generated-'))
  try {
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0)
    writeFileSync(join(root, '.gitignore'), 'generated/\n')
    mkdirSync(join(root, 'generated'))
    const paths = Array.from({ length: 260 }, (_, index) => `generated/${index}.txt`)
    for (const path of paths) writeFileSync(join(root, path), path)
    const individual = snapshotWorktree(root, [], [...paths, ...paths])
    const directory = snapshotWorktree(root, [], ['generated'])
    expect(individual.fingerprint).toBe(directory.fingerprint)
    expect(individual.files.filter((file) => file.path.startsWith('generated/')).length).toBe(260)
    expect(snapshotWorktree(root, [], paths.toReversed()).fingerprint).toBe(directory.fingerprint)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('declared generated paths include ignored bytes without treating path names as patterns', () => {
  const root = mkdtempSync(join(tmpdir(), 'generated-bytes-'))
  try {
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0)
    writeFileSync(join(root, '.gitignore'), 'generated/\ncache/\n')
    mkdirSync(join(root, 'generated'))
    mkdirSync(join(root, 'cache'))
    writeFileSync(join(root, 'generated', 'out.ts'), 'first')
    writeFileSync(join(root, 'cache', 'ignored.txt'), 'cache')
    const first = snapshotWorktree(root, [], ['generated'])
    expect(first.files.some((file) => file.path === 'generated/out.ts')).toBe(true)
    expect(first.files.some((file) => file.path === 'cache/ignored.txt')).toBe(false)
    writeFileSync(join(root, 'generated', 'out.ts'), 'second')
    expect(snapshotWorktree(root, [], ['generated']).fingerprint).not.toBe(first.fingerprint)
    expect(
      snapshotWorktree(root, [], ['*']).files.some((file) => file.path === 'generated/out.ts')
    ).toBe(false)
    unlinkSync(join(root, 'generated', 'out.ts'))
    expect(
      snapshotWorktree(root, [], ['generated']).files.some(
        (file) => file.path === 'generated/out.ts'
      )
    ).toBe(false)
    expect(() => snapshotWorktree(root, [], ['../outside'])).toThrow('WORKSPACE_PATH_INVALID')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('worktree fingerprint binds dirty bytes, mode, deletion and dangling symlink target', () => {
  const root = mkdtempSync(join(tmpdir(), 'worktree-bytes-'))
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: root })
    if (r.exitCode) throw Error(r.stderr.toString())
  }
  try {
    git('init', '-q')
    writeFileSync(join(root, 'file.txt'), 'base')
    git('add', 'file.txt')
    writeFileSync(join(root, 'file.txt'), 'first')
    const first = snapshotWorktree(root)
    writeFileSync(join(root, 'file.txt'), 'other')
    const second = snapshotWorktree(root)
    expect(second.changes).toEqual(first.changes)
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(snapshotWorktree(root).fingerprint).toBe(second.fingerprint)
    chmodSync(join(root, 'file.txt'), 0o755)
    expect(snapshotWorktree(root).fingerprint).not.toBe(second.fingerprint)
    unlinkSync(join(root, 'file.txt'))
    expect(snapshotWorktree(root).files[0]?.kind).toBe('missing')
    symlinkSync('missing-one', join(root, 'file.txt'))
    const link = snapshotWorktree(root)
    expect(link.files[0]?.kind).toBe('symlink')
    unlinkSync(join(root, 'file.txt'))
    symlinkSync('missing-two', join(root, 'file.txt'))
    expect(snapshotWorktree(root).fingerprint).not.toBe(link.fingerprint)
    unlinkSync(join(root, 'file.txt'))
    mkdirSync(join(root, 'file.txt'))
    writeFileSync(join(root, 'file.txt', 'nested'), 'one')
    const directory = snapshotWorktree(root)
    writeFileSync(join(root, 'file.txt', 'nested'), 'two')
    expect(snapshotWorktree(root).fingerprint).not.toBe(directory.fingerprint)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('replaced directory never hashes descendants through a symlink or adopts linked manifests', () => {
  const root = mkdtempSync(join(tmpdir(), 'worktree-ancestor-'))
  const outside = mkdtempSync(join(tmpdir(), 'worktree-external-'))
  try {
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'file.txt'), 'baseline')
    expect(Bun.spawnSync(['git', 'add', '.'], { cwd: root }).exitCode).toBe(0)
    writeFileSync(join(outside, 'file.txt'), 'external-one')
    writeFileSync(join(outside, 'package.json'), '{"name":"external-owner"}')
    rmSync(join(root, 'src'), { recursive: true })
    symlinkSync(outside, join(root, 'src'))
    symlinkSync(join(outside, 'package.json'), join(root, 'package.json'))
    const snapshot = snapshotWorktree(root)
    expect(snapshot.files.find((file) => file.path === 'src/file.txt')?.kind).toBe('missing')
    expect(snapshot.files.find((file) => file.path === 'src')?.kind).toBe('symlink')
    expect(snapshot.owners).toEqual([])
    writeFileSync(join(outside, 'file.txt'), 'external-two')
    writeFileSync(join(outside, 'package.json'), '{"name":"changed-external-owner"}')
    expect(snapshotWorktree(root).fingerprint).toBe(snapshot.fingerprint)
    unlinkSync(join(root, 'src'))
    writeFileSync(join(root, 'src'), 'directory replaced by regular file')
    const regular = snapshotWorktree(root)
    expect(regular.files.find((file) => file.path === 'src/file.txt')?.kind).toBe('missing')
    expect(regular.files.find((file) => file.path === 'src')?.kind).toBe('file')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
