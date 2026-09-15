import { admissionFixture } from './fixtures/admission'
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLoop } from '../scripts/controllers/init.controller'
import { authBootstrap } from '../scripts/controllers/auth-bootstrap.controller'

test('bootstrap rejects malformed authority without repairing or overwriting it', () => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-boundary-'))
  const sdd = join(root, 'task.md')
  try {
    writeFileSync(sdd, admissionFixture().source)
    const initial = initLoop(sdd, 4)
    const events = readFileSync(sdd + '.events.jsonl')
    const patches: Record<string, unknown>[] = []
    for (const key of ['authority_epoch', 'revision'])
      for (const value of [undefined, null, '1', false, 0, -1, 1.5, Number.MAX_SAFE_INTEGER])
        patches.push({ [key]: value })
    for (const value of ['', null, false, 'existing'])
      patches.push({ coordinator_token_hash: value })
    patches.push({ phase: 'SHIP' }, { phase: 'PAUSED' }, { preparation: { prepared_id: 'prep' } })
    for (const patch of patches) {
      const state = { ...initial, ...patch }
      const bytes = JSON.stringify(state)
      writeFileSync(sdd + '.loop.json', bytes)
      const files = readdirSync(root).sort()
      expect(() => authBootstrap(sdd, String(state.phase), 'v1', 'yes', 'token')).toThrow()
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(bytes)
      expect(readFileSync(sdd + '.events.jsonl')).toEqual(events)
      expect(readdirSync(root).sort()).toEqual(files)
    }
    writeFileSync(sdd + '.loop.json', JSON.stringify(initial))
    writeFileSync(sdd, '# changed design')
    // Source drift cannot be legitimized by initializing authority.
    expect(() => authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', 'token')).toThrow(
      'SDD_SOURCE_CHANGED_REQUIRES_AMEND'
    )
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(JSON.stringify(initial))
    expect(readFileSync(sdd + '.events.jsonl')).toEqual(events)
    writeFileSync(sdd, admissionFixture().source)
    authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', 'token')
    const valid = readFileSync(sdd + '.loop.json', 'utf8')
    const log = readFileSync(sdd + '.events.jsonl')
    expect(JSON.parse(valid)).toMatchObject({
      sdd_fingerprint: initial.sdd_fingerprint,
      authority_epoch: 2,
      revision: 2,
      completed_attempts: 0,
      total_execution_failures: 0
    })
    expect(() => authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', 'replacement')).toThrow(
      'COORDINATOR_AUTH_ALREADY_INITIALIZED'
    )
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(valid)
    expect(readFileSync(sdd + '.events.jsonl')).toEqual(log)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
