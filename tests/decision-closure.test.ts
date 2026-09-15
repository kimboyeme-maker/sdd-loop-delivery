import { expect, test } from 'bun:test'
import { assertDecisionClosure } from '../scripts/domain/policies/decision-closure'
import type { Contract } from '../scripts/domain/contract'

test('decision closure covers all Must-Ship decisions and requires explicit authority disposition', () => {
  const contract: Contract = {
    revision: 'v1',
    requirements: [
      { id: 'XQ01', kind: 'must-ship', title: 'cancel' },
      { id: 'XQ02', kind: 'should', title: 'diagnostics' }
    ]
  }
  const closure = {
    requirement_ids: ['XQ01'],
    decision_requirement_ids: [],
    unresolved_decisions: [],
    dimensions: [
      'SEMANTIC_OWNER',
      'DEPENDENCY_DIRECTION',
      'PUBLIC_CONTRACT',
      'DIRECT_CONSUMERS',
      'USER_AUTHORITY'
    ].map((dimension) => ({
      dimension,
      disposition: dimension === 'USER_AUTHORITY' ? 'NOT_REQUIRED' : 'CLOSED',
      evidence: ['current contract review']
    }))
  }
  const check = (value: unknown) =>
    assertDecisionClosure(contract, { must_ship_decision_closure: value })
  expect(() => check(closure)).not.toThrow()
  expect(() =>
    check({
      ...closure,
      dimensions: closure.dimensions.map((item) =>
        item.dimension === 'USER_AUTHORITY' ? { ...item, disposition: 'RESOLVED' } : item
      )
    })
  ).not.toThrow()
  for (const invalid of [
    undefined,
    {},
    { ...closure, requirement_ids: ['XQ02'] },
    { ...closure, decision_requirement_ids: ['unknown'] },
    { ...closure, unresolved_decisions: ['API choice'] },
    { ...closure, dimensions: closure.dimensions.slice(1) },
    { ...closure, dimensions: [...closure.dimensions, closure.dimensions[0]] },
    {
      ...closure,
      dimensions: closure.dimensions.map((item) => ({ ...item, disposition: 'CLOSED' }))
    },
    { ...closure, dimensions: closure.dimensions.map((item) => ({ ...item, evidence: [] })) }
  ])
    expect(() => check(invalid)).toThrow()
  const decisionContract: Contract = {
    ...contract,
    requirements: [{ ...contract.requirements[0]!, requirement_type: 'decision' }]
  }
  const decisionCheck = (value: unknown) =>
    assertDecisionClosure(decisionContract, { must_ship_decision_closure: value })
  expect(() => decisionCheck(closure)).toThrow('MUST_SHIP_DECISION_IDS_INVALID')
  expect(() => decisionCheck({ ...closure, decision_requirement_ids: ['XQ01'] })).toThrow(
    'MUST_SHIP_USER_AUTHORITY_NOT_RESOLVED'
  )
  expect(() =>
    decisionCheck({
      ...closure,
      decision_requirement_ids: ['XQ01'],
      dimensions: closure.dimensions.map((item) =>
        item.dimension === 'USER_AUTHORITY' ? { ...item, disposition: 'RESOLVED' } : item
      )
    })
  ).not.toThrow()
  expect(() => check({ ...closure, decision_requirement_ids: ['XQ01'] })).toThrow(
    'MUST_SHIP_DECISION_IDS_INVALID'
  )
})
