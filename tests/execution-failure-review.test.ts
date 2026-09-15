import { designProposalFixture, designResolutionFixture } from './fixtures/design-proposal'
import { rolePublicKey, signRoleEvent } from '../scripts/resource/role-signature'
import { expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertExecutionFailureReview } from '../scripts/helpers/execution-failure-review'

test('design repair requires unique authenticated Coordinator resolution', () => {
  const state = {
    issued_leases: {
      ar: {
        role: 'architect',
        agent_id: 'architect',
        authority_epoch: 1,
        contract_revision: 'v1',
        event_public_key: rolePublicKey('ar')
      }
    },
    authority_epoch: 1,
    contract_revision: 'v1',
    sdd_fingerprint: 'source',
    pending_execution_failure: { root_cause_key: 'race' }
  }
  const proposal = signRoleEvent(
    {
      event_id: 'EVT-proposal',
      role: 'architect',
      type: 'design_proposal',
      actor: { agent_id: 'architect', lease_id: 'ar', authority_epoch: 1 },
      contract_revision: 'v1',
      sdd_fingerprint: 'source',
      payload: designProposalFixture()
    },
    'ar'
  )
  const payload = {
    execution_packets: [{ id: 'PC01' }],
    design_resolution_event_id: 'EVT-resolution',
    selected_route_id: 'RT01',
    execution_failure_review: {
      root_cause_key: 'race',
      cause_evidence: ['trace'],
      execution_topology_findings: ['owner closes too late'],
      revised_execution_packet_ids: ['PC01'],
      route_change: 'close before callback',
      falsifier: 'callback observes open owner',
      route_change_kind: 'DESIGN_REPAIR'
    }
  }
  const body = {
    event_id: 'EVT-resolution',
    role: 'coordinator',
    type: 'design_resolution',
    authority_epoch: 1,
    contract_revision: 'v1',
    sdd_fingerprint: 'source',
    payload: {
      ...designResolutionFixture(),
      decision: 'CONVERGED',
      authority_classification: 'COORDINATOR_OWNED',
      selected_route_id: 'RT01'
    }
  }
  const event = {
    ...body,
    signature: createHmac('sha256', 'token').update(JSON.stringify(body)).digest('hex')
  }
  expect(() =>
    assertExecutionFailureReview(state, payload, [proposal, event], 'token')
  ).not.toThrow()
  expect(() => assertExecutionFailureReview(state, payload, [event], 'token')).toThrow(
    'DESIGN_RESOLUTION_PROPOSAL_INVALID'
  )
  for (const patch of [
    { review_coverage: [] },
    { proposal_event_id: 'missing' },
    { falsifier_evidence: [] }
  ]) {
    const changed = { ...body, payload: { ...body.payload, ...patch } }
    const signed = {
      ...changed,
      signature: createHmac('sha256', 'token').update(JSON.stringify(changed)).digest('hex')
    }
    expect(() =>
      assertExecutionFailureReview(state, payload, [proposal, signed], 'token')
    ).toThrow()
  }
  for (const events of [
    [],
    [event, event],
    [{ ...event, signature: 'forged' }],
    [{ ...event, role: 'operator' }]
  ])
    expect(() => assertExecutionFailureReview(state, payload, events, 'token')).toThrow()
  for (const change of [
    { authority_epoch: 2 },
    { contract_revision: 'v2' },
    { sdd_fingerprint: 'changed' },
    { payload: { ...body.payload, selected_route_id: 'RT02' } }
  ]) {
    const changed = { ...body, ...change }
    const signed = {
      ...changed,
      signature: createHmac('sha256', 'token').update(JSON.stringify(changed)).digest('hex')
    }
    expect(() => assertExecutionFailureReview(state, payload, [signed], 'token')).toThrow(
      'CONTRACT_ADMISSION_DESIGN_RESOLUTION_INVALID'
    )
  }
  for (const type of ['timeout_decision', 'contract_amendment', 'coordinator_takeover'])
    expect(() => assertExecutionFailureReview(state, payload, [event, { type }], 'token')).toThrow(
      'CONTRACT_ADMISSION_DESIGN_RESOLUTION_STALE'
    )
  const initial = { ...state, pending_execution_failure: null }
  expect(() =>
    assertExecutionFailureReview(initial, payload, [proposal, event], 'token')
  ).not.toThrow()
  expect(() => assertExecutionFailureReview(initial, payload, [], 'token')).toThrow(
    'DESIGN_RESOLUTION_REQUIRED_BEFORE_READMISSION'
  )
  const optional = {
    ...payload,
    execution_failure_review: {
      ...payload.execution_failure_review,
      route_change_kind: 'IMPLEMENTATION_REPAIR'
    }
  }
  expect(() => assertExecutionFailureReview(state, optional, [], 'token')).toThrow(
    'DESIGN_RESOLUTION_REQUIRED_BEFORE_READMISSION'
  )
})

