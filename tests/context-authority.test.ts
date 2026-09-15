import { expect, test } from 'bun:test'
import { assertCurrentLease, createContext } from '../scripts/context/context'
import { assertLease } from '../scripts/domain/entities/lease'

const metadata = {
  protocol: 'skill-invocation/v1',
  invocation_id: 'invocation',
  started_at: '2026-09-13T00:00:00Z',
  origin: 'explicit'
}

test('invocation metadata rejects blank identities and unparseable start times', () => {
  for (const patch of [
    { invocation_id: '   ' },
    { started_at: 'not-a-time' },
    { started_at: 'Infinity' },
    { started_at: '' }
  ]) {
    expect(() => createContext({ ...metadata, ...patch }, '/tmp/task.md', () => 1000)).toThrow(
      'INVOCATION_METADATA_INVALID'
    )
  }
  const context = createContext(metadata, '/tmp/task.md', () => 1000)
  expect(context.skill.invocation.started_at).toBe(metadata.started_at)
  expect(Object.isFrozen(context.skill.invocation)).toBe(true)
})

test('context and domain lease checks reject non-finite time and exclusive expiry', () => {
  for (const [now, deadline] of [
    [NaN, 2000],
    [Infinity, 2000],
    [-Infinity, 2000],
    [1000, NaN],
    [1000, Infinity],
    [1000, -Infinity],
    [2000, 2000],
    [2001, 2000]
  ]) {
    const context = createContext(metadata, '/tmp/task.md', () => now!)
    expect(() =>
      assertCurrentLease(
        context,
        {
          active: true,
          deadline: deadline!,
          epoch: 1,
          agentId: 'operator',
          leaseId: 'lease'
        },
        { epoch: 1, agentId: 'operator', leaseId: 'lease' }
      )
    ).toThrow('LEASE_INACTIVE')
    expect(() =>
      assertLease(
        {
          id: 'lease',
          agentId: 'operator',
          role: 'Operator',
          epoch: 1,
          deadline: deadline!,
          scope: []
        },
        { leaseId: 'lease', agentId: 'operator', role: 'Operator', epoch: 1, now: now! }
      )
    ).toThrow('LEASE_EXPIRED')
  }
  const context = createContext(metadata, '/tmp/task.md', () => 1999)
  expect(() =>
    assertCurrentLease(
      context,
      {
        active: true,
        deadline: 2000,
        epoch: 1,
        agentId: 'operator',
        leaseId: 'lease'
      },
      { epoch: 1, agentId: 'operator', leaseId: 'lease' }
    )
  ).not.toThrow()
})

test('matching empty identities and invalid epochs do not establish authority', () => {
  const context = createContext(metadata, '/tmp/task.md', () => 1000)
  for (const identity of [
    { epoch: 0, agentId: 'operator', leaseId: 'lease' },
    { epoch: 1.5, agentId: 'operator', leaseId: 'lease' },
    { epoch: Infinity, agentId: 'operator', leaseId: 'lease' },
    { epoch: 1, agentId: ' ', leaseId: 'lease' },
    { epoch: 1, agentId: 'operator', leaseId: '' }
  ]) {
    expect(() =>
      assertCurrentLease(context, { active: true, deadline: 2000, ...identity }, identity)
    ).toThrow('LEASE_BINDING_MISMATCH')
  }
})
