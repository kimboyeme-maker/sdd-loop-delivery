import { expect, test } from 'bun:test'
import { assertClaimCoverage } from '../scripts/domain/policies/claim-coverage'
const claim = {
  id: 'CL01',
  statement: 'the specified behavior holds',
  dimension: 'BEHAVIOR',
  quantifier: 'UNIVERSAL',
  universe: ['entry-a', 'entry-b']
}
const contract = { revision: 'v1', requirements: [], acceptance: [{ id: 'YS01', claim }] }
const fact = (covered_universe: string[], status = 'CONFIRMED_PASS') => ({
  evidence_kind: 'TEST_RESULT',
  claim_ids: ['CL01'],
  covered_universe,
  status
})
test('universal claims require exact union coverage rather than samples or duplicate counts', () => {
  const check = (facts: unknown[]) => assertClaimCoverage(contract, { fact_closure: { facts } })
  expect(() => check([fact(['entry-a']), fact(['entry-b'])])).not.toThrow()
  for (const facts of [
    [fact(['entry-a'])],
    [fact(['entry-a']), fact(['entry-a'])],
    [fact(['entry-a', 'entry-b', 'extra'])],
    [fact(['entry-a']), fact(['entry-b'], 'CONFIRMED_FAIL')]
  ])
    expect(() => check(facts)).toThrow('ADMISSION_UNIVERSAL_CLAIM_COVERAGE_INCOMPLETE')
  for (const invalid of [
    { ...claim, universe: [] },
    { ...claim, universe: ['entry-a', 'entry-a'] },
    { ...claim, quantifier: 'typo' },
    {
      ...claim,
      statement: 'the specified behavior holds',
      dimension: 'BEHAVIOR',
      quantifier: 'SINGLE'
    }
  ])
    expect(() =>
      assertClaimCoverage(
        { ...contract, acceptance: [{ id: 'YS01', claim: invalid }] },
        { fact_closure: { facts: [] } }
      )
    ).toThrow()
  expect(() =>
    assertClaimCoverage(
      {
        ...contract,
        acceptance: [
          {
            id: 'YS01',
            claim: {
              id: 'CL01',
              statement: 'the specified behavior holds',
              dimension: 'BEHAVIOR',
              quantifier: 'SINGLE'
            }
          }
        ]
      },
      { fact_closure: { facts: [] } }
    )
  ).not.toThrow()
})

test('claim IDs are unique and every fact reference resolves without depending on declaration order', () => {
  const first = {
    id: 'YS01',
    claim: {
      id: 'CL01',
      statement: 'the specified behavior holds',
      dimension: 'BEHAVIOR',
      quantifier: 'SINGLE'
    }
  }
  const second = {
    id: 'YS02',
    claim: {
      id: 'CL02',
      statement: 'the specified behavior holds',
      dimension: 'BEHAVIOR',
      quantifier: 'SINGLE'
    }
  }
  const base = { revision: 'v1', requirements: [], acceptance: [first, second] }
  const payload = {
    fact_closure: {
      facts: [
        { evidence_kind: 'TEST_RESULT', claim_ids: ['CL02', 'CL01'], status: 'CONFIRMED_PASS' }
      ]
    }
  }
  expect(() => assertClaimCoverage(base, payload)).not.toThrow()
  expect(() => assertClaimCoverage({ ...base, acceptance: [second, first] }, payload)).not.toThrow()
  expect(() =>
    assertClaimCoverage(
      { ...base, acceptance: [first, { ...second, claim: first.claim }] },
      payload
    )
  ).toThrow('ACCEPTANCE_CLAIM_ID_DUPLICATE')
  for (const claim_ids of [[], ['missing'], ['CL01', 'CL01']])
    expect(() => assertClaimCoverage(base, { fact_closure: { facts: [{ claim_ids }] } })).toThrow(
      'ADMISSION_FACT_CLAIM_REFERENCE_INVALID'
    )
})

test('claim dimensions reject structural evidence for behavior while preserving migration inventory', () => {
  const acceptance = {
    id: 'YS01',
    claim: {
      id: 'CL01',
      statement: 'removed runtime is not invoked',
      dimension: 'BEHAVIOR',
      quantifier: 'SINGLE'
    }
  }
  const base = { revision: 'v1', requirements: [], acceptance: [acceptance] }
  const inventory = {
    id: 'FT01',
    claim_ids: ['CL01'],
    evidence_kind: 'SOURCE_INSPECTION',
    status: 'CONFIRMED_PASS'
  }
  const payload = {
    fact_closure: { facts: [inventory] },
    migration_closure: { inventory_fact_ids: ['FT01'] }
  }
  expect(() => assertClaimCoverage(base, payload)).toThrow(
    'ADMISSION_FACT_EVIDENCE_DIMENSION_MISMATCH'
  )
  const migration = {
    ...base,
    migration_applicability: 'REQUIRED',
    migration: {
      legacy_surfaces: [{ final_disposition: 'REMOVE', zero_reader_acceptance_ids: ['YS01'] }]
    }
  }
  expect(() => assertClaimCoverage(migration, payload)).not.toThrow()
  expect(() =>
    assertClaimCoverage(base, {
      fact_closure: { facts: [{ ...inventory, evidence_kind: 'TEST_RESULT' }] }
    })
  ).not.toThrow()
  expect(() =>
    assertClaimCoverage(
      {
        ...base,
        acceptance: [{ ...acceptance, claim: { ...acceptance.claim, dimension: 'unknown' } }]
      },
      payload
    )
  ).toThrow('CONTRACT_CLAIM_DIMENSION_INVALID')
})
