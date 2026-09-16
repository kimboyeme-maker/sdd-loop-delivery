import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertScopeObserved } from '../scripts/helpers/worktree-candidate'

const owners = [
  { root: 'packages/logger', identity: '@migaia/logger', manifest: 'package.json' }
] as const

/** A repository that owns a directory it also ignores, as a docs registry usually is. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'scope-observed-'))
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  writeFileSync(join(root, '.gitignore'), 'docs/\n')
  mkdirSync(join(root, 'docs', 'contracts'), { recursive: true })
  writeFileSync(join(root, 'docs', 'contracts', 'error-codes.md'), '| logger | 14 |\n')
  mkdirSync(join(root, 'packages', 'logger'), { recursive: true })
  writeFileSync(join(root, 'packages', 'logger', 'index.ts'), 'export {}\n')
  return root
}

test('an ignored scope root is rejected while the baseline is still being frozen', () => {
  const root = repository()
  try {
    expect(() => assertScopeObserved(['@migaia/logger'], root, owners)).not.toThrow()
    // A root under an ignored directory contributes nothing to any snapshot, so every write to
    // it would be invisible in the candidate delta.
    expect(() => assertScopeObserved(['@migaia/logger', 'docs/contracts'], root, owners)).toThrow(
      'DISPATCH_SCOPE_NOT_OBSERVED: docs/contracts'
    )
    // Declaring it as a generated path is the fix the message names, at any granularity.
    expect(() =>
      assertScopeObserved(['docs/contracts'], root, owners, ['docs/contracts'])
    ).not.toThrow()
    expect(() =>
      assertScopeObserved(['docs/contracts'], root, owners, ['docs/contracts/error-codes.md'])
    ).not.toThrow()
    expect(() => assertScopeObserved(['docs/contracts'], root, owners, ['docs'])).not.toThrow()
    // An unignored root with no files yet is fine: a packet may exist to create them.
    expect(() => assertScopeObserved(['packages/new-package'], root, owners)).not.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
