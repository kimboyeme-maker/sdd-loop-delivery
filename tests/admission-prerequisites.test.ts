import { expect, test } from 'bun:test'
import type { Contract } from '../scripts/domain/contract'
import {
  externalPrerequisites,
  assertPrerequisiteEvidence
} from '../scripts/helpers/admission-prerequisites'
import { rolePublicKey, signRoleEvent } from '../scripts/resource/role-signature'

const contract: Contract = {
  revision: 'v1',
  requirements: [
    { id: 'XQ01', kind: 'must-ship', title: 'producer', acceptance: ['YS01'] },
    {
      id: 'XQ02',
      kind: 'must-ship',
      title: 'adapter',
      dependencies: ['XQ01'],
      acceptance: ['YS02']
    },
    {
      id: 'XQ03',
      kind: 'must-ship',
      title: 'consumer',
      dependencies: ['XQ02'],
      acceptance: ['YS03']
    }
  ]
}

test('external prerequisite traversal preserves transitive requirements', () => {
  expect(externalPrerequisites(contract, ['XQ03'])).toEqual(['XQ02', 'XQ01'])
  expect(externalPrerequisites(contract, ['XQ01', 'XQ02', 'XQ03'])).toEqual([])
  expect(() => externalPrerequisites(contract, ['unknown'])).toThrow(
    'ADMISSION_PREREQUISITE_INVALID'
  )
})

test('prior prerequisite needs signed current candidate coverage; a verified label is insufficient', () => {
  const candidate = {
    candidate_id: 'c1',
    environment_fingerprint: 'env',
    manifest_sha256: 'manifest',
    worktree_fingerprint: 'tree'
  }
  const state = {
    contract_revision: 'v1',
    requirements: { XQ01: 'verified' },
    issued_leases: {
      ar: {
        role: 'architect',
        agent_id: 'architect',
        authority_epoch: 1,
        contract_revision: 'v1',
        event_public_key: rolePublicKey('ar')
      }
    }
  }
  const make = (patch: Record<string, unknown> = {}) =>
    signRoleEvent(
      {
        event_id: 'V',
        role: 'architect',
        type: 'verification',
        actor: { agent_id: 'architect', lease_id: 'ar', authority_epoch: 1 },
        payload: {
          ...candidate,
          result: 'PASS',
          requirement_ids: ['XQ01'],
          acceptance_ids: ['YS01'],
          ...patch
        }
      },
      'ar'
    )
  const implementation = { event_id: 'I', type: 'implementation' }
  const pass = make()
  const check = (events: Record<string, unknown>[]) =>
    assertPrerequisiteEvidence(contract, ['XQ01'], state, events, candidate)
  expect(() => check([implementation, pass])).not.toThrow()
  for (const events of [
    [],
    [pass, implementation],
    [implementation, pass, pass],
    [implementation, { ...pass, signature: 'forged' }],
    [implementation, make({ result: 'FAIL' })],
    [implementation, make({ candidate_id: 'old' })],
    [implementation, make({ acceptance_ids: [] })],
    [implementation, pass, { type: 'verification_revoked' }]
  ])
    expect(() => check(events)).toThrow()
  expect(() =>
    assertPrerequisiteEvidence(
      contract,
      ['XQ01'],
      { ...state, requirements: { XQ01: 'pending' } },
      [implementation, pass],
      candidate
    )
  ).toThrow('ADMISSION_PREREQUISITE_NOT_VERIFIED')
})
