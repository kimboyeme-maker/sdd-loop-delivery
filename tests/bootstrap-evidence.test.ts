import { expect, test } from 'bun:test'
import { rolePublicKey, signRoleEvent } from '../scripts/resource/role-signature'
import { assertBootstrapEvidence } from '../scripts/helpers/bootstrap-evidence'

test('bootstrap completion marker cannot replace signed original receipts', () => {
  const lease = {
    lease_id: 'lease',
    agent_id: 'operator',
    role: 'operator',
    event_public_key: rolePublicKey('token')
  }
  const receipts = ['OPEN', 'REAUTHENTICATE', 'READY'].map((stage, index) => ({
    stage,
    agentId: 'operator',
    processId: String(index),
    success: true
  }))
  const events = receipts.map((payload, index) => {
    const body = {
      event_id: String(index),
      contract_revision: 'v1',
      role: 'operator',
      type: 'capability_probe',
      payload,
      actor: { agent_id: 'operator', lease_id: 'lease', authority_epoch: 1 }
    }
    return signRoleEvent(body, 'token')
  })
  const state = {
    authority_epoch: 1,
    contract_revision: 'v1',
    bootstrap_receipts: { lease: { lease_id: 'lease', event_ids: ['0', '1', '2'], receipts } }
  }
  expect(() => assertBootstrapEvidence(state, lease, events, 'token', receipts)).not.toThrow()
  expect(() => assertBootstrapEvidence(state, lease, [], 'token', receipts)).toThrow(
    'AGENT_BOOTSTRAP_EVIDENCE_INVALID'
  )
  expect(() =>
    assertBootstrapEvidence(state, lease, [...events, events[0]!], 'token', receipts)
  ).toThrow('AGENT_BOOTSTRAP_EVIDENCE_INVALID')
  expect(() => assertBootstrapEvidence(state, lease, events, 'wrong', receipts)).toThrow(
    'AGENT_BOOTSTRAP_EVIDENCE_INVALID'
  )
  expect(() =>
    assertBootstrapEvidence(state, lease, events, 'token', [
      { ...receipts[0], processId: 'other' },
      ...receipts.slice(1)
    ])
  ).toThrow('AGENT_BOOTSTRAP_EVIDENCE_INVALID')
})
