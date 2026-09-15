import { rolePublicKey } from '../scripts/resource/role-signature'
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { requirementUpdate } from '../scripts/controllers/requirement.controller'

test('deferral registration consumes exact current contract approval and rejects drift without writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'contract-deferral-')),
    sdd = join(root, 'task.md')
  const deferred = {
    owner: 'team',
    trigger: 'next release',
    impact: 'extension delayed',
    approved_by: 'user'
  }
  const base = {
    protocol: 'control-plane/state-v2',
    phase: 'FINAL_VERIFY',
    contract_revision: 'v1',
    revision: 2,
    authority_epoch: 1,
    coordinator_event_keys: { '1': rolePublicKey('token') },
    sdd_fingerprint: createHash('sha256').update('design').digest('hex'),
    coordinator_token_hash: createHash('sha256').update('token').digest('hex'),
    requirements: { XQ01: 'pending' },
    requirement_kinds: { XQ01: 'must-ship' },
    contract: { requirements: [{ id: 'XQ01', kind: 'must-ship', deferred }] }
  }
  const run = () =>
    requirementUpdate(
      sdd,
      'coordinator',
      'FINAL_VERIFY',
      'v1',
      'XQ01',
      'deferred',
      undefined,
      'team',
      'next release',
      'extension delayed',
      'user',
      'token'
    )
  try {
    for (const approval of [
      undefined,
      ...['owner', 'trigger', 'impact', 'approved_by'].map((field) => ({
        ...deferred,
        [field]: 'changed'
      }))
    ]) {
      const before = JSON.stringify({
        ...base,
        contract: { requirements: [{ id: 'XQ01', kind: 'must-ship', deferred: approval }] }
      })
      writeFileSync(sdd, 'design')
      writeFileSync(sdd + '.loop.json', before)
      writeFileSync(sdd + '.events.jsonl', '')
      expect(run).toThrow('DEFERRAL_CONTRACT_')
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(before)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    }
    const before = JSON.stringify(base)
    writeFileSync(sdd + '.loop.json', before)
    writeFileSync(sdd, 'changed design')
    expect(run).toThrow('SDD_SOURCE_CHANGED_REQUIRES_AMEND')
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(before)
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    writeFileSync(sdd, 'design')
    expect(run().status).toBe('deferred')
    const after = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    expect(after.contract).toEqual(base.contract)
    expect(after.requirements.XQ01).toBe('deferred')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
