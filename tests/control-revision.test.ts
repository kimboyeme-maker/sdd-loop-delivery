import { test, expect } from 'bun:test'
import { nextControlRevision } from '../scripts/domain/policies/control-revision'

test('control revisions increment exactly and reject coercion or overflow', () => {
  for (const value of [
    undefined,
    null,
    false,
    '1',
    NaN,
    Infinity,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1
  ])
    expect(() => nextControlRevision(value)).toThrow('CONTROL_REVISION_INVALID')
  expect(nextControlRevision(0)).toBe(1)
  expect(nextControlRevision(42)).toBe(43)
  expect(nextControlRevision(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER)
  expect(nextControlRevision(5, 3)).toBe(8)
  expect(nextControlRevision(Number.MAX_SAFE_INTEGER - 3, 3)).toBe(Number.MAX_SAFE_INTEGER)
  expect(() => nextControlRevision(Number.MAX_SAFE_INTEGER - 2, 3)).toThrow(
    'CONTROL_REVISION_INVALID'
  )
  for (const increment of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => nextControlRevision(1, increment)).toThrow('CONTROL_REVISION_INCREMENT_INVALID')
})
