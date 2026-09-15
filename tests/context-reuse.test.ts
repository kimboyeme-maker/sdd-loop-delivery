import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { signRoleEvent, rolePublicKey } from '../scripts/resource/role-signature'
import { reusableContextSources } from '../scripts/helpers/context-reuse'

test('context reuse requires unchanged sources, current runtime, authentic unique evidence and retention', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-reuse-'))
  const saved = process.env.SDD_LOOP_AGENT_TOKEN_FILE
  try {
    const token = 'isolated-operator'
    // Role credentials arrive only as a private file bound to the active lease.
    const capability = join(root, 'operator.token')
    writeFileSync(capability, token, { mode: 0o600 })
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = capability
    const sdd = join(root, 'design.md')
    const old = {
      lease_id: 'old',
      role: 'operator',
      agent_id: 'same-runtime',
      authority_epoch: 1,
      contract_revision: 'v1',
      event_public_key: rolePublicKey(token)
    }
    const active = {
      ...old,
      lease_id: 'new',
      agent_token_hash: createHash('sha256').update(token).digest('hex'),
      capability_file: capability,
      issued_at: new Date().toISOString(),
      hard_deadline_minutes: 10
    }
    const state = {
      protocol: 'control-plane/state-v2',
      authority_epoch: 1,
      contract_revision: 'v1',
      active_lease: active,
      issued_leases: { old, new: active }
    }
    const source = {
      path: join(root, 'source.md'),
      class: 'normative',
      sha256: 'unchanged',
      bytes: 12
    }
    const event = signRoleEvent(
      {
        event_id: 'read-one',
        role: 'operator',
        type: 'agent_started',
        actor: { lease_id: 'old', agent_id: 'same-runtime', authority_epoch: 1 },
        payload: { reading: { protocol: 'context-read-evidence/v1', sources: [source] } }
      },
      token
    )
    const store = (events: unknown[], current: unknown = state) => {
      writeFileSync(sdd + '.loop.json', JSON.stringify(current))
      writeFileSync(sdd + '.events.jsonl', events.map((item) => JSON.stringify(item)).join('\n'))
    }
    const read = (sources = [source], fresh = false) =>
      reusableContextSources(sdd, 'operator', 'same-runtime', sources, undefined, fresh)
    store([event])
    expect(read()).toHaveLength(1)
    expect(read([{ ...source, sha256: 'changed' }])).toEqual([])
    expect(read([{ ...source, class: 'untrusted' }])).toEqual([])
    expect(read([source], true)).toEqual([])
    expect(() => reusableContextSources(sdd, 'operator', 'other-runtime', [source])).toThrow(
      'CONTEXT_REUSE_ASSIGNMENT_INVALID'
    )
    store([{ ...event, signature: 'forged' }])
    expect(read()).toEqual([])
    store([event, event])
    expect(read()).toEqual([])
    store([event, { type: 'recovery' }])
    expect(read()).toEqual([])
    store([event], {
      ...state,
      authority_epoch: 2,
      active_lease: { ...active, authority_epoch: 2 }
    })
    expect(read()).toEqual([])
    store([event], { ...state, active_lease: { ...active, issued_at: '2000-01-01T00:00:00Z' } })
    expect(() => read()).toThrow('AGENT_LEASE_EXPIRED')
    const fragmented = {
      ...source,
      fragment_layout: ['## A', '## B'],
      fragments: [
        { fragment: '## A', sha256: 'stable', bytes: 6 },
        { fragment: '## B', sha256: 'before', bytes: 6 }
      ]
    }
    store([
      signRoleEvent(
        {
          event_id: 'fragment-read',
          role: 'operator',
          type: 'agent_started',
          actor: { lease_id: 'old', agent_id: 'same-runtime', authority_epoch: 1 },
          payload: { reading: { protocol: 'context-read-evidence/v1', sources: [fragmented] } }
        },
        token
      )
    ])
    const changed = {
      ...fragmented,
      sha256: 'changed',
      fragments: [fragmented.fragments[0]!, { fragment: '## B', sha256: 'after', bytes: 6 }]
    }
    expect(read([changed])).toMatchObject([{ fragment: '## A', sha256: 'stable' }])
    expect(read([{ ...changed, fragment_layout: ['## B', '## A'] } as typeof changed])).toEqual([])
    store([event])
    const wrong = join(root, 'wrong.token')
    writeFileSync(wrong, 'wrong', { mode: 0o600 })
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = wrong
    expect(() => read()).toThrow('CONTEXT_REUSE_AUTH_INVALID')
  } finally {
    if (saved === undefined) delete process.env.SDD_LOOP_AGENT_TOKEN_FILE
    else process.env.SDD_LOOP_AGENT_TOKEN_FILE = saved
    rmSync(root, { recursive: true, force: true })
  }
})
