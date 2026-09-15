import { rolePublicKey, signRoleEvent } from '../scripts/resource/role-signature'
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeView } from '../scripts/controllers/read-only.controller'

test('runtime view uses native lease time and cannot fall back around an invalid native deadline', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-native-')),
    sdd = join(root, 'sdd.md')
  try {
    writeFileSync(sdd, '# fixture')
    const lease = {
      lease_id: 'lease',
      agent_id: 'operator',
      role: 'operator',
      authority_epoch: 2,
      issued_at: new Date().toISOString(),
      hard_deadline_minutes: 5,
      token_hash: 'private-marker'
    }
    const view = (patch: object = {}) => {
      writeFileSync(
        sdd + '.loop.json',
        JSON.stringify({
          protocol: 'control-plane/state-v2',
          authority_epoch: 2,
          active_lease: { ...lease, ...patch }
        })
      )
      const before = readFileSync(sdd + '.loop.json')
      const result = runtimeView(sdd) as {
        eligible: boolean
        reasons: string[]
        hostIdentityVerified: boolean
      }
      expect(readFileSync(sdd + '.loop.json')).toEqual(before)
      return result
    }
    expect(view()).toMatchObject({ eligible: true, hostIdentityVerified: false })
    expect(JSON.stringify(view())).not.toContain('private-marker')
    expect(view({ issued_at: 'invalid', deadline: Date.now() / 1000 + 3600 }).eligible).toBe(false)
    expect(view({ authority_epoch: 1 }).reasons).toContain('AGENT_LEASE_EPOCH_MISMATCH')
    expect(view({ issued_at: '2000-01-01T00:00:00Z' }).reasons).toContain('AGENT_LEASE_EXPIRED')
    expect(view({ agent_id: ' ' }).eligible).toBe(false)
    expect(view({ lease_id: ' ' }).reasons).toContain('LEASE_ID_UNRECORDED')
    expect(view({ role: 'Operator' }).reasons).toContain('LEASE_ROLE_UNRECORDED')
    expect(view({ issued_at: undefined, hard_deadline_minutes: undefined }).reasons).toContain(
      'AGENT_LEASE_DEADLINE_UNVERIFIABLE'
    )
    expect(view().eligible).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime view reports role and adopted design exclusions from stable private history', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-history-')),
    sdd = join(root, 'task.md')
  const active = {
    lease_id: 'current',
    agent_id: 'author',
    role: 'architect',
    authority_epoch: 2,
    issued_at: new Date().toISOString(),
    hard_deadline_minutes: 5
  }
  const old = {
    lease_id: 'design',
    agent_id: 'author',
    role: 'architect',
    authority_epoch: 1,
    contract_revision: 'v1',
    event_public_key: rolePublicKey('author')
  }
  const proposal = signRoleEvent(
    {
      event_id: 'DP',
      role: 'architect',
      type: 'design_proposal',
      contract_revision: 'v1',
      actor: { agent_id: 'author', lease_id: 'design', authority_epoch: 1 },
      payload: { materiality: 'MATERIAL', private_note: 'do-not-expose' }
    },
    'author'
  )
  const events = [
    proposal,
    {
      event_id: 'DR',
      role: 'coordinator',
      type: 'design_resolution',
      payload: { decision: 'CONVERGED', proposal_event_id: 'DP' }
    }
  ]
  try {
    writeFileSync(sdd, 'design')
    const base = {
      protocol: 'control-plane/state-v2',
      authority_epoch: 2,
      contract_revision: 'v2',
      active_lease: active,
      issued_leases: { design: old }
    }
    const log = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
    writeFileSync(sdd + '.events.jsonl', log)
    for (const [patch, reason] of [
      [{}, 'ARCHITECT_ADOPTED_MATERIAL_DESIGN_AUTHOR'],
      [{ coordinator_agent_ids: ['author'] }, 'COORDINATOR_CANNOT_RECEIVE_TASK_ROLE_LEASE']
    ] as const) {
      const before = JSON.stringify({ ...base, ...patch })
      writeFileSync(sdd + '.loop.json', before)
      const result = runtimeView(sdd) as { eligible: boolean; reasons: string[] }
      expect(result.eligible).toBe(false)
      expect(result.reasons).toContain(reason)
      expect(JSON.stringify(result)).not.toContain('do-not-expose')
      expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(before)
      expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(log)
    }
    writeFileSync(
      sdd + '.loop.json',
      JSON.stringify({ ...base, active_lease: { ...active, agent_id: 'independent' } })
    )
    expect((runtimeView(sdd) as { eligible: boolean }).eligible).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
