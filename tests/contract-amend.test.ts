import { admissionFixture } from './fixtures/admission'
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLoop } from '../scripts/controllers/init.controller'
import { authBootstrap } from '../scripts/controllers/auth-bootstrap.controller'
import { amendContract } from '../scripts/controllers/amend.controller'

test('amend binds document revision and refreshes native requirement definitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'contract-amend-')),
    sdd = join(root, 'sdd.md')
  const doc = (revision: string, ids: string[]) =>
    '<!-- sdd-contract:start -->\n```json\n' +
    JSON.stringify({
      ...admissionFixture().contract,
      revision,
      requirements: ids.map((id) => ({ id, title: id, kind: 'must-ship', acceptance: ['YS01'] }))
    }) +
    '\n```\n<!-- sdd-contract:end -->'
  try {
    writeFileSync(sdd, doc('v1', ['XQ01']))
    initLoop(sdd, 4)
    authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', 'token')
    const before = readFileSync(sdd + '.loop.json'),
      events = readFileSync(sdd + '.events.jsonl')
    writeFileSync(sdd, doc('v1', ['XQ01', 'XQ02']))
    expect(() =>
      amendContract(sdd, 'coordinator', 'DISCOVER', 'v1', sdd, 'v1', 'update', 'token', {
        scopeChangeAuthorized: true,
        scopeChangeReason: 'fixture user approves added requirement'
      })
    ).toThrow('AMEND_CONTRACT_REVISION_REUSED')
    expect(readFileSync(sdd + '.loop.json')).toEqual(before)
    expect(readFileSync(sdd + '.events.jsonl')).toEqual(events)
    writeFileSync(sdd, doc('v2', ['XQ01', 'XQ02']))
    expect(() =>
      amendContract(sdd, 'coordinator', 'DISCOVER', 'v1', sdd, 'v2', 'update', 'token')
    ).toThrow('SCOPE_CHANGE_REQUIRES_USER_AUTHORIZATION')
    expect(readFileSync(sdd + '.loop.json')).toEqual(before)
    expect(readFileSync(sdd + '.events.jsonl')).toEqual(events)
    expect(() =>
      amendContract(sdd, 'coordinator', 'DISCOVER', 'v1', sdd, 'wrong', 'update', 'token', {
        scopeChangeAuthorized: true,
        scopeChangeReason: 'fixture user approves added requirement'
      })
    ).toThrow('AMEND_CONTRACT_REVISION_MISMATCH')
    expect(readFileSync(sdd + '.loop.json')).toEqual(before)
    expect(readFileSync(sdd + '.events.jsonl')).toEqual(events)
    amendContract(sdd, 'coordinator', 'DISCOVER', 'v1', sdd, 'v2', 'update', 'token', {
      scopeChangeAuthorized: true,
      scopeChangeReason: 'fixture user approves added requirement'
    })
    expect(JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))).toMatchObject({
      phase: 'CONTRACT_AMENDED',
      authority_epoch: JSON.parse(before.toString()).authority_epoch,
      requirements: { XQ01: 'pending', XQ02: 'pending' },
      requirement_kinds: { XQ01: 'must-ship', XQ02: 'must-ship' },
      contract_revision: 'v2'
    })
    const amended = readFileSync(sdd + '.loop.json')
    writeFileSync(sdd, doc('v1', ['XQ01', 'XQ02', 'XQ03']))
    expect(() =>
      amendContract(sdd, 'coordinator', 'CONTRACT_AMENDED', 'v2', sdd, 'v1', 'reuse', 'token', {
        scopeChangeAuthorized: true,
        scopeChangeReason: 'fixture scope approval'
      })
    ).toThrow('AMEND_CONTRACT_REVISION_REUSED')
    expect(readFileSync(sdd + '.loop.json')).toEqual(amended)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
