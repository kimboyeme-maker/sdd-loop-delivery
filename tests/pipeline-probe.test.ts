import { rolePublicKey } from '../scripts/resource/role-signature'
import { runBootstrapProcesses } from '../scripts/controllers/bootstrap-process'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordEvent } from '../scripts/controllers/record.controller'
import { dispatch } from '../scripts/controllers/dispatch.controller'
import { agentStartReceipt } from '../scripts/controllers/agent-start-receipt.controller'
import { prepare } from '../scripts/controllers/prepare.controller'

test('pipeline repair restores orchestration but does not fabricate product admission', () => {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-probe-')),
    sdd = join(root, 'sdd.md')
  const saved = [process.env.SDD_LOOP_AGENT_TOKEN_FILE, process.env.SDD_LOOP_CAPABILITY_DIR]
  process.env.SDD_LOOP_CAPABILITY_DIR = join(root, 'capabilities')
  const read = () => JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
  const issue = (repairProbeRoot?: string) =>
    dispatch(
      sdd,
      'coordinator',
      'OPERATOR_READBACK',
      'v1',
      'operator',
      'operator',
      1,
      5,
      ['src'],
      'probe',
      'token',
      repairProbeRoot ? { repairProbeRoot } : { worktreeRoot: root }
    )
  try {
    writeFileSync(sdd, '# fixture')
    writeFileSync(
      sdd + '.loop.json',
      JSON.stringify({
        protocol: 'control-plane/state-v2',
        sdd_fingerprint: createHash('sha256').update('# fixture').digest('hex'),
        phase: 'OPERATOR_READBACK',
        revision: 1,
        contract_revision: 'v1',
        authority_epoch: 1,
        coordinator_event_keys: { '1': rolePublicKey('token') },
        active_lease: null,
        completed_attempts: 2,
        coordinator_token_hash: createHash('sha256').update('token').digest('hex'),
        pending_pipeline_repair: { root_cause_key: 'host' }
      })
    )
    expect(() => issue()).toThrow('PIPELINE_REPAIR_PROBE_REQUIRED')
    expect(() => issue('host')).toThrow('PIPELINE_REPAIR_PROBE_BINDING_INVALID')
    recordEvent(
      sdd,
      'coordinator',
      'OPERATOR_READBACK',
      'v1',
      'pipeline_repair',
      { root_cause_key: 'host', mechanism: 'repair transport', falsifier: 'authentication fails' },
      'token'
    )
    const probe = issue('host')
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = probe.capabilityFile
    expect(read().active_lease.scope).toEqual([])
    const probeState = readFileSync(sdd + '.loop.json'),
      probeEvents = readFileSync(sdd + '.events.jsonl')
    expect(() =>
      prepare(sdd, 'coordinator', 'OPERATOR_READBACK', 'v1', 'architect', false, false, 'token')
    ).toThrow('PREPARE_REQUIRES_OPERATOR_LEASE')
    expect(() =>
      agentStartReceipt(
        sdd,
        'operator',
        'operator',
        read().active_lease.lease_id,
        'unused',
        'This probe must not begin product implementation.',
        'OPERATOR_READBACK',
        'v1',
        'token'
      )
    ).toThrow('PIPELINE_PROBE_FORBIDS_PRODUCT_START')
    expect(readFileSync(sdd + '.loop.json')).toEqual(probeState)
    expect(readFileSync(sdd + '.events.jsonl')).toEqual(probeEvents)
    const before = readFileSync(sdd + '.loop.json'),
      log = readFileSync(sdd + '.events.jsonl')
    const wrong = join(root, 'wrong.token')
    writeFileSync(wrong, 'wrong', { mode: 0o600 })
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = wrong
    expect(() => runBootstrapProcesses(sdd, 'operator', 'OPERATOR_READBACK', 'v1')).toThrow(
      'BOOTSTRAP_AGENT_AUTH_INVALID'
    )
    expect(readFileSync(sdd + '.loop.json')).toEqual(before)
    expect(readFileSync(sdd + '.events.jsonl')).toEqual(log)
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = probe.capabilityFile
    expect(runBootstrapProcesses(sdd, 'operator', 'OPERATOR_READBACK', 'v1').eventIds).toHaveLength(
      3
    )
    expect(read()).toMatchObject({
      active_lease: null,
      pending_pipeline_repair: null,
      completed_attempts: 2,
      last_pipeline_repair: { root_cause_key: 'host' }
    })
    expect(() => issue()).toThrow('CONTRACT_ADMISSION_GATE_MISSING')
  } finally {
    ;['SDD_LOOP_AGENT_TOKEN_FILE', 'SDD_LOOP_CAPABILITY_DIR'].forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key]
      else process.env[key] = saved[index]
    })
    rmSync(root, { recursive: true, force: true })
  }
})
