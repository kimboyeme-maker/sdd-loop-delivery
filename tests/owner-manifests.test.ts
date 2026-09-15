import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotWorktree } from '../scripts/resource/worktree/snapshot'
import { normalizeOwner } from '../scripts/domain/policies/scope'

test('Cargo ownership comes from package.name and Go from its module directive', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-owner-'))
  try {
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0)
    writeFileSync(
      join(root, 'Cargo.toml'),
      '[profile.release]\nname = "decoy"\n[package]\nname = "real-crate"\nversion = "1.0.0"\n'
    )
    writeFileSync(join(root, 'go.mod'), '  module "example.com/module" // owner\n\ngo 1.22\n')
    const owners = snapshotWorktree(root).owners
    expect(owners.map((item) => item.identity)).toEqual(['real-crate', 'example.com/module'])
    writeFileSync(
      join(root, 'Cargo.toml'),
      '[workspace]\nmembers=[]\n[workspace.package]\nname="not-a-package"\n'
    )
    expect(snapshotWorktree(root).owners.some((item) => item.manifest === 'Cargo.toml')).toBe(false)
    expect(() =>
      normalizeOwner('duplicate', [
        { root: 'a', identity: 'duplicate' },
        { root: 'b', identity: 'duplicate' }
      ])
    ).toThrow('OWNER_MAPPING_AMBIGUOUS')
    expect(normalizeOwner('unique', [{ root: 'a', identity: 'unique' }])).toBe('a')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
