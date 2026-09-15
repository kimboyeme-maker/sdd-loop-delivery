import { expect, test } from 'bun:test'
import { assertClaimDispositions } from '../scripts/domain/policies/claim-coverage'
const contract = {
  revision: 'v1',
  requirements: [],
  acceptance: [{ id: 'YS01', claim: { id: 'CL01', dimension: 'BEHAVIOR' } }]
}
const base = {
  acceptance_ids: ['YS01'],
  execution_packets: [{ id: 'PC01', acceptance_ids: ['YS01'] }],
  fact_closure: {
    facts: [
      { id: 'FT01', claim_ids: ['CL01'], status: 'CONFIRMED_PASS', evidence_kind: 'TEST_RESULT' }
    ]
  }
}
const implementation = {
  claim_id: 'CL01',
  disposition: 'IMPLEMENTATION_REQUIRED',
  fact_ids: [],
  packet_ids: ['PC01'],
  evidence: ['approved implementation']
}
const baseline = {
  ...implementation,
  disposition: 'VERIFIED_BASELINE',
  fact_ids: ['FT01'],
  packet_ids: []
}
test('every selected claim has exactly one evidence-backed or packet-backed disposition', () => {
  const check = (claim_dispositions: unknown) =>
    assertClaimDispositions(contract, { ...base, claim_dispositions })
  expect(() => check([implementation])).not.toThrow()
  expect(() => check([baseline])).not.toThrow()
  for (const invalid of [
    undefined,
    [],
    [implementation, implementation],
    [{ ...implementation, claim_id: 'missing' }],
    [{ ...implementation, packet_ids: ['missing'] }],
    [{ ...implementation, fact_ids: ['FT01'] }],
    [{ ...baseline, fact_ids: [] }],
    [{ ...baseline, fact_ids: ['missing'] }]
  ])
    expect(() => check(invalid)).toThrow()
  for (const patch of [
    { status: 'CONFIRMED_FAIL' },
    { claim_ids: ['other'] },
    { evidence_kind: 'SOURCE_INSPECTION' }
  ])
    expect(() =>
      assertClaimDispositions(contract, {
        ...base,
        claim_dispositions: [baseline],
        fact_closure: { facts: [{ ...base.fact_closure.facts[0], ...patch }] }
      })
    ).toThrow()
})
