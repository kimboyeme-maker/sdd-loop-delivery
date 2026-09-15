import { createHash, createPrivateKey, sign } from 'node:crypto'
import { test, expect } from 'bun:test'
import { rolePublicKey, signRoleEvent, verifyRoleEvent } from '../scripts/resource/role-signature'
import { assertRoleEvidence } from '../scripts/helpers/role-evidence'

test('role evidence verifies with archived public material, rejects tampering and foreign leases', () => {
  const event = signRoleEvent(
    {
      event_id: 'EVT-1',
      role: 'architect',
      type: 'verification',
      actor: { agent_id: 'reviewer', lease_id: 'lease', authority_epoch: 2 },
      payload: { result: 'PASS' }
    },
    'role-secret'
  )
  const key = rolePublicKey('role-secret')
  const state = {
    contract_revision: 'v1',
    issued_leases: {
      lease: {
        role: 'architect',
        agent_id: 'reviewer',
        authority_epoch: 2,
        contract_revision: 'v1',
        event_public_key: key
      }
    }
  }
  expect(verifyRoleEvent(event, key)).toBe(true)
  expect(verifyRoleEvent({ ...event, signature: String(event.signature) + '!' }, key)).toBe(false)
  expect(
    verifyRoleEvent({ ...event, signature: String(event.signature).replace(/=+$/, '') }, key)
  ).toBe(false)
  expect(verifyRoleEvent(event, key + '\n')).toBe(false)
  expect(verifyRoleEvent(event, rolePublicKey('other-secret'))).toBe(false)
  expect(verifyRoleEvent({ ...event, payload: { result: 'FAIL' } }, key)).toBe(false)
  expect(() => assertRoleEvidence(state, event, 'architect')).not.toThrow()
  expect(() => assertRoleEvidence(state, event, 'operator')).toThrow(
    'ROLE_EVIDENCE_PROVENANCE_INVALID'
  )
  expect(() =>
    assertRoleEvidence({ ...state, contract_revision: 'v2' }, event, 'architect')
  ).toThrow('ROLE_EVIDENCE_CONTRACT_STALE')
  expect(() => assertRoleEvidence(state, { ...event, signature: 'forged' }, 'architect')).toThrow(
    'ROLE_EVIDENCE_PROVENANCE_INVALID'
  )
  expect(() => assertRoleEvidence({ ...state, issued_leases: {} }, event, 'architect')).toThrow(
    'ROLE_EVIDENCE_PROVENANCE_INVALID'
  )
})

test('a valid signature cannot substitute for missing or malformed identity bindings', () => {
  const key = rolePublicKey('role-secret')
  for (const identity of [
    {},
    { agent_id: '', authority_epoch: 2 },
    { agent_id: 'reviewer', authority_epoch: 0 },
    { agent_id: 'reviewer', authority_epoch: 1.5 },
    { agent_id: 'reviewer', authority_epoch: '2' }
  ]) {
    const event = signRoleEvent(
      {
        event_id: 'EVT-2',
        role: 'architect',
        type: 'verification',
        actor: { lease_id: 'lease', ...identity },
        payload: { result: 'PASS' }
      },
      'role-secret'
    )
    const state = {
      issued_leases: { lease: { role: 'architect', event_public_key: key, ...identity } }
    }
    expect(verifyRoleEvent(event, key)).toBe(true)
    expect(() => assertRoleEvidence(state, event, 'architect')).toThrow(
      'ROLE_EVIDENCE_PROVENANCE_INVALID'
    )
  }
  const actor = { agent_id: 'reviewer', authority_epoch: 2, lease_id: 'lease' }
  const event = signRoleEvent({ event_id: 'EVT-3', role: 'architect', actor }, 'role-secret')
  const lease = { ...actor, role: 'architect', event_public_key: key }
  expect(() => assertRoleEvidence({ issued_leases: { lease } }, event, 'architect')).not.toThrow()
  expect(() =>
    assertRoleEvidence(
      { issued_leases: { lease: { ...lease, lease_id: 'other' } } },
      event,
      'architect'
    )
  ).toThrow('ROLE_EVIDENCE_PROVENANCE_INVALID')
  expect(() =>
    assertRoleEvidence({ issued_leases: Object.create({ lease }) }, event, 'architect')
  ).toThrow('ROLE_EVIDENCE_PROVENANCE_INVALID')
})

test('role signatures reject lossy JSON and token hashes are not signing seeds', () => {
  for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, () => 1, new Date()])
    expect(() => signRoleEvent({ payload: { value } }, 'role-secret')).toThrow()
  let reads = 0
  const body = {
    get payload() {
      reads++
      return 'side effect'
    }
  }
  expect(() => signRoleEvent(body, 'role-secret')).toThrow('CANONICAL_VALUE_INVALID')
  expect(reads).toBe(0)
  const valid = signRoleEvent({ payload: { value: null } }, 'role-secret'),
    key = rolePublicKey('role-secret')
  expect(verifyRoleEvent({ ...valid, payload: { value: Infinity } }, key)).toBe(false)
  const unsigned = { payload: { value: null }, signature_algorithm: 'ed25519-role-v1' }
  const hashSeed = createHash('sha256').update('role-secret').digest()
  const wrongKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), hashSeed]),
    format: 'der',
    type: 'pkcs8'
  })
  const forged = {
    ...unsigned,
    signature: sign(null, Buffer.from(JSON.stringify(unsigned)), wrongKey).toString('base64')
  }
  expect(verifyRoleEvent(forged, key)).toBe(false)
  expect(verifyRoleEvent(valid, key)).toBe(true)
})
