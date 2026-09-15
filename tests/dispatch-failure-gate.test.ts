import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatch } from '../scripts/controllers/dispatch.controller'

test('pending execution failures deny product dispatch but permit a bound scope-free pipeline probe', () => {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-failure-gate-')),
    sdd = join(root, 'sdd.md')
  const initial = {
    protocol: 'control-plane/state-v2',
    sdd_fingerprint: createHash('sha256').update('# fixture').digest('hex'),
    phase: 'OPERATOR_READBACK',
    revision: 1,
    authority_epoch: 1,
    contract_revision: 'v1',
    coordinator_token_hash: createHash('sha256').update('token').digest('hex'),
    pending_execution_failure: { root_cause_key: 'race' },
    total_execution_failures: 2
  }
  const issue = (options = {}) =>
    dispatch(
      sdd,
      'coordinator',
      'OPERATOR_READBACK',
      'v1',
      'operator',
      'operator-1',
      5,
      10,
      ['src'],
      'fix race',
      'token',
      { worktreeRoot: root, ...options }
    )
  try {
    writeFileSync(sdd, '# fixture')
    writeFileSync(sdd + '.loop.json', JSON.stringify(initial))
    writeFileSync(sdd + '.events.jsonl', '')
    expect(() => issue()).toThrow('EXECUTION_FAILURE_READMISSION_REQUIRED')
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(JSON.stringify(initial))
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    writeFileSync(
      sdd + '.loop.json',
      JSON.stringify({
        ...initial,
        pending_pipeline_repair: { root_cause_key: 'host', candidate_hash: 'candidate' }
      })
    )
    issue({ repairProbeRoot: 'host' })
    expect(JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))).toMatchObject({
      pending_execution_failure: initial.pending_execution_failure,
      total_execution_failures: 2,
      active_lease: { scope: [], lease_kind: 'PIPELINE_PROBE' }
    })
    writeFileSync(
      sdd + '.loop.json',
      JSON.stringify({ ...initial, pending_execution_failure: null })
    )
    writeFileSync(sdd + '.events.jsonl', '')
    expect(() => issue()).toThrow('CONTRACT_ADMISSION_GATE_MISSING')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