test('CLI stamps current design bindings and rejected authentication leaves no decision behind', () => {
  const root = mkdtempSync(join(tmpdir(), 'design-resolution-binding-'))
  const sdd = join(root, 'task.md')
  const source = '# isolated design fixture\n'
  const state = {
    protocol: 'control-plane/state-v2',
    phase: 'CONTRACT_DRAFT',
    revision: 1,
    authority_epoch: 3,
    coordinator_event_keys: { '3': rolePublicKey('token') },
    contract_revision: 'v1',
    sdd_fingerprint: createHash('sha256').update(source).digest('hex'),
    issued_leases: {
      ar: {
        role: 'architect',
        agent_id: 'architect',
        authority_epoch: 3,
        contract_revision: 'v1',
        event_public_key: rolePublicKey('ar')
      }
    },
    coordinator_token_hash: createHash('sha256').update('token').digest('hex')
  }
  const proposal = signRoleEvent(
    {
      event_id: 'EVT-proposal',
      role: 'architect',
      type: 'design_proposal',
      actor: { agent_id: 'architect', lease_id: 'ar', authority_epoch: 3 },
      contract_revision: 'v1',
      sdd_fingerprint: state.sdd_fingerprint,
      payload: designProposalFixture()
    },
    'ar'
  )
  const proposalLog = JSON.stringify(proposal) + '\n'
  const resolution = {
    ...designResolutionFixture(),
    decision: 'CONVERGED',
    authority_classification: 'COORDINATOR_OWNED',
    selected_route_id: 'RT01',
    authority_epoch: 999,
    contract_revision: 'caller-cannot-select-binding'
  }
  const run = (token: string) =>
    Bun.spawnSync(
      [
        process.execPath,
        `${import.meta.dir}/../scripts/main.ts`,
        'record',
        '--sdd',
        sdd,
        '--role',
        'coordinator',
        '--expected-state',
        'CONTRACT_DRAFT',
        '--expected-revision',
        'v1',
        '--type',
        'design_resolution',
        '--payload-json',
        JSON.stringify(resolution)
      ],
      { env: { ...process.env, SDD_LOOP_COORDINATOR_TOKEN: token } }
    )
  try {
    writeFileSync(sdd, source)
    writeFileSync(sdd + '.loop.json', JSON.stringify(state))
    writeFileSync(sdd + '.events.jsonl', proposalLog)
    let result = run('wrong-key')
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('COORDINATOR_AUTH_INVALID')
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(JSON.stringify(state))
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(proposalLog)
    result = run('token')
    expect(result.stderr.toString()).toBe('')
    expect(result.exitCode).toBe(0)
    const event = JSON.parse(
      readFileSync(sdd + '.events.jsonl', 'utf8')
        .trim()
        .split('\n')
        .at(-1)!
    )
    expect(event.authority_epoch).toBe(3)
    expect(event.contract_revision).toBe('v1')
    expect(event.sdd_fingerprint).toBe(state.sdd_fingerprint)
    expect(() =>
      assertExecutionFailureReview(
        state,
        { selected_route_id: 'RT01', design_resolution_event_id: event.event_id },
        [proposal, event],
        'token'
      )
    ).not.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
