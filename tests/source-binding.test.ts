import { transition } from '../scripts/controllers/transition.controller'
import { admissionFixture } from './fixtures/admission'
import { assertCurrentSource } from '../scripts/helpers/source-binding'
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initLoop } from '../scripts/controllers/init.controller'
import { authBootstrap } from '../scripts/controllers/auth-bootstrap.controller'
import { dispatch } from '../scripts/controllers/dispatch.controller'
import { amendContract } from '../scripts/controllers/amend.controller'

test('native source drift blocks dispatch without writes and amendment permits continuation', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-binding-')),
    sdd = join(root, 'task.md')
  try {
    writeFileSync(sdd, admissionFixture('src').source)
    initLoop(sdd, 4)
    authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', 'token')
    const before = readFileSync(sdd + '.loop.json'),
      events = readFileSync(sdd + '.events.jsonl')
    writeFileSync(
      sdd,
      admissionFixture('src').source.replace(
        JSON.stringify({ revision: 'v1' }).slice(1, -1),
        JSON.stringify({ revision: 'v2' }).slice(1, -1)
      ) + '\nUpdated implementation explanation.'
    )
    expect(() =>
      dispatch(
        sdd,
        'coordinator',
        'DISCOVER',
        'v1',
        'operator',
        'operator',
        1,
        5,
        ['src'],
        'work',
        'token',
        { worktreeRoot: root }
      )
    ).toThrow('SDD_SOURCE_CHANGED_REQUIRES_AMEND')
    expect(readFileSync(sdd + '.loop.json')).toEqual(before)
    expect(readFileSync(sdd + '.events.jsonl')).toEqual(events)
    amendContract(sdd, 'coordinator', 'DISCOVER', 'v1', sdd, 'v2', 'source update', 'token')
    const amended = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    expect(() => assertCurrentSource(amended, sdd)).not.toThrow()
    expect(amended.contract_revision).toBe('v2')
    const amendedBytes = readFileSync(sdd + '.loop.json')
    const amendedEvents = readFileSync(sdd + '.events.jsonl')
    expect(() =>
      transition(sdd, 'coordinator', 'CONTRACT_AMENDED', 'v2', 'OPERATOR_READBACK', 'token')
    ).toThrow('CONTRACT_ADMISSION_GATE_MISSING')
    expect(readFileSync(sdd + '.loop.json')).toEqual(amendedBytes)
    expect(readFileSync(sdd + '.events.jsonl')).toEqual(amendedEvents)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
