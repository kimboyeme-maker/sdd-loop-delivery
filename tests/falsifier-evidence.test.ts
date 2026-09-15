import { expect, test } from 'bun:test'
import { assertFalsifierEvidence } from '../scripts/domain/policies/falsifier-evidence'

test('early falsifier rejects invented, failing and unrelated evidence while preserving a passing trace', () => {
  const fact = {
    requirement_ids: ['XQ01'],
    acceptance_ids: ['YS01'],
    id: 'FT01',
    claim: 'closed before callback',
    status: 'CONFIRMED_PASS',
    source: { kind: 'COMMAND', reference: 'cancel-probe', observed: 'closed' }
  }
  const assumption = {
    claim: 'cancellation route is executable',
    evidence: 'probe completed',
    id: 'AS01',
    category: 'ROUTE_FEASIBILITY',
    status: 'PROVEN',
    evidence_fact_ids: ['FT01']
  }
  const result = {
    outcome: 'SURVIVED',
    method: 'cancel before callback',
    failure_condition: 'open state',
    observed_result: 'closed state',
    target_assumption_ids: ['AS01'],
    requirement_ids: ['XQ01'],
    acceptance_ids: ['YS01'],
    evidence_fact_ids: ['FT01'],
    evidence: ['probe log']
  }
  const payload = {
    unknowns: [],
    requirement_ids: ['XQ01'],
    acceptance_ids: ['YS01'],
    early_falsifier_result: result,
    fact_closure: {
      lineage_mode: 'fresh',
      unresolved_fact_ids: [],
      inherited_obligations: [],
      facts: [fact]
    },
    assumptions_checked: [assumption]
  }
  expect(() => assertFalsifierEvidence(payload)).not.toThrow()
  const executable = {
    ...payload,
    assumptions_checked: [{ ...assumption, category: 'ACCEPTANCE_EXECUTABILITY' }],
    early_falsifier_result: { ...result, method: fact.source.reference }
  }
  expect(() => assertFalsifierEvidence(executable)).not.toThrow()
  for (const source of [
    { ...fact.source, kind: 'SOURCE_INSPECTION' },
    { ...fact.source, reference: 'different-command' }
  ])
    expect(() =>
      assertFalsifierEvidence({
        ...executable,
        fact_closure: { ...payload.fact_closure, facts: [{ ...fact, source }] }
      })
    ).toThrow('EARLY_FALSIFIER_EXECUTABLE_EVIDENCE_REQUIRED')
  for (const scope of [{ requirement_ids: ['XQ99'] }, { acceptance_ids: ['YS99'] }]) {
    expect(() =>
      assertFalsifierEvidence({
        ...payload,
        fact_closure: { ...payload.fact_closure, facts: [{ ...fact, ...scope }] }
      })
    ).toThrow('ADMISSION_FACT_CONTRACT_SCOPE_INVALID')
  }
  // An unused fact is still constrained by the admission scope. Keep known
  // failures available for implementation planning without claiming them PASS.
  const repairFact = { ...fact, id: 'FT02', status: 'CONFIRMED_FAIL' }
  const admitted = {
    ...payload,
    decision: 'ADMIT',
    fact_closure: { ...payload.fact_closure, facts: [fact, repairFact] }
  }
  expect(() => assertFalsifierEvidence(admitted)).not.toThrow()
  for (const outside of [{ requirement_ids: ['XQ99'] }, { acceptance_ids: ['YS99'] }])
    expect(() =>
      assertFalsifierEvidence({
        ...admitted,
        fact_closure: { ...admitted.fact_closure, facts: [fact, { ...repairFact, ...outside }] }
      })
    ).toThrow('ADMISSION_FACT_CONTRACT_SCOPE_INVALID')
  expect(() =>
    assertFalsifierEvidence({
      ...admitted,
      fact_closure: { ...admitted.fact_closure, unresolved_fact_ids: ['FT02'] }
    })
  ).toThrow('ADMISSION_FACTS_UNRESOLVED')
  const obligation = {
    obligation_id: 'OB01',
    disposition: 'RESOLVED',
    fact_ids: ['FT01'],
    requirement_ids: ['XQ01'],
    acceptance_ids: ['YS01'],
    decision_requirement_ids: [],
    repair_packages: [],
    evidence: ['current probe resolves inherited issue']
  }
  expect(() =>
    assertFalsifierEvidence({
      ...payload,
      fact_closure: {
        ...payload.fact_closure,
        lineage_mode: 'continuation',
        inherited_obligations: [obligation]
      }
    })
  ).not.toThrow()
  for (const patch of [
    { unknowns: ['missing owner'] },
    { assumptions_checked: [{ ...assumption, status: 'UNKNOWN' }] },
    { assumptions_checked: [{ ...assumption, status: 'DISPROVEN' }] },
    { assumptions_checked: [{ ...assumption, status: 'typo' }] },
    { assumptions_checked: [{ ...assumption, category: 'typo' }] },
    { assumptions_checked: [{ ...assumption, evidence: '' }] },
    { early_falsifier_result: { ...result, evidence_fact_ids: ['missing'] } },
    { early_falsifier_result: { ...result, target_assumption_ids: ['missing'] } },
    { early_falsifier_result: { ...result, requirement_ids: ['XQ99'] } },
    { fact_closure: { ...payload.fact_closure, facts: [{ ...fact, status: 'CONFIRMED_FAIL' }] } },
    {
      fact_closure: {
        ...payload.fact_closure,
        facts: [{ ...fact, source: { ...fact.source, observed: '' } }]
      }
    },
    { fact_closure: { ...payload.fact_closure, facts: [fact, fact] } },
    { fact_closure: { ...payload.fact_closure, unresolved_fact_ids: ['missing'] } },
    { fact_closure: { ...payload.fact_closure, lineage_mode: 'typo' } },
    { fact_closure: { ...payload.fact_closure, inherited_obligations: [obligation, obligation] } },
    {
      fact_closure: {
        ...payload.fact_closure,
        inherited_obligations: [{ ...obligation, fact_ids: ['missing'] }]
      }
    },
    { assumptions_checked: [{ ...assumption, category: 'OWNERSHIP' }] },
    { assumptions_checked: [{ ...assumption, evidence_fact_ids: ['missing'] }] }
  ])
    expect(() => assertFalsifierEvidence({ ...payload, ...patch })).toThrow()
})
