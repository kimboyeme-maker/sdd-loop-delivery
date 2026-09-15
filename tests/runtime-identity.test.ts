import { expect, test } from 'bun:test'
import { isRuntimeIdentity } from '../scripts/helpers/runtime-identity'
import { parseHostSpawnReceipt, parseBootstrapReceipt } from '../scripts/schemas/host'

test('host identity spellings are preserved without inventing a local slug', () => {
  for (const id of [
    '/root/coordinator_v2',
    '019abcdef-1234-5678-9012-abcdef123456',
    'operator',
    'agent:opaque-ID'
  ]) {
    expect(isRuntimeIdentity(id)).toBe(true)
    expect(
      parseHostSpawnReceipt({
        protocol: 'host-spawn-receipt/v1',
        agent_id: id,
        runtime: 'fixture',
        model: 'fixture',
        isolation: 'fixture'
      }).agent_id
    ).toBe(id)
    expect(
      parseBootstrapReceipt({ stage: 'OPEN', agentId: id, processId: 'fixture', success: true })
        .agentId
    ).toBe(id)
  }
  for (const id of [
    undefined,
    null,
    3,
    '',
    ' operator',
    'operator ',
    'agent\nnext',
    'agent\u0000next',
    'agent\u007f',
    'agent\u00a0next'
  ]) {
    expect(isRuntimeIdentity(id)).toBe(false)
    expect(() =>
      parseHostSpawnReceipt({
        protocol: 'host-spawn-receipt/v1',
        agent_id: id,
        runtime: 'fixture',
        model: 'fixture',
        isolation: 'fixture'
      })
    ).toThrow('HOST_RECEIPT_INVALID')
  }
})
