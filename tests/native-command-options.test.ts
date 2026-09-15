import { expect, test } from 'bun:test'
import { COMMANDS } from '../scripts/commands/registry'
import { COMMAND_OPTIONS, assertCommandOptions, commandFlags } from '../scripts/commands/options'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('native inventory checker rejects omissions and duplicate options with a legal counterpart', () => {
  const root = mkdtempSync(join(tmpdir(), 'option-inventory-'))
  try {
    mkdirSync(join(root, 'commands'))
    for (const file of [
      'check-command-options.ts',
      'commands/registry.ts',
      'commands/options.ts',
      'commands/options.json'
    ])
      writeFileSync(join(root, file), readFileSync(join(import.meta.dir, '../scripts', file)))
    const run = () => Bun.spawnSync([process.execPath, join(root, 'check-command-options.ts')])
    expect(run().exitCode).toBe(0)
    for (const mutation of [
      (map: Record<string, string[]>) => {
        delete map.init
      },
      (map: Record<string, string[]>) => {
        map.init = ['--sdd', '--sdd']
      },
      (map: Record<string, string[]>) => {
        map.init = ['sdd']
      }
    ]) {
      const map = JSON.parse(JSON.stringify(COMMAND_OPTIONS))
      mutation(map)
      const bytes = JSON.stringify(map)
      writeFileSync(join(root, 'commands/options.json'), bytes)
      expect(run().exitCode).toBe(1)
      expect(readFileSync(join(root, 'commands/options.json'), 'utf8')).toBe(bytes)
    }
    writeFileSync(join(root, 'commands/options.json'), JSON.stringify(COMMAND_OPTIONS))
    expect(run().exitCode).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('alternative inputs reject ambiguity while each individual spelling remains accepted', () => {
  for (const [command, first, second] of [
    ['context-read', '--limit', '--max-bytes'],
    ['validate-draft', '--sdd', '--draft-file'],
    ['operator-receipt-lint', '--receipt', '--payload-file'],
    ['coordinator-preflight', '--runtime-receipt', '--runtime-receipt-file'],
    ['agent-record', '--payload-json', '--payload-file'],
    ['dispatch', '--pipeline-repair-probe-root', '--repair-probe-root']
  ] as const) {
    expect(() => assertCommandOptions(command, [first, 'a', second, 'b'])).toThrow(
      'CLI_OPTIONS_MUTUALLY_EXCLUSIVE'
    )
    expect(() => assertCommandOptions(command, [first, 'a'])).not.toThrow()
    expect(() => assertCommandOptions(command, [second, 'b'])).not.toThrow()
  }
  expect(() => assertCommandOptions('prepare', ['--fresh', '--cancel'])).toThrow(
    'CLI_OPTIONS_MUTUALLY_EXCLUSIVE'
  )
  expect(() => assertCommandOptions('prepare', ['--cancel'])).not.toThrow()
})

test('draft policy is validated before reading file or stdin, and conflicting payloads before file access', () => {
  const run = (args: string[]) =>
    Bun.spawnSync([process.execPath, join(import.meta.dir, '../scripts/main.ts'), ...args], {
      stdin: Buffer.from('# draft')
    })
  for (const prefix of [[], ['--draft-file', '/does-not-exist/draft.md']]) {
    const result = run(['validate-draft', ...prefix, '--design-policy', 'ignore'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain('DOCUMENT_POLICY_INVALID')
  }
  const current = run(['validate-draft', '--design-policy', 'current'])
  expect(current.exitCode).toBe(1)
  expect(current.stderr.toString()).not.toContain('DOCUMENT_POLICY_INVALID')
  const conflict = run([
    'agent-record',
    '--payload-json',
    '{}',
    '--payload-file',
    '/does-not-exist/receipt.json'
  ])
  expect(conflict.exitCode).toBe(2)
  expect(conflict.stderr.toString()).toContain('CLI_OPTIONS_MUTUALLY_EXCLUSIVE')
})

test('native help and option validation cover every command without loading historical flags', () => {
  expect(Object.keys(COMMAND_OPTIONS).sort()).toEqual(COMMANDS.map((item) => item.name).sort())
  expect(commandFlags('init')).toContain('--max-rounds <value>')
  expect(commandFlags('init')).not.toContain('--phase')
  expect(() => assertCommandOptions('init', ['--max-rounds', '-1'])).not.toThrow()
  expect(() => assertCommandOptions('status', ['--compact', '--sdd', 'task.md'])).not.toThrow()
  for (const args of [
    ['--phase', 'IMPLEMENT'],
    ['--agent-id', 'operator'],
    ['--sdd'],
    ['--sdd', '--max-rounds', '4'],
    ['task.md']
  ])
    expect(() => assertCommandOptions('init', args)).toThrow()
})

test('unknown or incomplete options fail before initialization writes either task', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-options-'))
  const sdd = join(root, 'task.md')
  const run = (args: string[]) =>
    Bun.spawnSync([process.execPath, join(import.meta.dir, '../scripts/main.ts'), 'init', ...args])
  try {
    writeFileSync(sdd, '# design')
    for (const tail of [
      ['--unknown', 'yes'],
      ['--agent-id', 'operator'],
      ['--max-rounds'],
      ['extra.md']
    ]) {
      expect(run(['--sdd', sdd, ...tail]).exitCode).toBe(2)
      expect(readdirSync(root)).toEqual(['task.md'])
    }
    const help = run(['--help'])
    expect(help.exitCode).toBe(0)
    expect(help.stdout.toString()).toContain('--max-rounds <value>')
    expect(help.stdout.toString()).not.toContain('historical')
    expect(run(['--sdd', sdd, '--max-rounds', '4']).exitCode).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
