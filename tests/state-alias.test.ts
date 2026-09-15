import { expect, test } from 'bun:test'
import { decodeState } from '../scripts/resource/state'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('state decoding accepts only native state objects', () => {
  const native = {
    protocol: 'control-plane/state-v2',
    phase: 'IMPLEMENT',
    authority_epoch: 2,
    active_lease: null
  }
  expect(decodeState(native)).toEqual(native)
  expect(() => decodeState({ stage: 'IMPLEMENT' })).toThrow('CONTROL_STATE_PROTOCOL_UNSUPPORTED')
  for (const invalid of [null, [], 'state', undefined])
    expect(() => decodeState(invalid)).toThrow('CONTROL_STATE_INVALID')
})

test('status refuses a non-native state without rewriting files', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdd-state-fields-'))
  const sdd = join(root, 'task.sdd.md')
  try {
    writeFileSync(sdd, '# design')
    const state = JSON.stringify({ stage: 'IMPLEMENT', authorityEpoch: 2 })
    writeFileSync(`${sdd}.loop.json`, state)
    const files = readdirSync(root).sort()
    const result = Bun.spawnSync([
      process.execPath,
      `${import.meta.dir}/../scripts/main.ts`,
      'status',
      '--sdd',
      sdd
    ])
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain('CONTROL_STATE_PROTOCOL_UNSUPPORTED')
    expect(readFileSync(`${sdd}.loop.json`, 'utf8')).toBe(state)
    expect(readFileSync(sdd, 'utf8')).toBe('# design')
    expect(readdirSync(root).sort()).toEqual(files)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
