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
  // Acceptance execution is reported at authoring time, not first at admission.
  expect(() =>
    assertAuthoringClosure(contract({ acceptance: [{ id: 'YS01', requirement_ids: ['XQ01'] }] }))
  ).toThrow('ACCEPTANCE_EXECUTION_REQUIRED')
})
