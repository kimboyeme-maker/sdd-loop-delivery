import { transition } from '../scripts/controllers/transition.controller'
import { expect, test } from 'bun:test'
import {
  packetPrerequisites,
  assertPacketPrerequisiteEvidence
} from '../scripts/helpers/packet-prerequisites'
import { rolePublicKey, signRoleEvent } from '../scripts/resource/role-signature'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { admissionFixture } from './fixtures/admission'
import { initLoop } from '../scripts/controllers/init.controller'
import { authBootstrap } from '../scripts/controllers/auth-bootstrap.controller'
import { recordEvent } from '../scripts/controllers/record.controller'

test('CLI rejects early successor dispatch without writes and permits its admitted root packet', () => {
  const root = mkdtempSync(join(tmpdir(), 'packet-dispatch-')),
    sdd = join(root, 'task.md')
  try {
    const fixture = admissionFixture('src')
    const payload = structuredClone(fixture.payload)
    const packets: Record<string, unknown>[] = payload.execution_packets
    packets.push({
      ...payload.execution_packets[0]!,
      id: 'PC02',
      depends_on_packet_ids: ['PC01']
    })
    writeFileSync(sdd, fixture.source)
    initLoop(sdd, 4)
    authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', 'token')
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0)
    transition(sdd, 'coordinator', 'DISCOVER', 'v1', 'ARCHITECT', 'token')
    transition(sdd, 'coordinator', 'ARCHITECT', 'v1', 'CONTRACT_DRAFT', 'token')
    recordEvent(sdd, 'coordinator', 'CONTRACT_DRAFT', 'v1', 'contract_admission', payload, 'token')
    transition(sdd, 'coordinator', 'CONTRACT_DRAFT', 'v1', 'CONTRACT_ADMITTED', 'token')
    transition(sdd, 'coordinator', 'CONTRACT_ADMITTED', 'v1', 'OPERATOR_READBACK', 'token')
    const before = readFileSync(sdd + '.loop.json'),
      events = readFileSync(sdd + '.events.jsonl')
    const run = (packet?: string) =>
      Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, '../scripts/main.ts'),
          'dispatch',
          '--sdd',
          sdd,
          '--role',
          'coordinator',
          '--expected-state',
          'OPERATOR_READBACK',
          '--expected-revision',
          'v1',
          '--agent',
          'operator',
          '--agent-id',
          'operator',
          '--soft-deadline',
          '1',
          '--hard-deadline',
          '5',
          '--scope-json',
          '["src"]',
          '--worktree-root',
          root,
          '--work-item',
          'fixture',
          ...(packet ? ['--packet', packet] : [])
        ],
        { env: { ...process.env, SDD_LOOP_COORDINATOR_TOKEN: 'token' } }
      )
    for (const packet of [undefined, 'PC02']) {
      expect(run(packet).exitCode).toBe(1)
      expect(readFileSync(sdd + '.loop.json')).toEqual(before)
      expect(readFileSync(sdd + '.events.jsonl')).toEqual(events)
    }
    expect(run('PC01').exitCode).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('packet prerequisites follow transitive edges and cannot be bypassed by omission', () => {
  const packet = (id: string, depends: string[]) => ({
    id,
    depends_on_packet_ids: depends,
    requirement_ids: ['XQ01'],
    acceptance_ids: ['YS01']
  })
  const admission = {
    payload: {
      execution_packets: [packet('PC01', []), packet('PC02', ['PC01']), packet('PC03', ['PC02'])]
    }
  }
  expect(() => packetPrerequisites(admission)).toThrow('DISPATCH_PACKET_REQUIRED')
  expect(packetPrerequisites(admission, 'PC01')).toEqual([])
  expect(packetPrerequisites(admission, 'PC03').map((item) => item.id)).toEqual(['PC02', 'PC01'])
  expect(() => packetPrerequisites(admission, 'PC99')).toThrow()
})

test('packet continuation consumes current-round Operator evidence, not an Architect PASS', () => {
  const prerequisites = [{ id: 'PC01', requirementIds: ['XQ01'], acceptanceIds: ['YS01'] }]
  const state = {
    contract_revision: 'v1',
    requirements: { XQ01: 'pending' },
    issued_leases: {
      op: {
        role: 'operator',
        agent_id: 'operator',
        authority_epoch: 1,
        contract_revision: 'v1',
        event_public_key: rolePublicKey('op-key')
      }
    }
  }
  const entered = { type: 'state_transition', payload: { to: 'IMPLEMENTING' } }
  const proof = (ids: unknown = ['PC01'], revision = 'v1', eventId = 'implementation') =>
    signRoleEvent(
      {
        event_id: eventId,
        role: 'operator',
        type: 'implementation',
        contract_revision: revision,
        actor: { lease_id: 'op', agent_id: 'operator', authority_epoch: 1 },
        payload: { execution_packet_ids: ids }
      },
      'op-key'
    )
  const check = (events: Record<string, unknown>[]) =>
    assertPacketPrerequisiteEvidence(prerequisites, state, events, {})
  expect(() => check([entered, proof()])).not.toThrow()
  // A later valid packet does not erase the completed predecessor.
  expect(() => check([entered, proof(), proof(['PC02'], 'v1', 'second')])).not.toThrow()
  expect(state.requirements.XQ01).toBe('pending')
  for (const events of [
    [entered],
    [proof(), entered],
    [entered, proof(['PC02'])],
    [entered, proof(['PC01'], 'v0')],
    [entered, { ...proof(), signature: 'forged' }],
    [entered, proof(), proof()],
    [entered, proof(null)],
    [entered, { type: 'verification', role: 'architect', payload: { result: 'PASS' } }]
  ])
    expect(() => check(events)).toThrow()
  expect(() =>
    assertPacketPrerequisiteEvidence(
      [...prerequisites, { id: 'PC02', requirementIds: ['XQ01'], acceptanceIds: ['YS01'] }],
      state,
      [entered, proof(), proof(['PC02'], 'v1', 'second')],
      {}
    )
  ).not.toThrow()
})
