import { expect, test } from 'bun:test'
import { olderThan } from '../scripts/helpers/runtime-version'

test('a runtime below the floor is rejected and the floor itself is not', () => {
  expect(olderThan('1.3.14', '1.4.2')).toBe(true)
  expect(olderThan('1.4.2', '1.4.2')).toBe(false)
  expect(olderThan('1.4.3', '1.4.2')).toBe(false)
})

test('segments compare numerically, not as text', () => {
  expect(olderThan('1.10.0', '1.4.2')).toBe(false)
  expect(olderThan('1.4.2', '1.10.0')).toBe(true)
})

test('a shorter version pads with zeros', () => {
  expect(olderThan('1.4', '1.4.2')).toBe(true)
  expect(olderThan('2', '1.4.2')).toBe(false)
})
