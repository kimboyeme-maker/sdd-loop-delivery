import { expect, test } from 'bun:test'
import { assertLineageDispositions } from '../scripts/helpers/lineage-dispositions'
import type { Contract } from '../scripts/domain/contract'

function fixture() {
  const acceptance = {
    id: 'YS01',
    oracle: 'one completion',
    method: 'run completion',
    environment: 'isolated',
    packages: ['src'],
    claim: { id: 'CL01', dimension: 'BEHAVIOR' }
  }
  const contract = {
    revision: 'v1',
    requirements: [],
    lineage: { mode: 'continuation' },
    ownership: { packages: ['src'] },
    acceptance: [acceptance]
  } satisfies Contract
  const state = {
    lineage_obligations: [
      {
        id: 'OB01',
        affected_packages: ['src'],
        source_acceptance: [structuredClone(acceptance)],
        kind: 'NON_PASS_VERIFICATION',
        resolution_method: 'run completion'
      }
    ]
  }
  const fact = {
    id: 'FT01',
    status: 'CONFIRMED_PASS',
    packages: ['src'],
    requirement_ids: ['XQ01'],
    acceptance_ids: ['YS01'],
    source: { kind: 'COMMAND', reference: 'run completion' }
  }
  const item = {
    obligation_id: 'OB01',
    disposition: 'RESOLVED',
    fact_ids: ['FT01'],
    requirement_ids: ['XQ01'],
    acceptance_ids: ['YS01'],
    repair_packages: [] as string[],
    decision_requirement_ids: [] as string[],
    evidence: ['repeat completion test']
  }
  const payload = {
    requirement_ids: ['XQ01'],
    acceptance_ids: ['YS01'],
    modification_packages: ['src'],
    workload: { affected_packages: ['src'] },
    verification_scope: { surfaces: [{ packages: ['src'] }] },
    must_ship_decision_closure: { decision_requirement_ids: ['JC01'] },
    fact_closure: { lineage_mode: 'continuation', facts: [fact], inherited_obligations: [item] }
  }
  return { contract, state, payload, item, fact }
}

test('every inherited obligation is accounted for exactly once; fresh work stays empty', () => {
  const value = fixture()
  const check = () => assertLineageDispositions(value.contract, value.state, value.payload)
  expect(check).not.toThrow()
  value.payload.fact_closure.inherited_obligations = []
  expect(check).toThrow('ADMISSION_INHERITED_OBLIGATION_SCOPE_INVALID')
  value.payload.fact_closure.inherited_obligations = [value.item, value.item]
  expect(check).toThrow('ADMISSION_INHERITED_OBLIGATION_SCOPE_INVALID')
  value.payload.fact_closure.inherited_obligations = [value.item]
  value.contract.lineage.mode = 'fresh'
  value.payload.fact_closure.lineage_mode = 'fresh'
  expect(check).toThrow('ADMISSION_FACT_LINEAGE_MODE_MISMATCH')
  value.state.lineage_obligations = []
  value.payload.fact_closure.inherited_obligations = []
  expect(check).not.toThrow()
  value.payload.fact_closure.lineage_mode = 'continuation'
  expect(check).toThrow('ADMISSION_FACT_LINEAGE_MODE_MISMATCH')
})

test('resolved non-pass verification requires a scoped passing rerun of its actual method', () => {
  const mutations: [string, (value: ReturnType<typeof fixture>) => void][] = [
    [
      'ADMISSION_INHERITED_RESOLUTION_NOT_PROVEN',
      ({ fact }) => {
        fact.status = 'CONFIRMED_FAIL'
      }
    ],
    [
      'ADMISSION_INHERITED_RESOLUTION_NOT_PROVEN',
      ({ fact }) => {
        fact.packages = ['elsewhere']
      }
    ],
    [
      'ADMISSION_INHERITED_RESOLUTION_NOT_PROVEN',
      ({ fact }) => {
        fact.requirement_ids = []
      }
    ],
    [
      'ADMISSION_INHERITED_VERIFICATION_RERUN_REQUIRED',
      ({ fact }) => {
        fact.source.kind = 'SOURCE_INSPECTION'
      }
    ],
    [
      'ADMISSION_INHERITED_VERIFICATION_RERUN_REQUIRED',
      ({ fact }) => {
        fact.source.reference = 'different command'
      }
    ],
    [
      'ADMISSION_INHERITED_FACT_REFERENCE_INVALID',
      ({ item }) => {
        item.fact_ids = ['FT99']
      }
    ],
    [
      'ADMISSION_INHERITED_REPAIR_SCOPE_INVALID',
      ({ item }) => {
        item.repair_packages = ['src']
      }
    ]
  ]
  for (const [code, mutate] of mutations) {
    const value = fixture()
    expect(() =>
      assertLineageDispositions(value.contract, value.state, value.payload)
    ).not.toThrow()
    mutate(value)
    expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).toThrow(
      code
    )
  }
})

