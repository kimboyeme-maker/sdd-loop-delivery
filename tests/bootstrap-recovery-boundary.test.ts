import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapRecover } from '../scripts/controllers/bootstrap-recover.controller'
import { coordinatorTakeover } from '../scripts/controllers/coordinator-takeover.controller'
import { assertProductRoleHistory } from '../scripts/domain/policies/role-history'
import { rolePublicKey } from '../scripts/resource/role-signature'
import { coordinatorReceipt } from './fixtures/runtime-receipt'

test('bootstrap recovery preserves Coordinator exclusions and rejects unsafe authority changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-recovery-'))
  const sdd = join(root, 'task.md')
  const initial = {
    protocol: 'control-plane/state-v2',
    phase: 'DISCOVER',
    revision: 2,
    contract_revision: 'v1',
    authority_epoch: 2,
    coordinator_agent_id: 'previous',
    coordinator_agent_ids: ['first'],
    coordinator_token_hash: createHash('sha256').update('old').digest('hex'),
    coordinator_event_keys: { '2': rolePublicKey('old') },
    completed_attempts: 0,
    total_execution_failures: 0,
    requirements: { XQ01: 'pending' }
  }
  const call = (phase = 'DISCOVER') =>
    bootstrapRecover(
      sdd,
      phase,
      'v1',
      'restart',
      'yes',
      '/root/next',
      'old',
      'new',
      coordinatorReceipt('/root/next')
    )
  try {
    writeFileSync(sdd, '# design')
    const log = '{"type":"project_context"}\n'
    const patches: Record<string, unknown>[] = [
      { phase: 'SHIP' },
      { preparation: { prepared_id: 'prep' } }
    ]
    for (const value of [null, 'first', {}, 0, ['first', null], ['first', ' ']])
      patches.push({ coordinator_agent_ids: value })
    for (const key of ['issued_leases', 'findings', 'requirement_evidence'])
      for (const value of [null, 0, false, [], '', { record: 'existing' }])
        patches.push({ [key]: value })
    for (const key of ['completed_attempts', 'total_execution_failures'])
      for (const value of [undefined, null, '0', false, [], 1, -1]) patches.push({ [key]: value })
    for (const value of [null, '0', false, [], 1]) patches.push({ round_completed_attempts: value })
    for (const key of ['authority_epoch', 'revision'])
      for (const value of [undefined, null, '2', false, 0, -1, 1.5, Number.MAX_SAFE_INTEGER])
        patches.push({ [key]: value })
    for (const patch of patches) {
      const state = { ...initial, ...patch }
      const bytes = JSON.stringify(state)
      writeFileSync(sdd + '.loop.json', bytes)
      writeFileSync(sdd + '.events.jsonl', log)
      const files = readdirSync(root).sort()
      expect(() => call(String(state.phase))).toThrow()
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(bytes)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(log)
      expect(readdirSync(root).sort()).toEqual(files)
      if (Object.hasOwn(patch, 'revision')) {
        expect(() =>
          coordinatorTakeover(
            sdd,
            'DISCOVER',
            'v1',
            'restart',
            'yes',
            'yes',
            '/root/next',
            'old',
            'new',
            coordinatorReceipt('/root/next')
          )
        ).toThrow('CONTROL_REVISION_INVALID')
        expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(bytes)
        expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(log)
      }
    }
    for (const activity of [
      { type: 'dispatch' },
      { role: 'operator', type: 'agent_started' },
      { role: 'architect', type: 'verification' },
      { type: 'requirement_status' }
    ]) {
      const bytes = JSON.stringify({
        ...initial,
        issued_leases: {},
        findings: {},
        requirement_evidence: {}
      })
      const history = log + JSON.stringify(activity) + '\n'
      writeFileSync(sdd + '.loop.json', bytes)
      writeFileSync(sdd + '.events.jsonl', history)
      expect(() => call()).toThrow('BOOTSTRAP_RECOVERY_NOT_SAFE')
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(bytes)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(history)
    }
    writeFileSync(sdd + '.events.jsonl', log)
    writeFileSync(sdd + '.loop.json', JSON.stringify(initial))
    call()
    const after = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    expect(after).toMatchObject({
      authority_epoch: 3,
      revision: 3,
      coordinator_agent_id: '/root/next',
      coordinator_agent_ids: ['first', 'previous', '/root/next'],
      requirements: initial.requirements,
      completed_attempts: 0
    })
    expect(readFileSync(sdd + '.events.jsonl', 'utf8').startsWith(log)).toBe(true)
    for (const id of ['first', 'previous', '/root/next'])
      for (const role of ['operator', 'architect'] as const)
        expect(() => assertProductRoleHistory(after, [], id, role)).toThrow(
          'COORDINATOR_CANNOT_RECEIVE_TASK_ROLE_LEASE'
        )
    expect(() => assertProductRoleHistory(after, [], 'product-agent', 'operator')).not.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
