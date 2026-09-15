import { expect, test } from 'bun:test'
import { amendedRequirementStatuses } from '../scripts/domain/policies/amend-requirements'
import type { Contract } from '../scripts/domain/contract'

test('shared contract changes invalidate evidence while revision and presentation alone preserve it', () => {
  const contract: Contract = {
    revision: 'v1',
    requirements: [{ id: 'XQ01', title: 'Deliver', kind: 'must-ship' }],
    permissions: { network: false },
    environment: { runtime: 'local' },
    ownership: { owner: 'module-a' },
    presentation: { description: 'Human explanation' }
  }
  const state = { contract, requirements: { XQ01: 'verified' } }
  expect(
    amendedRequirementStatuses(state, {
      ...contract,
      revision: 'v2',
      presentation: { description: 'Clearer human explanation' }
    })
  ).toEqual({ XQ01: 'verified' })
  for (const patch of [
    { permissions: { network: true } },
    { environment: { runtime: 'remote' } },
    { ownership: { owner: 'module-b' } },
    { future_contract_semantics: { changed: true } }
  ]) {
    expect(amendedRequirementStatuses(state, { ...contract, ...patch, revision: 'v2' })).toEqual({
      XQ01: 'pending'
    })
  }
})
