import { assertProductRoleHistory } from '../scripts/helpers/product-role'
import { test, expect } from 'bun:test'
import { runtimeCandidates } from '../scripts/services/runtime-candidates'
import { coordinatorProof } from '../scripts/resource/coordinator-evidence'
import { rolePublicKey } from '../scripts/resource/role-signature'

test('runtime inventory exposes reusable history without requiring an active lease', () => {
  const state = {
    authority_epoch: 1,
    coordinator_agent_id: 'coordinator',
    coordinator_event_keys: { '1': rolePublicKey('token') },
    agent_roles: { operator: 'operator' },
    issued_leases: {},
    active_lease: null
  }
  const body = {
    event_id: 'observed',
    role: 'coordinator',
    authority_epoch: 1,
    type: 'runtime_record',
    payload: {
      agent_id: 'operator',
      agent_role: 'operator',
      action: 'observe',
      authority_epoch: 1,
      coordinator_agent_id: 'coordinator',
      host: { status: 'idle', controllable: true }
    }
  }
  const signed = { ...body, coordinator_proof: coordinatorProof(body, 'token') }
  expect(() => assertProductRoleHistory(state, [signed], 'operator', 'operator')).not.toThrow()
  expect(() =>
    assertProductRoleHistory(
      state,
      [signed, { ...signed, event_id: 'tampered' }],
      'operator',
      'operator'
    )
  ).toThrow('RUNTIME_HOST_OBSERVATION_INVALID')
  expect(runtimeCandidates(state, [signed])[0]).toMatchObject({
    agent_id: 'operator',
    eligible: true,
    active_grants: [],
    requires_dispatch: true,
    host_liveness_verified: false
  })
  expect(runtimeCandidates(state, [])[0]!.eligible).toBe(false)
  expect(runtimeCandidates(state, [signed, { ...signed, event_id: 'later' }])[0]!.eligible).toBe(
    false
  )
  expect(runtimeCandidates({ ...state, authority_epoch: 2 }, [signed])[0]!.eligible).toBe(false)
  expect(
    runtimeCandidates(state, [
      signed,
      { type: 'runtime_record', payload: { agent_id: 'operator', action: 'retire' } }
    ])[0]!.reasons
  ).toContain('RUNTIME_RETIRED')
})
