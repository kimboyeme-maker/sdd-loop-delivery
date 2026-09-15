import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { findingUpdate } from '../scripts/controllers/finding.controller'
import { rolePublicKey, signRoleEvent } from '../scripts/resource/role-signature'

test('Finding ledger refuses corrupt maps, terminal mutation, inherited IDs and priority changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'finding-boundary-')),
    sdd = join(root, 'task.md')
  const finding = {
    id: 'FX01',
    priority: 'P1',
    status: 'open',
    description: 'Preserve original issue'
  }
  const base = {
    protocol: 'control-plane/state-v2',
    phase: 'COORDINATOR_TRIAGE',
    revision: 2,
    contract_revision: 'v1',
    coordinator_token_hash: createHash('sha256').update('token').digest('hex'),
    findings: { FX01: finding },
    issued_leases: {
      ar: {
        role: 'architect',
        agent_id: 'architect',
        authority_epoch: 1,
        contract_revision: 'v1',
        event_public_key: rolePublicKey('ar')
      }
    }
  }
  const cases: [Record<string, unknown>, string, string, string][] = [
    ...['SHIP', 'CANCELLED', 'PAUSED'].map(
      (phase) =>
        [
          { ...base, phase },
          'FX01',
          'P1',
          phase === 'PAUSED' ? 'LOOP_PAUSED' : 'TERMINAL_STATE_IMMUTABLE'
        ] as [Record<string, unknown>, string, string, string]
    ),
    ...[null, [], false, 'bad'].map(
      (findings) =>
        [{ ...base, findings }, 'FX01', 'P1', 'FINDING_LEDGER_INVALID'] as [
          Record<string, unknown>,
          string,
          string,
          string
        ]
    ),
    ...['toString', 'constructor', '__proto__'].map(
      (id) =>
        [base, id, 'P1', 'UNKNOWN_FINDING'] as [Record<string, unknown>, string, string, string]
    ),
    [base, 'FX01', 'P4', 'FINDING_RESOLUTION_PRIORITY_MISMATCH'],
    [{ ...base, revision: Number.MAX_SAFE_INTEGER }, 'FX01', 'P1', 'CONTROL_REVISION_INVALID']
  ]
  try {
    writeFileSync(sdd, 'design')
    for (const [state, id, priority, error] of cases) {
      const before = JSON.stringify(state),
        log = ''
      writeFileSync(sdd + '.loop.json', before)
      writeFileSync(sdd + '.events.jsonl', log)
      expect(() =>
        findingUpdate(
          sdd,
          'coordinator',
          String(state.phase),
          'v1',
          id,
          priority,
          'resolved',
          'event',
          'token'
        )
      ).toThrow(error)
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(before)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(log)
    }
    const event = signRoleEvent(
      {
        event_id: 'EVT-F',
        role: 'architect',
        type: 'finding',
        actor: { agent_id: 'architect', lease_id: 'ar', authority_epoch: 1 },
        payload: { id: 'FX02', priority: 'P2' }
      },
      'ar'
    )
    writeFileSync(sdd + '.loop.json', JSON.stringify(base))
    writeFileSync(sdd + '.events.jsonl', JSON.stringify(event) + '\n')
    // Without an admission there is no verification scope a Finding could legitimately name.
    expect(() =>
      findingUpdate(
        sdd,
        'coordinator',
        'COORDINATOR_TRIAGE',
        'v1',
        'FX02',
        'P2',
        'open',
        'EVT-F',
        'token'
      )
    ).toThrow('CONTRACT_ADMISSION_GATE_MISSING')
    const after = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    expect(after.findings.FX01).toEqual(finding)
    expect(after.revision).toBe(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
