import type { Contract } from '../scripts/domain/contract'
import { expect, test } from 'bun:test'
import { assertVerificationScope } from '../scripts/domain/policies/verification-scope'
const contract: Contract = {
  revision: 'v1',
  requirements: [
    { id: 'XQ01', kind: 'must-ship', title: 'first', acceptance: ['YS01'] },
    { id: 'XQ02', kind: 'must-ship', title: 'second', acceptance: ['YS02'] }
  ],
  acceptance: [
    {
      id: 'YS01',
      oracle: 'completion observes the specified terminal state',
      environment: 'isolated local fixture with deterministic callback scheduling',
      claim: { id: 'CL01' },
      requirement_ids: ['XQ01'],
      packages: ['src/a'],
      method: 'test a'
    },
    {
      id: 'YS02',
      oracle: 'completion observes the specified terminal state',
      environment: 'isolated local fixture with deterministic callback scheduling',
      claim: { id: 'CL02' },
      requirement_ids: ['XQ02'],
      packages: ['src/b'],
      method: 'test b'
    }
  ]
}
const surfaces = (
  contract.acceptance as {
    id: string
    method: string
    requirement_ids: string[]
    packages: string[]
  }[]
).map((a, index) => ({
  id: 'VS0' + index,
  target: 'behavior',
  causal_basis: 'consumer flow',
  method: a.method,
  requirement_ids: a.requirement_ids,
  acceptance_ids: [a.id],
  packages: a.packages
}))
const payload = {
  early_falsifier_result: {
    method: 'test a',
    acceptance_ids: ['YS01'],
    evidence_fact_ids: ['FT01'],
    target_assumption_ids: ['AS01']
  },
  assumptions_checked: [{ id: 'AS01', category: 'ROUTE_FEASIBILITY' }],
  fact_closure: { facts: [{ id: 'FT01', claim_ids: ['CL01'], packages: ['src/a'] }] },
  requirement_ids: ['XQ01', 'XQ02'],
  acceptance_ids: ['YS01', 'YS02'],
  verification_scope: {
    mode: 'CAUSAL_CLOSURE',
    external_failure_policy: 'NON_BLOCKING_UNLESS_CAUSAL_OR_ORACLE_MASKING',
    surfaces,
    workspace_wide_gate: { disposition: 'NOT_APPLICABLE', evidence: [] }
  }
}
test('verification scope binds local method, requirement and package edges rather than aggregate totals', () => {
  expect(() => assertVerificationScope(contract, payload)).not.toThrow()
  for (const patch of [
    { method: 'easier test' },
    { requirement_ids: ['XQ02'] },
    { packages: ['src/b'] },
    { acceptance_ids: ['missing'] },
    { id: 'VS01' }
  ])
    expect(() =>
      assertVerificationScope(contract, {
        ...payload,
        verification_scope: {
          ...payload.verification_scope,
          surfaces: [{ ...surfaces[0], ...patch }, surfaces[1]]
        }
      })
    ).toThrow()
  expect(() =>
    assertVerificationScope(contract, {
      ...payload,
      verification_scope: { ...payload.verification_scope, surfaces: [surfaces[0]] }
    })
  ).toThrow()
  for (const disposition of ['REQUIRED', 'REJECTED_OVERBROAD']) {
    expect(() =>
      assertVerificationScope(contract, {
        ...payload,
        verification_scope: {
          ...payload.verification_scope,
          workspace_wide_gate: { disposition, evidence: [] }
        }
      })
    ).toThrow()
    expect(() =>
      assertVerificationScope(contract, {
        ...payload,
        verification_scope: {
          ...payload.verification_scope,
          workspace_wide_gate: { disposition, evidence: ['observed shared consumer'] }
        }
      })
    ).not.toThrow()
  }
})

test('verification rejects inconsistent bidirectional normative links', () => {
  const check = (requirements: Contract['requirements']) =>
    assertVerificationScope({ ...contract, requirements }, payload)
  expect(() => check(contract.requirements)).not.toThrow()
  expect(() =>
    check(
      contract.requirements.map((req, i) => ({ ...req, acceptance: [i === 0 ? 'YS02' : 'YS01'] }))
    )
  ).toThrow('CONTRACT_ACCEPTANCE_REQUIREMENT_LINK_MISMATCH')
  expect(() => check(contract.requirements.map((req) => ({ ...req, acceptance: [] })))).toThrow(
    'CONTRACT_ACCEPTANCE_REQUIREMENT_LINK_MISMATCH'
  )
  expect(() =>
    check(
      contract.requirements.map((req) => ({
        ...req,
        acceptance: [...(req.acceptance ?? []), 'missing']
      }))
    )
  ).toThrow('CONTRACT_ACCEPTANCE_REQUIREMENT_LINK_MISMATCH')
})

test('early probe must cover the acceptance packages and use the planned method', () => {
  expect(() =>
    assertVerificationScope(contract, {
      ...payload,
      fact_closure: { facts: [{ id: 'FT01', claim_ids: ['CL01'], packages: ['src/b'] }] }
    })
  ).toThrow('EARLY_FALSIFIER_FACT_SCOPE_INVALID')
  const changed = {
    ...payload,
    early_falsifier_result: { ...payload.early_falsifier_result, method: 'reader inventory' }
  }
  expect(() => assertVerificationScope(contract, changed)).toThrow(
    'EARLY_FALSIFIER_METHOD_NOT_ACCEPTANCE_ORACLE'
  )
  expect(() =>
    assertVerificationScope(contract, {
      ...changed,
      assumptions_checked: [{ id: 'AS01', category: 'MIGRATION_READER_CLOSURE' }]
    })
  ).not.toThrow()
})

test('early facts must name the actual acceptance claim', () => {
  for (const claim_ids of [[], ['different-claim']])
    expect(() =>
      assertVerificationScope(contract, {
        ...payload,
        fact_closure: { facts: [{ id: 'FT01', packages: ['src/a'], claim_ids }] }
      })
    ).toThrow('EARLY_FALSIFIER_CLAIM_BINDING_INVALID')
  expect(() => assertVerificationScope(contract, payload)).not.toThrow()
})

test('admission rejects acceptance without an oracle or execution environment', () => {
  const acceptance = contract.acceptance as Record<string, unknown>[]
  for (const field of ['oracle', 'environment', 'method'])
    for (const value of [undefined, null, '', '   ', 1])
      expect(() =>
        assertVerificationScope(
          {
            ...contract,
            acceptance: acceptance.map((item, index) =>
              index === 0 ? { ...item, [field]: value } : item
            )
          },
          payload
        )
      ).toThrow('CONTRACT_ACCEPTANCE_INVALID')
  expect(() => assertVerificationScope(contract, payload)).not.toThrow()
})
