import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admissionFixture } from './fixtures/admission'
import { initLoop } from '../scripts/controllers/init.controller'
import { authBootstrap } from '../scripts/controllers/auth-bootstrap.controller'
import { requirementUpdate } from '../scripts/controllers/requirement.controller'
import { verifyCoordinatorProof } from '../scripts/resource/coordinator-evidence'

test('approved deferral produces public evidence and rejects altered approval without writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'deferral-proof-'))
  try {
    const sdd = join(root, 'task.md'),
      fixture = admissionFixture(),
      token = 'isolated-proof'
    const revised = structuredClone(fixture.contract)
    Object.assign(revised.requirements[0]!, {
      deferred: {
        owner: 'maintainer',
        trigger: 'next release',
        impact: 'delay',
        approved_by: 'user'
      }
    })
    writeFileSync(
      sdd,
      fixture.source.replace(JSON.stringify(fixture.contract), JSON.stringify(revised))
    )
    initLoop(sdd, 4)
    authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', token)
    const before = readFileSync(sdd + '.loop.json', 'utf8'),
      beforeEvents = readFileSync(sdd + '.events.jsonl', 'utf8')
    expect(() =>
      requirementUpdate(
        sdd,
        'coordinator',
        'DISCOVER',
        'v1',
        'XQ01',
        'deferred',
        undefined,
        'other',
        'next release',
        'delay',
        'user',
        token
      )
    ).toThrow('METADATA_MISMATCH')
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(before)
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(beforeEvents)
    requirementUpdate(
      sdd,
      'coordinator',
      'DISCOVER',
      'v1',
      'XQ01',
      'deferred',
      undefined,
      'maintainer',
      'next release',
      'delay',
      'user',
      token
    )
    const state = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    const event = JSON.parse(
      readFileSync(sdd + '.events.jsonl', 'utf8')
        .trim()
        .split('\n')
        .at(-1)!
    )
    expect(verifyCoordinatorProof(state, event)).toBe(true)
    event.payload.deferred.approved_by = 'coordinator'
    expect(verifyCoordinatorProof(state, event)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

import { assertShip } from '../scripts/domain/policies/ship'
test('all approved deferrals do not invent an effective work obligation', () => {
  const deferred = {
    owner: 'maintainer',
    trigger: 'next release',
    impact: 'delay',
    approvedBy: 'user'
  }
  expect(() =>
    assertShip([{ id: 'XQ01', kind: 'must-ship', status: 'deferred', deferred }], 'candidate')
  ).not.toThrow()
  expect(() =>
    assertShip([{ id: 'XQ01', kind: 'must-ship', status: 'pending' }], 'candidate')
  ).toThrow('UNVERIFIED')
  expect(() =>
    assertShip(
      [
        {
          id: 'XQ01',
          kind: 'must-ship',
          status: 'deferred',
          deferred: { ...deferred, approvedBy: 'coordinator' }
        }
      ],
      'candidate'
    )
  ).toThrow()
  expect(() => assertShip([], 'candidate')).toThrow('EMPTY')
})
