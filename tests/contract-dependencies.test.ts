import { test, expect } from 'bun:test'
import { readContractText, type Contract } from '../scripts/domain/contract'
import { amendedRequirementStatuses } from '../scripts/domain/policies/amend-requirements'
const parse = (requirements: unknown[]) =>
  readContractText(
    '<!-- sdd-contract:start -->\n```json\n' +
      JSON.stringify({ protocol: 'sdd-loop-delivery/v1', revision: 'v1', requirements }) +
      '\n```\n<!-- sdd-contract:end -->'
  )!
test('contract dependencies reject dangling/cyclic graphs and invalidate transitive consumers', () => {
  const req = (id: string, dependencies: string[] = []) => ({
    id,
    dependencies,
    title: id,
    kind: 'must-ship'
  })
  expect(() => parse([req('XQ01', ['missing'])])).toThrow('CONTRACT_DEPENDENCY_INVALID')
  expect(() => parse([req('XQ01', ['XQ02']), req('XQ02', ['XQ01'])])).toThrow(
    'CONTRACT_DEPENDENCY_CYCLE'
  )
  const old = parse([req('XQ01'), req('XQ02', ['XQ01']), req('XQ03', ['XQ02']), req('XQ04')])
  const next = {
    ...old,
    requirements: old.requirements.map((req) =>
      req.id === 'XQ01' ? { ...req, title: 'changed' } : req
    )
  } as Contract
  expect(
    amendedRequirementStatuses(
      {
        contract: old,
        requirements: { XQ01: 'verified', XQ02: 'verified', XQ03: 'verified', XQ04: 'verified' }
      },
      next
    )
  ).toEqual({ XQ01: 'pending', XQ02: 'pending', XQ03: 'pending', XQ04: 'verified' })
})
