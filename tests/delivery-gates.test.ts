import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mintRoleCapability, roleCapabilityToken } from '../scripts/resource/role-capability'
import { coordinatorRuntimeReceipt } from '../scripts/helpers/coordinator-runtime'
import {
  assertDispatchMetadata,
  hasPriorNoProgress,
  resumeCheckpointRecovery
} from '../scripts/helpers/dispatch-metadata'
import {
  assertChallengeResponse,
  assertDesignSupersession,
  supersededDesignResolutions
} from '../scripts/helpers/design-challenge'
import { assertOracleSensitivityResults } from '../scripts/domain/policies/acceptance-execution'
import { coordinatorProof } from '../scripts/resource/coordinator-evidence'
import { rolePublicKey, signRoleEvent } from '../scripts/resource/role-signature'
import { coordinatorReceipt } from './fixtures/runtime-receipt'

type Item = Record<string, unknown>

test('role capabilities are minted privately and only the bound, owner-only file authenticates', () => {
  const root = mkdtempSync(join(tmpdir(), 'capability-'))
  try {
    const env = { SDD_LOOP_CAPABILITY_DIR: root }
    const minted = mintRoleCapability('LEASE-1', env)
    const grant = {
      capability_file: minted.path,
      agent_token_hash: minted.hash,
      event_public_key: minted.publicKey
    }
    const token = roleCapabilityToken(grant, { SDD_LOOP_AGENT_TOKEN_FILE: minted.path })
    expect(rolePublicKey(token)).toBe(minted.publicKey)
    expect(() => mintRoleCapability('LEASE-1', env)).toThrow()
    expect(() => roleCapabilityToken(grant, {})).toThrow('ROLE_CAPABILITY_FILE_REQUIRED')
    const other = mintRoleCapability('LEASE-2', env)
    expect(() => roleCapabilityToken(grant, { SDD_LOOP_AGENT_TOKEN_FILE: other.path })).toThrow(
      'ROLE_CAPABILITY_FILE_REQUIRED'
    )
    const link = join(root, 'link.token')
    symlinkSync(minted.path, link)
    expect(() =>
      roleCapabilityToken({ ...grant, capability_file: link }, { SDD_LOOP_AGENT_TOKEN_FILE: link })
    ).toThrow('ROLE_CAPABILITY_FILE_INSECURE')
    chmodSync(minted.path, 0o644)
    expect(() => roleCapabilityToken(grant, { SDD_LOOP_AGENT_TOKEN_FILE: minted.path })).toThrow(
      'ROLE_CAPABILITY_FILE_INSECURE'
    )
    chmodSync(minted.path, 0o600)
    expect(() =>
      roleCapabilityToken(
        { ...grant, agent_token_hash: other.hash },
        { SDD_LOOP_AGENT_TOKEN_FILE: minted.path }
      )
    ).toThrow('ROLE_CAPABILITY_INVALID')
    expect(readFileSync(minted.path, 'utf8')).toBe(token)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Coordinator authority binds the actual spawn identity, model and isolation', () => {
  expect(
    coordinatorRuntimeReceipt(coordinatorReceipt('/root/coordinator'), '/root/coordinator')
  ).toMatchObject({
    agent_id: '/root/coordinator'
  })
  for (const [patch, code] of [
    [{ agent_id: '/root/other' }, 'COORDINATOR_RUNTIME_IDENTITY_MISMATCH'],
    [{ model: 'gpt-substitute' }, 'COORDINATOR_RUNTIME_SELECTION_INVALID'],
    [{ reasoning_effort: 'low' }, 'COORDINATOR_RUNTIME_SELECTION_INVALID'],
    [{ isolation: 'fork_turns=all' }, 'COORDINATOR_RUNTIME_LINEAGE_INVALID'],
    [{ extra: true }, 'HOST_RECEIPT_INVALID']
  ] as const)
    expect(() =>
      coordinatorRuntimeReceipt(
        { ...coordinatorReceipt('/root/coordinator'), ...patch },
        '/root/coordinator'
      )
    ).toThrow(code)
})

test('dispatch metadata reuses the current Architect unless an explicit mode and reason apply', () => {
  const lease = (id: string, agent: string, key: string) => ({
    lease_id: id,
    role: 'architect',
    agent_id: agent,
    authority_epoch: 1,
    contract_revision: 'v1',
    event_public_key: rolePublicKey(key)
  })
  const finding = signRoleEvent(
    {
      event_id: 'EVT-F',
      role: 'architect',
      type: 'finding',
      actor: { agent_id: 'ar1', lease_id: 'L1', authority_epoch: 1 },
      payload: { id: 'FX01' }
    },
    'ar1'
  )
  const verification = {
    type: 'verification',
    role: 'architect',
    actor: { agent_id: 'ar1', authority_epoch: 1 }
  }
  const state = {
    phase: 'ARCHITECT_VERIFY',
    authority_epoch: 1,
    contract_revision: 'v1',
    issued_leases: { L1: lease('L1', 'ar1', 'ar1') },
    findings: { FX01: { id: 'FX01', status: 'open', evidence: 'EVT-F' } }
  }
  const events = [finding, verification]
  const check = (input: Item, current: Item = state) =>
    assertDispatchMetadata(current, events, {
      agent: 'architect',
      agentId: 'ar1',
      verificationMode: 'standard',
      workItem: 'verify',
      ...input
    })
  expect(() => check({})).not.toThrow()
  expect(() => check({ agentId: 'ar2' })).toThrow(
    'FRESH_ARCHITECT_REQUIRES_EXPLICIT_MODE_AND_REASON'
  )
  expect(() => check({ freshReason: 'capability-or-authority-incident' })).toThrow(
    'STANDARD_VERIFICATION_FORBIDS_OVERRIDE_METADATA'
  )
  const fresh = { agentId: 'ar2', verificationMode: 'fresh-independent' }
  expect(() => check({ ...fresh, freshReason: 'design-counsel-participation' })).not.toThrow()
  expect(() => check({ ...fresh, freshReason: 'preference' })).toThrow(
    'FRESH_ARCHITECT_REASON_INVALID'
  )
  expect(() =>
    check({ ...fresh, agentId: 'ar1', freshReason: 'design-counsel-participation' })
  ).toThrow('FRESH_ARCHITECT_REQUIRES_DISTINCT_PRIOR_ARCHITECT')
  const bounded = { verificationMode: 'bounded-correction', correctionFindingId: 'FX01' }
  expect(() => check(bounded)).not.toThrow()
  expect(() => check({ ...bounded, agentId: 'ar2' })).toThrow(
    'BOUNDED_CORRECTION_REQUIRES_ARCHITECT_REUSE'
  )
  expect(() => check({ ...bounded, correctionFindingId: 'FX99' })).toThrow(
    'BOUNDED_CORRECTION_REQUIRES_TRACKED_FINDING'
  )
  expect(() =>
    check(bounded, {
      ...state,
      findings: { FX01: { ...state.findings.FX01, status: 'resolved' } }
    })
  ).toThrow('BOUNDED_CORRECTION_REQUIRES_OPEN_FINDING')
  expect(() => check(bounded, { ...state, phase: 'FINAL_VERIFY' })).toThrow(
    'BOUNDED_CORRECTION_REQUIRES_ARCHITECT_VERIFY'
  )
  expect(() =>
    check({
      agent: 'operator',
      verificationMode: 'standard',
      freshReason: 'capability-or-authority-incident'
    })
  ).toThrow('VERIFICATION_MODE_ARCHITECT_ONLY')
  expect(() => check({ verificationMode: 'design-counsel', packet: 'PC01' })).toThrow(
    'DESIGN_COUNSEL_METADATA_INVALID'
  )
  expect(() => check({ repairProbeRoot: 'host', packet: 'PC01' })).toThrow(
    'REPAIR_PROBE_FORBIDS_PRODUCT_DISPATCH_METADATA'
  )
  // A no-progress observation for the same packet disqualifies the bounded Operator profile.
  const leases = { issued_leases: { OP: { packet_id: 'PC01', work_item: 'a' } } }
  const noProgress = [
    { type: 'operator_reconcile', payload: { no_progress: true, lease_id: 'OP' } }
  ]
  expect(hasPriorNoProgress(leases, noProgress, 'PC01', 'a')).toBe(true)
  expect(hasPriorNoProgress(leases, noProgress, 'PC02', 'a')).toBe(false)
})

test('resume checkpoints must be signed safe checkpoints of a revoked lease in the same phase', () => {
  const lease = {
    lease_id: 'OP1',
    role: 'operator',
    agent_id: 'op',
    authority_epoch: 1,
    contract_revision: 'v1',
    event_public_key: rolePublicKey('op')
  }
  const checkpoint = (patch: Item = {}) =>
    signRoleEvent(
      {
        event_id: 'CP1',
        role: 'operator',
        type: 'checkpoint',
        state: 'IMPLEMENTING',
        contract_revision: 'v1',
        actor: { agent_id: 'op', lease_id: 'OP1', authority_epoch: 1 },
        payload: { status: 'SAFE_TO_RESUME', resume: { next_action: 'rerun check' } },
        ...patch
      },
      'op'
    )
  const state = {
    phase: 'IMPLEMENTING',
    authority_epoch: 1,
    contract_revision: 'v1',
    issued_leases: { OP1: lease }
  }
  expect(resumeCheckpointRecovery(state, [checkpoint()], 'operator', 'CP1')).toMatchObject({
    source: 'checkpoint',
    predecessor_lease_id: 'OP1',
    next_action: 'rerun check'
  })
  for (const [events, current] of [
    [[checkpoint({ payload: { status: 'UNSAFE_PARTIAL' } })], state],
    [[checkpoint({ state: 'OPERATOR_READBACK' })], state],
    [[checkpoint()], { ...state, active_lease: lease }],
    [[{ ...checkpoint(), signature: 'forged' }], state],
    [[checkpoint(), checkpoint()], state]
  ] as const) {
    expect(() => resumeCheckpointRecovery(current, [...events], 'operator', 'CP1')).toThrow()
  }
})

test('design challenges must be answered revision by revision and supersession must be complete', () => {
  const token = 'coordinator'
  const state = {
    authority_epoch: 1,
    contract_revision: 'v1',
    sdd_fingerprint: 'source',
    coordinator_event_keys: { '1': rolePublicKey(token) }
  }
  const resolution = (id: string, payload: Item) => {
    const body = {
      event_id: id,
      role: 'coordinator',
      type: 'design_resolution',
      authority_epoch: 1,
      contract_revision: 'v1',
      sdd_fingerprint: 'source',
      payload
    }
    return {
      ...body,
      signature: createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
    }
  }
  const challenge = resolution('CH', {
    decision: 'CHALLENGE',
    required_revisions: ['fix lifecycle', 'fix packets']
  })
  const answer = (patch: Item = {}) => ({
    responds_to_design_resolution_event_id: 'CH',
    challenge_responses: [
      {
        required_revision: 'fix lifecycle',
        disposition: 'CORRECTED',
        evidence: ['new state table']
      },
      {
        required_revision: 'fix packets',
        disposition: 'UPHELD_WITH_EVIDENCE',
        evidence: ['dependency trace']
      }
    ],
    ...patch
  })
  expect(() => assertChallengeResponse(state, [challenge], answer(), token)).not.toThrow()
  expect(() => assertChallengeResponse(state, [challenge], {}, token)).toThrow(
    'DESIGN_PROPOSAL_MUST_ANSWER_LATEST_CHALLENGE'
  )
  expect(() =>
    assertChallengeResponse(
      state,
      [challenge],
      answer({ challenge_responses: answer().challenge_responses.slice(1) }),
      token
    )
  ).toThrow('DESIGN_PROPOSAL_CHALLENGE_RESPONSE_INCOMPLETE')
  expect(() => assertChallengeResponse(state, [], answer(), token)).toThrow(
    'DESIGN_PROPOSAL_CHALLENGE_RESPONSE_UNEXPECTED'
  )
  const converged = resolution('CV', { decision: 'CONVERGED' })
  expect(() => assertChallengeResponse(state, [challenge, converged], {}, token)).not.toThrow()

  const old = resolution('OLD', { decision: 'CONVERGED' })
  const replacement = resolution('NEW', { decision: 'CONVERGED' })
  const supersede = (patch: Item = {}) => ({
    design_resolution_event_id: 'NEW',
    superseded_design_resolution_ids: ['OLD'],
    design_supersession_evidence: ['new route replaces every old path'],
    ...patch
  })
  const events = [old, replacement]
  expect(() => assertDesignSupersession(state, supersede(), events, token)).not.toThrow()
  for (const patch of [
    { superseded_design_resolution_ids: ['NEW'] },
    { superseded_design_resolution_ids: ['MISSING'] },
    { design_supersession_evidence: [] },
    { design_resolution_event_id: 'CH' }
  ])
    expect(() =>
      assertDesignSupersession(state, supersede(patch), [...events, challenge], token)
    ).toThrow('DESIGN_SUPERSESSION_INVALID')
  // Only an epoch-verifiable ADMIT retires a design for independence purposes.
  const admitBody = {
    event_id: 'ADMIT',
    role: 'coordinator',
    type: 'contract_admission',
    authority_epoch: 1,
    payload: { decision: 'ADMIT', ...supersede() }
  }
  const admit = { ...admitBody, coordinator_proof: coordinatorProof(admitBody, token) }
  expect([...supersededDesignResolutions(state, [admit])]).toEqual(['OLD'])
  expect([
    ...supersededDesignResolutions(state, [
      { ...admitBody, coordinator_proof: { signature: 'x', signature_algorithm: 'y' } }
    ])
  ]).toEqual([])
})

test('a PASS covering a required sensitive oracle carries exactly one executed flip per acceptance', () => {
  const result = (id: string) => ({
    acceptance_id: id,
    perturbation: 'remove guard',
    result: 'PASS_TO_FAIL_TO_PASS',
    evidence: ['check failed then passed']
  })
  expect(() => assertOracleSensitivityResults(['YS01'], [result('YS01')])).not.toThrow()
  expect(() => assertOracleSensitivityResults([], undefined)).not.toThrow()
  expect(() => assertOracleSensitivityResults(['YS01'], undefined)).toThrow(
    'ORACLE_SENSITIVITY_RESULTS_REQUIRED'
  )
  expect(() => assertOracleSensitivityResults(['YS01', 'YS02'], [result('YS01')])).toThrow(
    'ORACLE_SENSITIVITY_RESULTS_REQUIRED'
  )
  expect(() => assertOracleSensitivityResults(['YS01'], [result('YS01'), result('YS01')])).toThrow(
    'ORACLE_SENSITIVITY_RESULT_SCOPE_INVALID'
  )
  expect(() =>
    assertOracleSensitivityResults(['YS01'], [{ ...result('YS01'), result: 'PASS' }])
  ).toThrow('ORACLE_SENSITIVITY_RESULT_INVALID')
  expect(() => assertOracleSensitivityResults([], [result('YS01')])).toThrow(
    'ORACLE_SENSITIVITY_RESULT_SCOPE_INVALID'
  )
})
