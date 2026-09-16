import { expect, test } from 'bun:test'
import { argvMatchesMethod, assertMethodBinding } from '../scripts/domain/policies/method-binding'

const PIPED =
  'vitest run -t "CASE" --reporter=json | node -e "if(!j.numPassedTests)throw new Error(0)"'

test('argv binds to the declared method only when it can only have come from it', () => {
  // The faithful execution of a shell command line, which is what a method is.
  expect(argvMatchesMethod(['sh', '-c', PIPED], PIPED)).toBe(true)
  expect(argvMatchesMethod(['bash', '-c', PIPED], PIPED)).toBe(true)
  // The mangling this check exists to catch: the pipe and its arguments become file filters, the
  // run matches nothing, and it exits 0. Silent and green is the worst available failure.
  expect(argvMatchesMethod(PIPED.split(' '), PIPED)).toBe(false)
  // A plain command may be split on spaces, because nothing in it changes meaning that way.
  expect(argvMatchesMethod(['bun', 'test/check.ts'], 'bun test/check.ts')).toBe(true)
  expect(argvMatchesMethod(['bun', 'test/check.ts'], 'bun  test/check.ts')).toBe(true)
  // Quoting does change meaning under a naive split, so that form is refused rather than guessed.
  expect(argvMatchesMethod(['echo', '"a', 'b"'], 'echo "a b"')).toBe(false)
  expect(argvMatchesMethod(['sh', '-c', 'echo "a b"'], 'echo "a b"')).toBe(true)
  // A different command entirely, and the empty method, are never a match.
  expect(argvMatchesMethod(['true'], 'bun test/check.ts')).toBe(false)
  expect(argvMatchesMethod(['sh', '-c', 'true'], '   ')).toBe(false)
})

test('a run is bound to every acceptance it claims to observe', () => {
  const method = 'bun test/check.ts'
  expect(() => assertMethodBinding(['sh', '-c', method], [{ id: 'YS01', method }])).not.toThrow()
  // One command produces one observation, so two acceptances can share a run only by sharing a
  // method; the contract already forbids two INDEPENDENT cases sharing one.
  expect(() =>
    assertMethodBinding(
      ['sh', '-c', method],
      [
        { id: 'YS01', method },
        { id: 'YS02', method: 'bun test/other.ts' }
      ]
    )
  ).toThrow('TEST_RUN_METHOD_MISMATCH: YS02')
  // An acceptance with no method cannot bind anything, and saying so names the case.
  expect(() => assertMethodBinding(['true'], [{ id: 'YS03' }])).toThrow(
    'TEST_RUN_METHOD_UNDECLARED: YS03'
  )
})
