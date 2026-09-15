import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertUniqueFlags } from '../scripts/helpers/flag'

test('singleton options cannot silently select the first task or identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-duplicates-'))
  const sdd = join(root, 'task.md'),
    other = join(root, 'other.md')
  try {
    writeFileSync(sdd, '# design')
    writeFileSync(other, '# other')
    for (const second of [sdd, other]) {
      const result = Bun.spawnSync([
        process.execPath,
        join(import.meta.dir, '../scripts/main.ts'),
        'init',
        '--sdd',
        sdd,
        '--sdd',
        second
      ])
      expect(result.exitCode).toBe(2)
      expect(result.stderr.toString()).toContain('CLI_OPTION_DUPLICATE:--sdd')
      expect(readdirSync(root).sort()).toEqual(['other.md', 'task.md'])
    }
    expect(() =>
      assertUniqueFlags('dispatch', ['--agent-id', 'first', '--agent-id', 'second'])
    ).toThrow('CLI_OPTION_DUPLICATE:--agent-id')
    expect(() =>
      assertUniqueFlags('dispatch', ['--generated-path', 'a/out', '--generated-path', 'b/out'])
    ).not.toThrow()
    expect(() =>
      assertUniqueFlags('dispatch', ['--package-root', 'a', '--package-root', 'b'])
    ).toThrow()
    const valid = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, '../scripts/main.ts'),
      'init',
      '--sdd',
      sdd
    ])
    expect(valid.exitCode).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
