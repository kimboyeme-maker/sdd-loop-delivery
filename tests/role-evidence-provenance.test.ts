import { expect, test } from 'bun:test'
import { assertRoleEvidence, assertRoleProvenance } from '../scripts/helpers/role-evidence'
import { rolePublicKey, signRoleEvent } from '../scripts/resource/role-signature'

const TOKEN = 'operator-lease-capability'

/** One signed role event and the state that issued its lease. */
function fixture(leaseRevision: string, stateRevision: string) {
  const grant = {
    role: 'operator',
    lease_id: 'LEASE-1',
    agent_id: 'agent-1',
    authority_epoch: 1,
    contract_revision: leaseRevision,
    event_public_key: rolePublicKey(TOKEN)
  }
  const body = {
    event_id: 'EVT-1',
    role: 'operator',
    type: 'capability_probe',
    actor: { agent_id: 'agent-1', lease_id: 'LEASE-1', authority_epoch: 1 },
    payload: {}
  }
  const event = signRoleEvent(body, TOKEN)
  return {
    event,
    state: {
      contract_revision: stateRevision,
      issued_leases: { 'LEASE-1': grant }
    } as Record<string, unknown>
  }
}

test('an amendment retires a lease for new evidence without unauthenticating what it already signed', () => {
  const current = fixture('SDD-v2', 'SDD-v2')
  expect(() => assertRoleProvenance(current.state, current.event, 'operator')).not.toThrow()
  expect(() => assertRoleEvidence(current.state, current.event, 'operator')).not.toThrow()

  // The same event after the contract was amended. It was genuine when written and stays genuine:
  // the SHIP gate re-authenticates every event of the epoch, so treating a stale lease as forgery
  // would make any delivery that amends mid-round permanently unshippable.
  const amended = fixture('SDD-v2', 'SDD-v4')
  expect(() => assertRoleProvenance(amended.state, amended.event, 'operator')).not.toThrow()
  // Using it to satisfy a current obligation is still refused, which is a different question.
  expect(() => assertRoleEvidence(amended.state, amended.event, 'operator')).toThrow(
    'ROLE_EVIDENCE_CONTRACT_STALE'
  )
})

test('provenance still rejects an event whose actor does not match its lease or its signature', () => {
  const { state, event } = fixture('SDD-v2', 'SDD-v2')
  const wrongAgent = {
    ...event,
    actor: { agent_id: 'agent-2', lease_id: 'LEASE-1', authority_epoch: 1 }
  }
  expect(() => assertRoleProvenance(state, wrongAgent, 'operator')).toThrow(
    'ROLE_EVIDENCE_PROVENANCE_INVALID'
  )
  const tampered = { ...event, type: 'implementation' }
  expect(() => assertRoleProvenance(state, tampered, 'operator')).toThrow(
    'ROLE_EVIDENCE_PROVENANCE_INVALID'
  )
  const unknownLease = { contract_revision: 'SDD-v2', issued_leases: {} }
  expect(() => assertRoleProvenance(unknownLease, event, 'operator')).toThrow(
    'ROLE_EVIDENCE_PROVENANCE_INVALID'
  )
})
