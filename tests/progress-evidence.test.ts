import { expect, test } from 'bun:test'
import { hasProgressEvidence } from '../scripts/helpers/progress-evidence'
import { rolePublicKey, signRoleEvent } from '../scripts/resource/role-signature'

test('completion needs linked current signed evidence, not merely an event name', () => {
  const candidate = {
    candidate_id: 'one',
    environment_fingerprint: 'env',
    manifest_sha256: 'manifest',
    worktree_fingerprint: 'tree'
  }
  const state = {
    requirements: { XQ01: 'verified' },
    issued_leases: {
      op: {
        role: 'operator',
        agent_id: 'op',
        authority_epoch: 1,
        event_public_key: rolePublicKey('op')
      },
      ar: {
        role: 'architect',
        agent_id: 'ar',
        authority_epoch: 1,
        event_public_key: rolePublicKey('ar')
      }
    }
  }
  const implementation = signRoleEvent(
    {
      event_id: 'I',
      role: 'operator',
      type: 'implementation',
      actor: { agent_id: 'op', lease_id: 'op', authority_epoch: 1 },
      payload: { candidate }
    },
    'op'
  )
  const verification = signRoleEvent(
    {
      event_id: 'V',
      role: 'architect',
      type: 'verification',
      actor: { agent_id: 'ar', lease_id: 'ar', authority_epoch: 1 },
      payload: { ...candidate, result: 'PASS', requirement_ids: ['XQ01'] }
    },
    'ar'
  )
  const entry = { requirement_ids: ['XQ01'], evidence: ['V'] }
  expect(hasProgressEvidence(state, entry, [implementation, verification])).toBe(true)
  expect(hasProgressEvidence(state, entry, [])).toBe(false)
  expect(hasProgressEvidence(state, { evidence: ['V'] }, [implementation, verification])).toBe(
    false
  )
  expect(hasProgressEvidence(state, entry, [implementation, verification, verification])).toBe(
    false
  )
  expect(
    hasProgressEvidence(state, entry, [implementation, { ...verification, signature: 'forged' }])
  ).toBe(false)
  expect(
    hasProgressEvidence(state, entry, [
      implementation,
      verification,
      { type: 'contract_amendment' }
    ])
  ).toBe(false)
  expect(
    hasProgressEvidence({ ...state, requirements: { XQ01: 'pending' } }, entry, [
      implementation,
      verification
    ])
  ).toBe(false)
})
