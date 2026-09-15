import { rolePublicKey } from '../scripts/resource/role-signature'
import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requirementUpdate } from '../scripts/controllers/requirement.controller'

test('requirement writes reject terminal phases, inherited IDs and invalid revisions without mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'requirement-boundary-')),
    sdd = join(root, 'task.md')
  const base = {
    protocol: 'control-plane/state-v2',
    phase: 'IMPLEMENTING',
    revision: 2,
    contract_revision: 'v1',
    authority_epoch: 3,
    coordinator_event_keys: { '3': rolePublicKey('token') },
    coordinator_token_hash: createHash('sha256').update('token').digest('hex'),
    requirements: { XQ01: 'pending', XQ02: 'verified' },
    requirement_kinds: { XQ01: 'must-ship', XQ02: 'should' },
    attempts: 4,
    findings: {},
    pending_pipeline_repair: { id: 'incident' }
  }
  const run = (phase: string, id = 'XQ01') =>
    requirementUpdate(
      sdd,
      'coordinator',
      phase,
      'v1',
      id,
      'in-progress',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'token'
    )
  try {
    writeFileSync(sdd, 'design')
    const cases: [Record<string, unknown>, string, string][] = [
      ...['SHIP', 'CANCELLED', 'PAUSED', 'unknown'].map(
        (phase) =>
          [
            { ...base, phase },
            'XQ01',
            phase === 'PAUSED'
              ? 'LOOP_PAUSED'
              : phase === 'unknown'
                ? 'REQUIREMENT_PHASE_FORBIDDEN'
                : 'TERMINAL_STATE_IMMUTABLE'
          ] as [Record<string, unknown>, string, string]
      ),
      ...[null, '2', -1, 1.5, Number.MAX_SAFE_INTEGER].map(
        (revision) =>
          [{ ...base, revision }, 'XQ01', 'CONTROL_REVISION_INVALID'] as [
            Record<string, unknown>,
            string,
            string
          ]
      ),
      ...['constructor', 'toString', '__proto__', 'XQ99'].map(
        (id) => [base, id, 'UNKNOWN_REQUIREMENT'] as [Record<string, unknown>, string, string]
      )
    ]
    for (const [state, id, error] of cases) {
      const before = JSON.stringify(state),
        log = JSON.stringify({ event_id: 'prior', type: 'fixture' }) + '\n'
      writeFileSync(sdd + '.loop.json', before)
      writeFileSync(sdd + '.events.jsonl', log)
      expect(() => run(String(state.phase), id)).toThrow(error)
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(before)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(log)
    }
    writeFileSync(sdd + '.loop.json', JSON.stringify(base))
    writeFileSync(sdd + '.events.jsonl', '')
    expect(run('IMPLEMENTING').status).toBe('in-progress')
    const after = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    expect(after).toEqual({
      ...base,
      revision: 3,
      event_log: after.event_log,
      requirement_evidence: {},
      requirements: { ...base.requirements, XQ01: 'in-progress' }
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
