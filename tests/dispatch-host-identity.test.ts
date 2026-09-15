import { rolePublicKey } from '../scripts/resource/role-signature'
import { recordEvent } from '../scripts/controllers/record.controller'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatch } from '../scripts/controllers/dispatch.controller'
import { admissionFixture } from './fixtures/admission'
import { transition } from '../scripts/controllers/transition.controller'

test('dispatch preserves opaque host identities and checks history against the same exact value', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-identity-'))
  const sdd = join(root, 'sdd.md')
  const initial = {
    protocol: 'control-plane/state-v2',
    phase: 'DISCOVER',
    revision: 1,
    contract_revision: 'v1',
    authority_epoch: 1,
    coordinator_event_keys: { '1': rolePublicKey('token') },
    sdd_fingerprint: createHash('sha256').update(admissionFixture('src').source).digest('hex'),
    coordinator_token_hash: createHash('sha256').update('token').digest('hex'),
    coordinator_agent_id: '/root/coordinator',
    coordinator_agent_ids: ['/root/previous']
  }
  const reset = () => {
    writeFileSync(sdd + '.loop.json', JSON.stringify(initial))
    writeFileSync(sdd + '.events.jsonl', '')
    transition(sdd, 'coordinator', 'DISCOVER', 'v1', 'ARCHITECT', 'token')
    transition(sdd, 'coordinator', 'ARCHITECT', 'v1', 'CONTRACT_DRAFT', 'token')
    recordEvent(
      sdd,
      'coordinator',
      'CONTRACT_DRAFT',
      'v1',
      'contract_admission',
      admissionFixture('src').payload,
      'token'
    )
    transition(sdd, 'coordinator', 'CONTRACT_DRAFT', 'v1', 'CONTRACT_ADMITTED', 'token')
    transition(sdd, 'coordinator', 'CONTRACT_ADMITTED', 'v1', 'OPERATOR_READBACK', 'token')
  }
  const issue = (id: string) =>
    dispatch(
      sdd,
      'coordinator',
      'OPERATOR_READBACK',
      'v1',
      'operator',
      id,
      5,
      10,
      ['src'],
      'implement',
      'token',
      { worktreeRoot: root }
    )
  try {
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0)
    writeFileSync(sdd, admissionFixture('src').source)
    for (const id of ['/root/operator', '019ce612-1234-4321-a123-123456789abc', 'Operator.A']) {
      reset()
      expect(issue(id).agentId).toBe(id)
      const state = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
      expect(state.active_lease.agent_id).toBe(id)
      expect(state.issued_leases[state.active_lease.lease_id].agent_id).toBe(id)
    }
    for (const id of [
      '',
      ' /root/operator',
      '/root/operator\n',
      'agent\u0000id',
      '/root/coordinator',
      '/root/previous'
    ]) {
      reset()
      const before = readFileSync(sdd + '.loop.json', 'utf8')
      const events = readFileSync(sdd + '.events.jsonl', 'utf8')
      expect(() => issue(id)).toThrow()
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(before)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(events)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
