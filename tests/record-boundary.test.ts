import { rolePublicKey } from '../scripts/resource/role-signature'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordEvent } from '../scripts/controllers/record.controller'

test('generic records cannot mint dedicated control or product evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'record-boundary-')),
    sdd = join(root, 'sdd.md')
  try {
    writeFileSync(sdd, '# fixture')
    const state = JSON.stringify({
      protocol: 'control-plane/state-v2',
      phase: 'DISCOVER',
      revision: 1,
      authority_epoch: 1,
      coordinator_event_keys: { '1': rolePublicKey('token') },
      contract_revision: 'v1',
      coordinator_token_hash: createHash('sha256').update('token').digest('hex')
    })
    writeFileSync(sdd + '.loop.json', state)
    writeFileSync(sdd + '.events.jsonl', '')
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(state)
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    for (const type of [
      'recovery',
      'coordinator_identity',
      'requirement_status',
      'verification',
      'design_proposal',
      'dispatch',
      'user_decision',
      'pipeline_failure',
      'contract_amendment'
    ]) {
      expect(() =>
        recordEvent(sdd, 'coordinator', 'DISCOVER', 'v1', type, { note: 'forged route' }, 'token')
      ).toThrow('DEDICATED_EVENT_COMMAND_REQUIRED')
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(state)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    }
    expect(
      recordEvent(
        sdd,
        'coordinator',
        'DISCOVER',
        'v1',
        'coordination_note',
        { note: 'ordinary observation' },
        'token'
      ).type
    ).toBe('coordination_note')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
