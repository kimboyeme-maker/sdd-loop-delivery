import { expect, test } from 'bun:test'
import type { Contract } from '../scripts/domain/contract'
import { assertAuthoringClosure } from '../scripts/domain/policies/authoring-closure'

const inventory = {
  SOURCE_INVENTORY: {
    roots: ['packages/core/src'],
    method: 'read manifests and reader edges',
    evidence: ['inventory']
  },
  RUNTIME_RESOLUTION: {
    applicability: 'NOT_APPLICABLE',
    reason: 'acceptance does not use installed resolution'
  }
}
const contract = (patch: Record<string, unknown> = {}) =>
  ({
    revision: 'v1',
    design_detail: { protocol: 'design-detail/v1' },
    inventory_authorities: inventory,
    requirements: [{ id: 'XQ01', kind: 'must-ship', title: 'core' }],
    ...patch
  }) as unknown as Contract

test('current authoring output closes inventory authority, deferral metadata and behavior-named owning tests', () => {
  expect(() => assertAuthoringClosure(contract())).not.toThrow()
  // Documents accepted under an older schema keep it.
  const {
    design_detail: _detail,
    inventory_authorities: _inventory,
    ...legacy
  } = contract() as Record<string, unknown>
  expect(() => assertAuthoringClosure(legacy as unknown as Contract)).not.toThrow()
  expect(() => assertAuthoringClosure(contract({ inventory_authorities: undefined }))).toThrow(
    'CONTRACT_INVENTORY_AUTHORITIES_REQUIRED'
  )
  expect(() =>
    assertAuthoringClosure(
      contract({
        inventory_authorities: {
          ...inventory,
          SOURCE_INVENTORY: { roots: [], method: 'x', evidence: ['y'] }
        }
      })
    )
  ).toThrow('CONTRACT_SOURCE_INVENTORY_INVALID')
  const required = { applicability: 'REQUIRED', reason: 'acceptance runs the installed bundler' }
  expect(() =>
    assertAuthoringClosure(
      contract({ inventory_authorities: { ...inventory, RUNTIME_RESOLUTION: required } })
    )
  ).toThrow('CONTRACT_RUNTIME_RESOLUTION_INVALID')
  const fingerprints = Object.fromEntries(
    [
      'source_fingerprint',
      'lockfile_fingerprint',
      'tool_runtime_version',
      'workspace_link_fingerprint',
      'resolver_mode'
    ].map((field) => [field, 'x'])
  )
  expect(() =>
    assertAuthoringClosure(
      contract({
        inventory_authorities: {
          ...inventory,
          RUNTIME_RESOLUTION: { ...required, ...fingerprints }
        }
      })
    )
  ).not.toThrow()
  const deferred = {
    owner: 'core team',
    trigger: 'after launch',
    impact: 'manual export',
    approved_by: 'user'
  }
  const withDeferral = (kind: string, value: unknown) =>
    contract({ requirements: [{ id: 'XQ01', kind, title: 'core', deferred: value }] })
  expect(() => assertAuthoringClosure(withDeferral('must-ship', deferred))).not.toThrow()
  expect(() =>
    assertAuthoringClosure(withDeferral('should', { ...deferred, trigger: '' }))
  ).toThrow('CONTRACT_DEFERRAL_METADATA_REQUIRED')
  expect(() =>
    assertAuthoringClosure(withDeferral('must-ship', { ...deferred, approved_by: 'coordinator' }))
  ).toThrow('MUST_SHIP_DEFERRAL_REQUIRES_USER')
  const reader = (owningTest: string) =>
    contract({ migration: { readers: [{ id: 'RSP01', owning_test: owningTest }] } })
  expect(() =>
    assertAuthoringClosure(reader('packages/core/test/attachment.test.ts'))
  ).not.toThrow()
  expect(() => assertAuthoringClosure(reader('packages/core/test/round12.test.ts'))).toThrow(
    'TEST_FILE_DELIVERY_METADATA_NAME_FORBIDDEN'
  )
  expect(() => assertAuthoringClosure(reader('packages/core/test/hotfix.test.ts'))).toThrow(
    'TEST_FILE_BUSINESS_NAME_REQUIRED'
  )
  // Acceptance shape and execution are both reported at authoring time, not first at admission.
  const acceptance = (patch: Record<string, unknown> = {}) => ({
    id: 'YS01',
    requirement_ids: ['XQ01'],
    oracle: 'the supported runtime returns the expected result',
    method: 'pnpm --filter @demo/core test',
    environment: 'supported runtime',
    packages: ['@demo/core'],
    ...patch
  })
  // The reverse link lives on the requirement, so both directions have to be present.
  const verified = (cases: Record<string, unknown>[]) =>
    contract({
      requirements: [{ id: 'XQ01', kind: 'must-ship', title: 'core', acceptance: ['YS01'] }],
      acceptance: cases
    })
  for (const missing of ['oracle', 'method', 'environment', 'packages']) {
    const incomplete = acceptance()
    delete (incomplete as Record<string, unknown>)[missing]
    expect(() => assertAuthoringClosure(verified([incomplete]))).toThrow(
      'CONTRACT_ACCEPTANCE_INVALID'
    )
  }
  expect(() =>
    assertAuthoringClosure(verified([acceptance({ requirement_ids: ['XQ02'] })]))
  ).toThrow('CONTRACT_ACCEPTANCE_REQUIREMENT_LINK_MISMATCH')
  expect(() => assertAuthoringClosure(verified([acceptance()]))).toThrow(
    'ACCEPTANCE_EXECUTION_REQUIRED'
  )
})

test('a decision requirement must record who may answer, the question and its status', () => {
  const decide = (decision?: Record<string, unknown>) =>
    contract({
      requirements: [
        {
          id: 'JC01',
          title: 'Which rejection the product keeps',
          kind: 'must-ship',
          requirement_type: 'decision',
          ...(decision ? { decision } : {})
        }
      ]
    }) as Contract

  expect(() => assertAuthoringClosure(decide())).toThrow('CONTRACT_DECISION_METADATA_REQUIRED')
  expect(() =>
    assertAuthoringClosure(decide({ authority: 'user', question: 'which one?' }))
  ).toThrow('CONTRACT_DECISION_METADATA_REQUIRED')
  expect(() =>
    assertAuthoringClosure(decide({ authority: 'user', question: 'which one?', status: 'open' }))
  ).toThrow('CONTRACT_DECISION_STATUS_INVALID')
  // Resolved is a claim about an answer, so the answer and its evidence must be there.
  expect(() =>
    assertAuthoringClosure(
      decide({ authority: 'user', question: 'which one?', status: 'resolved' })
    )
  ).toThrow('CONTRACT_DECISION_RESOLUTION_REQUIRED')
  expect(() =>
    assertAuthoringClosure(decide({ authority: 'user', question: 'which one?', status: 'pending' }))
  ).not.toThrow()
  expect(() =>
    assertAuthoringClosure(
      decide({
        authority: 'user',
        question: 'which one?',
        status: 'resolved',
        resolution: 'return the Invalid variant',
        evidence: 'user reply choosing it'
      })
    )
  ).not.toThrow()
})
