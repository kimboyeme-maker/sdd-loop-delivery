import { expect, test } from 'bun:test'
import {
  assertAdmissionResponsibility,
  assertAdmissionAuthority
} from '../scripts/domain/policies/admission-responsibility'

test('admission keeps role duties separate and requires concrete implementation and verification scope', () => {
  const payload = {
    responsibility: {
      decision_owner: 'coordinator',
      implementation_owner: 'operator',
      verification_owner: 'architect',
      approval_authority: 'current user scope'
    },
    modification_packages: ['.'],
    workload: {
      affected_packages: ['.'],
      verification_surfaces: ['callback order'],
      confidence: 'HIGH'
    },
    difficulty: { level: 'ROUTINE', drivers: ['local change'] }
  }
  expect(() => assertAdmissionResponsibility(payload)).not.toThrow()
  expect(() =>
    assertAdmissionResponsibility({
      ...payload,
      workload: { ...payload.workload, confidence: 'MEDIUM' }
    })
  ).not.toThrow()
  for (const patch of [
    { responsibility: { ...payload.responsibility, verification_owner: 'operator' } },
    { responsibility: { ...payload.responsibility, decision_owner: 'architect' } },
    { modification_packages: [] },
    { modification_packages: ['.', '.'] },
    { workload: { ...payload.workload, verification_surfaces: [] } },
    { workload: { ...payload.workload, confidence: 'LOW' } },
    { difficulty: { level: 'ROUTINE', drivers: [] } }
  ])
    expect(() => assertAdmissionResponsibility({ ...payload, ...patch })).toThrow()
})

test('admission authority and packages must match the normative ownership table', () => {
  const contract = {
    revision: 'v1',
    requirements: [],
    ownership: { approval_authority: 'user', packages: ['packages/a', 'packages/b'] }
  }
  const payload = {
    responsibility: { approval_authority: 'user' },
    modification_packages: ['packages/a'],
    workload: { affected_packages: ['packages/a', 'packages/b'] }
  }
  expect(() => assertAdmissionAuthority(contract, payload)).not.toThrow()
  for (const patch of [
    { responsibility: { approval_authority: 'coordinator' } },
    { modification_packages: ['.'] },
    { modification_packages: ['packages/a-extra'] },
    { modification_packages: ['packages/a/../b'] },
    { modification_packages: [] },
    { workload: { affected_packages: ['outside'] } }
  ])
    expect(() => assertAdmissionAuthority(contract, { ...payload, ...patch })).toThrow()
  expect(() => assertAdmissionAuthority({ revision: 'v1', requirements: [] }, payload)).toThrow(
    'CONTRACT_OWNERSHIP_REQUIRED'
  )
  expect(() =>
    assertAdmissionAuthority(
      { ...contract, ownership: { approval_authority: 'user', packages: ['.'] } },
      {
        responsibility: { approval_authority: 'user' },
        modification_packages: ['.'],
        workload: { affected_packages: ['.'] }
      }
    )
  ).not.toThrow()
})
