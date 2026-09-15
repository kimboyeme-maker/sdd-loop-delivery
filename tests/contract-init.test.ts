import { admissionFixture } from './fixtures/admission'
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initLoop } from '../scripts/controllers/init.controller'

test('initialization projects contract requirements without inventing verified evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'contract-init-')),
    sdd = join(root, 'task.md')
  const req = { id: 'XQ01', kind: 'must-ship', title: 'Deliver behavior', status: 'verified' }
  const document = (requirements: unknown[]) =>
    '<!-- sdd-contract:start -->\n```json\n' +
    JSON.stringify({ ...admissionFixture().contract, revision: 'v7', requirements }) +
    '\n```\n<!-- sdd-contract:end -->'
  try {
    writeFileSync(sdd, document([req, req]))
    expect(() => initLoop(sdd, 4)).toThrow('CONTRACT_REQUIREMENT_DUPLICATE')
    expect(readdirSync(root)).toEqual(['task.md'])
    writeFileSync(sdd, document([req]))
    expect(initLoop(sdd, 4)).toMatchObject({
      contract_revision: 'v7',
      requirements: { XQ01: 'pending' },
      requirement_kinds: { XQ01: 'must-ship' }
    })
    const before = readFileSync(sdd + '.loop.json')
    initLoop(sdd, 4)
    expect(readFileSync(sdd + '.loop.json')).toEqual(before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