test('admitted repair retains failures but cannot expand modification scope', () => {
  const value = fixture()
  value.item.disposition = 'ADMITTED_REPAIR'
  value.item.repair_packages = ['src']
  value.fact.status = 'CONFIRMED_FAIL'
  expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).not.toThrow()
  value.item.repair_packages = ['elsewhere']
  expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).toThrow(
    'ADMISSION_INHERITED_REPAIR_SCOPE_INVALID'
  )
  value.item.repair_packages = ['src']
  value.payload.modification_packages = []
  expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).toThrow(
    'ADMISSION_INHERITED_REPAIR_SCOPE_INVALID'
  )
})

test('external disposition needs passing package evidence and cannot overlap current work', () => {
  const value = fixture()
  value.item.disposition = 'SCOPE_EXTERNAL'
  expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).toThrow(
    'ADMISSION_INHERITED_SCOPE_EXTERNAL_CONTRADICTION'
  )
  value.state.lineage_obligations[0]!.affected_packages = ['external']
  value.fact.packages = ['external']
  expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).not.toThrow()
  value.fact.status = 'UNKNOWN'
  expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).toThrow(
    'ADMISSION_INHERITED_SCOPE_EXTERNAL_NOT_PROVEN'
  )
})

test('a changed inherited oracle needs explicit decision linkage, never a relabelled resolution', () => {
  const value = fixture()
  value.contract.acceptance[0]!.oracle = 'any completion'
  expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).toThrow(
    'ADMISSION_INHERITED_CONTRACT_CHANGE_REQUIRES_USER'
  )
  value.item.disposition = 'USER_AUTHORIZED_CONTRACT_CHANGE'
  expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).toThrow(
    'ADMISSION_INHERITED_AUTHORITY_EVIDENCE_REQUIRED'
  )
  value.item.decision_requirement_ids = ['JC01']
  expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).not.toThrow()
  value.item.decision_requirement_ids = ['JC99']
  expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).toThrow(
    'ADMISSION_INHERITED_AUTHORITY_EVIDENCE_REQUIRED'
  )
})

test('swapping two oracle definitions does not preserve either acceptance meaning', () => {
  const value = fixture()
  const second = {
    ...value.contract.acceptance[0]!,
    id: 'YS02',
    oracle: 'no cancellation callback'
  }
  value.contract.acceptance.push(second)
  value.state.lineage_obligations[0]!.source_acceptance.push(structuredClone(second))
  value.item.acceptance_ids.push('YS02')
  value.payload.acceptance_ids.push('YS02')
  value.fact.acceptance_ids.push('YS02')
  expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).not.toThrow()
  ;[value.contract.acceptance[0]!.oracle, value.contract.acceptance[1]!.oracle] = [
    value.contract.acceptance[1]!.oracle,
    value.contract.acceptance[0]!.oracle
  ]
  expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).toThrow(
    'ADMISSION_INHERITED_CONTRACT_CHANGE_REQUIRES_USER'
  )
})

test('declared inherited sensitivity and execution boundaries cannot be silently weakened', () => {
  for (const field of ['claim', 'oracle_sensitivity', 'execution']) {
    const value = fixture()
    const current = value.contract.acceptance[0]! as Record<string, unknown>
    const previous = value.state.lineage_obligations[0]!.source_acceptance[0]! as Record<
      string,
      unknown
    >
    const boundary =
      field === 'claim'
        ? { id: 'CL01', dimension: 'BEHAVIOR' }
        : field === 'oracle_sensitivity'
          ? { applicability: 'REQUIRED', expected_flip: 'PASS_TO_FAIL_TO_PASS' }
          : { isolation: 'INDEPENDENT', timeout_seconds: 30 }
    current[field] = structuredClone(boundary)
    previous[field] = structuredClone(boundary)
    expect(() =>
      assertLineageDispositions(value.contract, value.state, value.payload)
    ).not.toThrow()
    delete current[field]
    expect(() => assertLineageDispositions(value.contract, value.state, value.payload)).toThrow(
      'ADMISSION_INHERITED_CONTRACT_CHANGE_REQUIRES_USER'
    )
  }
})
