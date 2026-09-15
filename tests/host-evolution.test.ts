import { assertRuntimeLifecycle } from '../scripts/helpers/runtime-lifecycle'
import { assertRuntimeRecordPhase } from '../scripts/domain/policies/phase'
import { spawnDecision } from '../scripts/helpers/runtime-facts'
import { closeDecision } from '../scripts/services/runtime-plan'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertHostProfile,
  hostCapabilities,
  hostProfile,
  operatorRuntime,
  roleRuntime,
  runtimeMatches
} from '../scripts/config/host'
import {
  assertArchitecture,
  assertDeliveryPlatforms
} from '../scripts/domain/platform-architecture'
import {
  findLease,
  leaseDeadlines,
  leaseSlots,
  releaseLease,
  storeLease
} from '../scripts/helpers/lease-slots'
import { sidecarPaths } from '../scripts/resource/state'
import { evolutionDigest, retrospective } from '../scripts/services/retrospective'

/** Fields of retrospective and digest output these assertions read. */
type Retro = {
  issues: { kind: string; evidence_event_ids: string[] }[]
  proposals: { target: string; maturity: string }[]
}

test('host profiles map role tiers and neutral operations without host literals in roles', () => {
  const codex = hostProfile({})
  expect(codex.id).toBe('codex')
  expect(roleRuntime('coordinator', codex)).toMatchObject({ tier: 'frontier', context: 'isolated' })
  expect(roleRuntime('coordinator', codex).spawn_args).toEqual({ fork_turns: 'none' })
  const claude = hostProfile({ SDD_LOOP_HOST: 'claude-code' })
  const architect = roleRuntime('architect', claude)
  // Aliases and resolved IDs both match; an unpinned effort accepts any reported value.
  expect(runtimeMatches(architect, { model: 'sonnet' })).toBe(true)
  expect(runtimeMatches(architect, { model: 'claude-sonnet-5', reasoning_effort: 'high' })).toBe(
    true
  )
  expect(runtimeMatches(architect, { model: 'opus' })).toBe(false)
  expect(operatorRuntime('escalated', claude).spawn_model).toBe('opus')
  expect(hostCapabilities(claude)).toMatchObject({ goal_control: { pause_resume: false } })
  // A host that cannot pin models accepts any reported model.
  expect(
    runtimeMatches(roleRuntime('coordinator', hostProfile({ SDD_LOOP_HOST: 'generic' })), {
      model: 'x'
    })
  ).toBe(true)
  expect(() => hostProfile({ SDD_LOOP_HOST: 'unknown' })).toThrow('HOST_PROFILE_UNKNOWN')
  expect(() =>
    assertHostProfile({ ...codex, operations: { ...codex.operations, spawn: { available: true } } })
  ).toThrow('HOST_PROFILE_INVALID')
  const root = mkdtempSync(join(tmpdir(), 'host-profile-'))
  try {
    const file = join(root, 'pi.json')
    writeFileSync(file, JSON.stringify({ ...codex, id: 'pi' }))
    expect(hostProfile({ SDD_LOOP_HOST_PROFILE_FILE: file, SDD_LOOP_HOST: 'generic' }).id).toBe(
      'pi'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('delivery platforms and core-adapter architecture reject unsafe plans', () => {
  expect(() => assertDeliveryPlatforms({ delivery_platforms: ['ios'] })).toThrow(
    'PRODUCT_ARCHETYPE_REQUIRED'
  )
  expect(() =>
    assertDeliveryPlatforms({ product_archetype: 'commerce', delivery_platforms: ['watch'] })
  ).toThrow('DELIVERY_PLATFORMS_INVALID')
  const architecture = {
    protocol: 'core-adapters/v1',
    core: { packages: ['packages/core'] },
    adapters: [
      { id: 'AD01', kind: 'cli', packages: ['packages/cli'] },
      { id: 'AD02', kind: 'documents', packages: ['packages/docs'] }
    ]
  }
  const batch = (id: string, packages: string[], depends_on: string[] = []) => ({
    id,
    modification_packages: packages,
    depends_on
  })
  expect(
    assertArchitecture({
      architecture,
      delivery_plan: {
        batches: [batch('B1', ['packages/core']), batch('B2', ['packages/cli'], ['B1'])]
      }
    })
  ).toMatchObject({ adapters: 2, kinds: ['cli', 'documents'] })
  // An adapter racing the core API it translates is rejected.
  expect(() =>
    assertArchitecture({
      architecture,
      delivery_plan: { batches: [batch('B1', ['packages/core']), batch('B2', ['packages/cli'])] }
    })
  ).toThrow('ARCHITECTURE_ADAPTER_BEFORE_CORE: B2')
  expect(() =>
    assertArchitecture({
      architecture: {
        ...architecture,
        adapters: [{ id: 'AD01', kind: 'cli', packages: ['packages/core/cli'] }]
      }
    })
  ).toThrow('ARCHITECTURE_CORE_ADAPTER_OVERLAP')
})

test('lease slots keep one writer slot and concurrent shard verifiers apart', () => {
  const primary = { lease_id: 'L1', agent_id: 'a1' }
  const shard = { lease_id: 'L2', agent_id: 'a2', verification_shard: 'SH02' }
  const state = { active_lease: primary, shard_leases: { L2: shard } }
  expect(leaseSlots(state).map((lease) => lease.lease_id)).toEqual(['L1', 'L2'])
  expect(findLease(state, 'L2')).toBe(shard)
  expect(storeLease(state, { ...shard, started_event_id: 'E' })).toEqual({
    shard_leases: { L2: { ...shard, started_event_id: 'E' } }
  })
  expect(releaseLease(state, 'L1')).toEqual({ active_lease: null })
  expect(releaseLease(state, 'L2')).toEqual({ shard_leases: {} })
})

test('retrospective classifies delivery problems into evidence-cited proposals that mature across deliveries', () => {
  const root = mkdtempSync(join(tmpdir(), 'retrospective-'))
  const previous = process.env.SDD_LOOP_DIAGNOSTICS_DIR
  process.env.SDD_LOOP_DIAGNOSTICS_DIR = root
  try {
    const files: string[] = []
    for (const name of ['a', 'b']) {
      const sdd = join(root, `${name}.sdd.md`)
      const paths = sidecarPaths(sdd)
      writeFileSync(
        paths.state,
        JSON.stringify({
          protocol: 'control-plane/state-v2',
          revision: 3,
          phase: 'SHIP',
          sdd,
          logical_round: 2,
          max_rounds: 3,
          credit_ledger: { protocol: 'credit-ledger/v1', budget: 60, spent: 55 }
        })
      )
      const events = [
        {
          event_id: 'E1',
          type: 'contract_amendment',
          role: 'coordinator',
          payload: { reason: 'acceptance oracle missed the empty state' }
        },
        {
          event_id: 'E2',
          type: 'finding_decision',
          role: 'coordinator',
          payload: { architect_result: 'FAIL' }
        },
        {
          event_id: 'E3',
          type: 'test_run',
          role: 'operator',
          payload: { outcome: 'FAIL', timed_out: true, duration_seconds: 900 }
        },
        {
          event_id: 'E4',
          type: 'pipeline_incident',
          role: 'coordinator',
          payload: { root_cause_key: 'HOST_SPAWN_REJECTED', reason: 'model unavailable' }
        }
      ]
      writeFileSync(paths.events, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
      writeFileSync(
        paths.rejections,
        ['AGENT_LEASE_MISMATCH', 'AGENT_LEASE_MISMATCH']
          .map((code) => JSON.stringify({ at: 'now', command: 'agent-record', code }))
          .join('\n') + '\n'
      )
      const retro = retrospective(sdd) as unknown as Retro
      const kinds = retro.issues.map((issue: Record<string, unknown>) => issue.kind)
      expect(kinds).toEqual(
        expect.arrayContaining([
          'CONTRACT_AMENDMENT',
          'ARCHITECT_REJECTION',
          'TEST_TIMEOUT',
          'HOST_INCIDENT',
          'CREDIT_PRESSURE',
          'ROUND_OVERRUN',
          'COMMAND_REJECTION'
        ])
      )
      expect(
        retro.proposals.find(
          (proposal: Record<string, unknown>) => proposal.target === 'host-profile'
        )
      ).toBeDefined()
      expect(
        retro.issues.find((issue: Record<string, unknown>) => issue.kind === 'CONTRACT_AMENDMENT')
          ?.evidence_event_ids
      ).toEqual(['E1'])
      const file = join(root, `${name}.retrospective.json`)
      writeFileSync(file, JSON.stringify(retro))
      files.push(file)
    }
    const digest = evolutionDigest(files) as unknown as Retro
    expect(
      digest.proposals.every((proposal: Record<string, unknown>) => proposal.maturity === 'trace')
    ).toBe(true)
    expect(evolutionDigest(files.slice(0, 1)).proposals).toEqual(
      expect.arrayContaining([expect.objectContaining({ maturity: 'report' })])
    )
  } finally {
    if (previous === undefined) delete process.env.SDD_LOOP_DIAGNOSTICS_DIR
    else process.env.SDD_LOOP_DIAGNOSTICS_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime plan closes from recorded close results and waits on absolute deadlines', () => {
  const retire = { action: 'retire' }
  expect(closeDecision([{ action: 'observe' }])).toBe('NONE')
  expect(closeDecision([retire])).toBe('CLOSE')
  // A failed close is retried only after the host facts change.
  expect(closeDecision([retire, { action: 'close_result', result: 'FAILED' }])).toBe(
    'RETRY_BLOCKED'
  )
  expect(
    closeDecision([retire, { action: 'close_result', result: 'UNKNOWN' }, { action: 'observe' }])
  ).toBe('CLOSE')
  expect(
    closeDecision([retire, { action: 'close_result', result: 'CLOSED', capacity_released: false }])
  ).toBe('RELEASE_UNCONFIRMED')
  expect(
    closeDecision([retire, { action: 'close_result', result: 'CLOSED', capacity_released: true }])
  ).toBe('DONE')
  const now = Date.parse('2026-09-14T10:00:00Z')
  const deadlines = leaseDeadlines(
    {
      active_lease: {
        lease_id: 'L1',
        role: 'architect',
        issued_at: '2026-09-14T09:30:00Z',
        hard_deadline_minutes: 40
      },
      shard_leases: {
        L2: {
          lease_id: 'L2',
          role: 'architect',
          issued_at: '2026-09-14T09:59:00Z',
          hard_deadline_minutes: 1.5
        },
        L3: {
          lease_id: 'L3',
          role: 'architect',
          issued_at: '2026-09-14T09:00:00Z',
          hard_deadline_minutes: 20
        },
        L4: { lease_id: 'L4', role: 'architect', issued_at: 'unknown', hard_deadline_minutes: 20 }
      }
    },
    now
  )
  // Unverifiable and expired first, then the nearest live deadline in seconds, not rounded minutes.
  expect(deadlines.map((deadline) => [deadline.lease_id, deadline.seconds_remaining])).toEqual([
    ['L4', null],
    ['L3', -2400],
    ['L2', 30],
    ['L1', 600]
  ])
})

test('resource decisions follow changed facts, not new records, and wind-down survives terminal phases', () => {
  const retire = { action: 'retire' }
  const observe = (host: Record<string, unknown>) => ({ action: 'observe', host })
  const failed = { action: 'close_result', result: 'FAILED' }
  const unavailable = { close_available: false, controllable: true, status: 'idle' }
  const available = { close_available: true, controllable: true, status: 'idle' }
  // Re-observing the same facts after a failed close does not justify a retry.
  expect(closeDecision([observe(available), retire, failed, observe(available)])).toBe(
    'RETRY_BLOCKED'
  )
  expect(
    closeDecision([
      observe(available),
      retire,
      failed,
      observe({ ...available, status: 'stopped' })
    ])
  ).toBe('CLOSE')
  // A session that reports it cannot close never gets a close call.
  expect(closeDecision([observe(unavailable), retire])).toBe('CLOSE_UNAVAILABLE')
  expect(closeDecision([observe(unavailable), retire, failed, observe(available)])).toBe('CLOSE')
  const record = (payload: Record<string, unknown>) => ({ type: 'runtime_record', payload })
  expect(spawnDecision([record({ action: 'spawn_result', result: 'LIMIT' })])).toBe(
    'LIMIT_UNCHANGED'
  )
  expect(
    spawnDecision([
      record({ action: 'spawn_result', result: 'LIMIT' }),
      record({ action: 'observe' })
    ])
  ).toBe('LIMIT_UNCHANGED')
  expect(
    spawnDecision([
      record({ action: 'spawn_result', result: 'LIMIT' }),
      record({ action: 'close_result', result: 'CLOSED', capacity_released: true })
    ])
  ).toBe('ALLOWED')
  expect(() => assertRuntimeRecordPhase('SHIP', 'close_result')).not.toThrow()
  expect(() => assertRuntimeRecordPhase('CANCELLED', 'retire')).not.toThrow()
  expect(() => assertRuntimeRecordPhase('SHIP', 'guidance')).toThrow('TERMINAL_STATE_IMMUTABLE')
  expect(() => assertRuntimeRecordPhase('IMPLEMENTING', 'guidance')).not.toThrow()
})

test('runtime records accept negative facts, wind down historical Coordinators and lift LIMIT on new capacity', () => {
  const state = {
    agent_roles: { 'operator-1': 'operator' },
    coordinator_agent_id: 'coordinator-new',
    coordinator_agent_ids: ['coordinator-old', 'coordinator-new'],
    issued_leases: {}
  }
  const host = (patch: Record<string, unknown>) => ({
    status: 'lost',
    controllable: false,
    writer_stopped: null,
    commands_stopped: null,
    close_available: null,
    conversation_id: 'conversation',
    ...patch
  })
  // Losing control is a fact to record, not a malformed observation.
  const lost = {
    action: 'observe',
    agent_id: 'operator-1',
    agent_role: 'operator',
    host: host({ ancestor_ids: ['coordinator-new'], confirmed_by: 'coordinator-new' })
  }
  expect(() => assertRuntimeLifecycle(state, [], lost)).not.toThrow()
  // A historical Coordinator is a host resource that can be observed and retired, never a role.
  const oldCoordinator = {
    action: 'observe',
    agent_id: 'coordinator-old',
    agent_role: 'coordinator',
    host: host({ status: 'stopped', ancestor_ids: ['supervisor'], confirmed_by: 'supervisor' })
  }
  expect(() => assertRuntimeLifecycle(state, [], oldCoordinator)).not.toThrow()
  expect(() =>
    assertRuntimeLifecycle(state, [], { ...oldCoordinator, agent_role: 'operator' })
  ).toThrow('RUNTIME_ROLE_INVALID')
  const record = (payload: Record<string, unknown>) => ({ type: 'runtime_record', payload })
  const descendant = record({
    action: 'observe',
    agent_id: 'operator-1',
    agent_role: 'operator',
    host: host({ ancestor_ids: ['coordinator-old'], confirmed_by: 'coordinator-old' })
  })
  const retire = (agent: string) => ({
    action: 'retire',
    agent_id: agent,
    writer_stopped: true,
    commands_stopped: true,
    preserved_evidence: ['stopped by host'],
    next_action: 'close'
  })
  const history = [record(oldCoordinator), descendant]
  // Its subtree still in use protects it from being wound down.
  expect(() => assertRuntimeLifecycle(state, history, retire('coordinator-old'))).toThrow(
    'RUNTIME_RETIRE_SUBTREE_IN_USE'
  )
  expect(() =>
    assertRuntimeLifecycle(
      state,
      [...history, record(retire('operator-1'))],
      retire('coordinator-old')
    )
  ).not.toThrow()
  expect(() => assertRuntimeLifecycle(state, history, retire('coordinator-new'))).toThrow(
    'RUNTIME_RETIRE_UNKNOWN_ROLE'
  )
  // Capacity observations carry time and source; each new one allows one spawn attempt.
  expect(() =>
    assertRuntimeLifecycle(state, [], {
      action: 'capacity',
      agent_id: 'coordinator-new',
      capacity: { observed_at: 'yesterday', available_slots: 1, source: 'host' }
    })
  ).toThrow('RUNTIME_CAPACITY_OBSERVATION_INVALID')
  const limit = record({ action: 'spawn_result', result: 'LIMIT' })
  const capacity = (observedAt: string) =>
    record({
      action: 'capacity',
      capacity: { observed_at: observedAt, available_slots: 2, source: 'host list' }
    })
  expect(spawnDecision([limit, capacity('2026-09-14T10:00:00Z')])).toBe('ALLOWED')
  expect(
    spawnDecision([
      limit,
      capacity('2026-09-14T10:00:00Z'),
      record({ action: 'spawn_result', result: 'UNKNOWN' })
    ])
  ).toBe('LIMIT_UNCHANGED')
  // Re-recording evidence already known before the LIMIT lifts nothing.
  expect(
    spawnDecision([capacity('2026-09-14T09:00:00Z'), limit, capacity('2026-09-14T09:00:00Z')])
  ).toBe('LIMIT_UNCHANGED')
})
