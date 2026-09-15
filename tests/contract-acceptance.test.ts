import { expect, test } from 'bun:test'
import { readContractText } from '../scripts/domain/contract'

test('explicit acceptance inventory rejects duplicate definitions and unresolved or malformed references', () => {
  const requirement = {
    id: 'XQ01',
    kind: 'must-ship',
    title: 'cancel',
    acceptance: ['YS01']
  } as const
  const base = {
    protocol: 'sdd-loop-delivery/v1',
    revision: 'v1',
    requirements: [requirement],
    acceptance: [{ id: 'YS01' }]
  }
  const read = (contract: unknown) =>
    readContractText(
      `<!-- sdd-contract:start -->\n\`\`\`json\n${JSON.stringify(contract)}\n\`\`\`\n<!-- sdd-contract:end -->`
    )
  expect(read(base)?.requirements).toEqual(base.requirements)
  for (const acceptance of [null, {}, [null], [{ id: '' }], [{ id: 'YS01' }, { id: 'YS01' }], []])
    expect(() => read({ ...base, acceptance })).toThrow()
  for (const acceptance of [null, 'YS01', [''], [1], ['YS01', 'YS01'], ['YS99']])
    expect(() => read({ ...base, requirements: [{ ...requirement, acceptance }] })).toThrow()
  const { acceptance: _inventory, ...legacy } = base
  expect(() => read(legacy)).not.toThrow()
  expect(() => read({ ...base, protocol: 'sdd-round-delivery/v1' })).toThrow(
    'CONTRACT_PROTOCOL_UNSUPPORTED'
  )
  expect(() =>
    read({ ...base, requirements: [requirement, { ...requirement, id: 'XQ02' }] })
  ).not.toThrow()
})
