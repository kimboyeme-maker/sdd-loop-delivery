import { expect, test } from 'bun:test'
import { logicFingerprint } from '../scripts/helpers/logic-fingerprint'
import { canonicalJson } from '../scripts/resource/wire/canonical-json'
import { sha256 } from '../scripts/utils/digest'
const document = (logic: string) =>
  '<!-- sdd-contract:start -->\n```json\n{"implementation_logic":' +
  logic +
  '}\n```\n<!-- sdd-contract:end -->'
test('native logic fingerprints retain values and array order', () => {
  const expected = sha256('{"a":9007199254740991,"text":"取消","z":1}')
  expect(logicFingerprint(document('{"z":1.0,"a":9007199254740991,"text":"取消"}'))).toBe(expected)
  expect(logicFingerprint(document('{"text":"取消","a":9007199254740991,"z":1}'))).toBe(expected)
  expect(logicFingerprint(document('{"text":"变化","a":9007199254740991,"z":1}'))).not.toBe(
    expected
  )
  expect(logicFingerprint(document('[1,2]'))).not.toBe(logicFingerprint(document('[2,1]')))
  expect(logicFingerprint('# document without logic')).toBeUndefined()
})
test('native codec rejects lossy values instead of silently signing another value', () => {
  for (const value of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    9007199254740992,
    1n,
    new Date(),
    [undefined],
    Array(1)
  ])
    expect(() => canonicalJson(value)).toThrow()
  expect(() => logicFingerprint(document('{"n":9007199254740993}'))).toThrow(
    'CANONICAL_NUMBER_INVALID'
  )
  expect(() => logicFingerprint(document('{"n":NaN}'))).toThrow()
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  expect(() => canonicalJson(cycle)).toThrow('CANONICAL_CYCLE')
  let getterCalled = false
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      getterCalled = true
      return 1
    }
  })
  expect(() => canonicalJson(accessor)).toThrow('CANONICAL_VALUE_INVALID')
  expect(getterCalled).toBe(false)
  expect(() => canonicalJson(Object.assign([1], { extra: 2 }))).toThrow('CANONICAL_VALUE_INVALID')
  expect(() => canonicalJson(Object.defineProperty({}, 'hidden', { value: 1 }))).toThrow(
    'CANONICAL_VALUE_INVALID'
  )
  const shared = { b: 2, a: 1 }
  expect(canonicalJson([shared, shared])).toBe('[{"a":1,"b":2},{"a":1,"b":2}]')
  expect(canonicalJson({ decimal: 0.25, zero: -0, text: '取消' })).toBe(
    '{"decimal":0.25,"text":"取消","zero":0}'
  )
})
