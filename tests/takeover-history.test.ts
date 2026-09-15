import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coordinatorTakeover } from '../scripts/controllers/coordinator-takeover.controller'
import { assertProductRoleHistory } from '../scripts/domain/policies/role-history'
import { rolePublicKey } from '../scripts/resource/role-signature'
import { coordinatorReceipt } from './fixtures/runtime-receipt'

test('takeover retains Coordinator exclusions and product facts, rejecting terminal and invalid epochs', () => {
  const root = mkdtempSync(join(tmpdir(), 'takeover-history-')),
    sdd = join(root, 'sdd.md')
  const initial = {
    protocol: 'control-plane/state-v2',
    phase: 'DISCOVER',
    revision: 3,
    contract_revision: 'v1',
    authority_epoch: 2,
    coordinator_agent_id: 'previous',
    coordinator_agent_ids: ['first'],
    coordinator_token_hash: createHash('sha256').update('old').digest('hex'),
    coordinator_event_keys: { '2': rolePublicKey('old') },
    requirements: { XQ01: 'verified' },
    completed_attempts: 4,
    active_lease: null
  }
  try {
    writeFileSync(sdd, '# fixture')
    for (const patch of [
      { phase: 'SHIP' },
      { authority_epoch: Number.MAX_SAFE_INTEGER },
      { authority_epoch: 1.5 }
    ]) {
      const state = { ...initial, ...patch }
      const bytes = JSON.stringify(state)
      writeFileSync(sdd + '.loop.json', bytes)
      writeFileSync(sdd + '.events.jsonl', '')
      expect(() =>
        coordinatorTakeover(
          sdd,
          state.phase,
          'v1',
          'replace',
          'yes',
          'yes',
          '/root/next',
          'old',
          'new',
          coordinatorReceipt('/root/next')
        )
      ).toThrow()
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(bytes)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe('')
    }
    writeFileSync(sdd + '.loop.json', JSON.stringify(initial))
    expect(() =>
      coordinatorTakeover(
        sdd,
        'DISCOVER',
        'v1',
        'replace',
        'yes',
        'yes',
        '/root/next',
        'old',
        'new'
      )
    ).toThrow('COORDINATOR_RUNTIME_RECEIPT_REQUIRED')
    expect(() =>
      coordinatorTakeover(
        sdd,
        'DISCOVER',
        'v1',
        'replace',
        'yes',
        'yes',
        '/root/next',
        'old',
        'new',
        coordinatorReceipt('/root/other')
      )
    ).toThrow('COORDINATOR_RUNTIME_IDENTITY_MISMATCH')
    coordinatorTakeover(
      sdd,
      'DISCOVER',
      'v1',
      'replace',
      'yes',
      'yes',
      '/root/next',
      'old',
      'new',
      coordinatorReceipt('/root/next')
    )
    const state = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    expect(state).toMatchObject({
      coordinator_agent_ids: ['first', 'previous', '/root/next'],
      authority_epoch: 3,
      requirements: initial.requirements,
      completed_attempts: 4,
      phase: 'DISCOVER',
      active_lease: null
    })
    for (const id of ['first', 'previous', '/root/next'])
      expect(() => assertProductRoleHistory(state, [], id, 'operator')).toThrow(
        'COORDINATOR_CANNOT_RECEIVE_TASK_ROLE_LEASE'
      )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
