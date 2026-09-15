import { rolePublicKey } from '../scripts/resource/role-signature'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeRecord } from '../scripts/controllers/runtime-record.controller'

test('retirement requires stopped host observations and previously revoked matching authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-retirement-')),
    sdd = join(root, 'sdd.md')
  try {
    writeFileSync(sdd, '# fixture')
    const initial = {
      protocol: 'control-plane/state-v2',
      phase: 'IMPLEMENTING',
      revision: 1,
      contract_revision: 'v1',
      authority_epoch: 2,
      coordinator_agent_id: 'coordinator',
      coordinator_event_keys: { '2': rolePublicKey('token') },
      agent_roles: { operator: 'operator', architect: 'architect' },
      coordinator_token_hash: createHash('sha256').update('token').digest('hex'),
      active_lease: { agent_id: 'operator', lease_id: 'lease' },
      preparation: { agent_id: 'architect', prepared_id: 'prep' },
      completed_attempts: 3,
      requirements: { XQ01: 'pending' }
    }
    writeFileSync(sdd + '.loop.json', JSON.stringify(initial))
    writeFileSync(sdd + '.events.jsonl', '')
    const payload = {
      id: 'retire-op',
      controller: sdd,
      coordinator_agent_id: 'coordinator',
      authority_epoch: 2,
      previous_record_id: null,
      action: 'retire',
      agent_id: 'operator',
      evidence: 'host stopped'
    }
    const call = (value: object) =>
      runtimeRecord(sdd, 'coordinator', 'IMPLEMENTING', 'v1', value, 'token')
    expect(() => call(payload)).toThrow('RUNTIME_RETIRE_STOP_AND_PRESERVATION_REQUIRED')
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(JSON.stringify(initial))
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    const confirmed = {
      ...payload,
      writer_stopped: true,
      commands_stopped: true,
      preserved_evidence: ['saved partial'],
      next_action: 'reuse other Operator'
    }
    expect(() => call(confirmed)).toThrow('RUNTIME_RETIRE_REVOKE_REQUIRED')
    writeFileSync(sdd + '.loop.json', JSON.stringify({ ...initial, active_lease: null }))
    const result = call(confirmed)
    expect(JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))).toMatchObject({
      active_lease: null,
      preparation: initial.preparation,
      requirements: initial.requirements,
      completed_attempts: 3,
      authority_epoch: 2
    })
    expect(call(confirmed)).toEqual(result)
    expect(() => call({ ...confirmed, id: 'retire-ar', agent_id: 'architect' })).toThrow(
      'RUNTIME_RETIRE_REVOKE_REQUIRED'
    )
    const revoked = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    revoked.preparation = null
    writeFileSync(sdd + '.loop.json', JSON.stringify(revoked))
    call({ ...confirmed, id: 'retire-ar', agent_id: 'architect' })
    expect(JSON.parse(readFileSync(sdd + '.loop.json', 'utf8')).preparation).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
