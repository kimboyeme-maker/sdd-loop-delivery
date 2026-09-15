import { expect, test } from 'bun:test'
import { assertProductRoleHistory } from '../scripts/domain/policies/role-history'

test('role history excludes prior Coordinators, cross-role reuse and retired runtimes', () => {
  const state = {
    coordinator_agent_id: 'current',
    coordinator_agent_ids: ['previous'],
    issued_leases: { old: { agent_id: 'operator', role: 'operator', authority_epoch: 1 } }
  }
  expect(() => assertProductRoleHistory(state, [], 'operator', 'operator')).not.toThrow()
  expect(() => assertProductRoleHistory(state, [], 'architect', 'architect')).not.toThrow()
  expect(() => assertProductRoleHistory(state, [], 'previous', 'operator')).toThrow(
    'COORDINATOR_CANNOT_RECEIVE_TASK_ROLE_LEASE'
  )
  expect(() => assertProductRoleHistory(state, [], 'operator', 'architect')).toThrow(
    'RUNTIME_CROSS_ROLE_FORBIDDEN'
  )
  const events = [
    { type: 'runtime_record', payload: { agent_id: 'operator', action: 'retire' } },
    { type: 'runtime_record', payload: { agent_id: 'operator', action: 'observe' } }
  ]
  expect(() => assertProductRoleHistory(state, events, 'operator', 'operator')).toThrow(
    'RUNTIME_RETIRED'
  )
  expect(() => assertProductRoleHistory(state, events, 'architect', 'architect')).not.toThrow()
})

test('malformed Coordinator history cannot erase product role exclusions', () => {
  for (const history of [null, 'previous', {}, 0, ['previous', null], ['previous', ' ']])
    for (const role of ['operator', 'architect'] as const)
      expect(() =>
        assertProductRoleHistory(
          { coordinator_agent_id: 'current', coordinator_agent_ids: history },
          [],
          'previous',
          role
        )
      ).toThrow('COORDINATOR_HISTORY_INVALID')
  expect(() =>
    assertProductRoleHistory(
      { coordinator_agent_ids: ['/root/previous'] },
      [],
      '/root/previous',
      'operator'
    )
  ).toThrow('COORDINATOR_CANNOT_RECEIVE_TASK_ROLE_LEASE')
})

test('malformed lease history cannot silently permit role reuse', () => {
  for (const leases of [
    null,
    [],
    0,
    '',
    { old: null },
    { old: [] },
    { old: {} },
    { old: { agent_id: 'operator' } },
    { old: { agent_id: 'operator', role: 'unknown' } }
  ])
    expect(() =>
      assertProductRoleHistory({ issued_leases: leases }, [], 'operator', 'architect')
    ).toThrow('RUNTIME_LEASE_HISTORY_INVALID')
  for (const leases of [undefined, {}, { old: { agent_id: 'operator', role: 'operator' } }])
    expect(() =>
      assertProductRoleHistory({ issued_leases: leases }, [], 'operator', 'operator')
    ).not.toThrow()
})
