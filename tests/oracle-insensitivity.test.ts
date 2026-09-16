import { expect, test } from 'bun:test'
import { assertOracleSensitivity } from '../scripts/domain/policies/oracle-insensitivity'

type Item = Record<string, unknown>

const METHOD = 'bun test/check.ts'

const contract = (timing = 'IMPLEMENTATION_REQUIRED', applicability = 'REQUIRED'): Item => ({
  acceptance: [
    {
      id: 'YS01',
      method: METHOD,
      oracle_sensitivity: { applicability, implementation_timing: timing }
    },
    { id: 'YS02', method: 'bun test/other.ts' }
  ]
})

const run = (id: string, outcome: string, acceptance = ['YS01'], method = METHOD): Item => ({
  event_id: id,
  type: 'test_run',
  payload: { outcome, acceptance_ids: acceptance, argv: ['sh', '-c', method] }
})
const implementation: Item = { event_id: 'EVT-IMPL', type: 'implementation' }

test('an acceptance that passed before its implementation is reported as insensitive', () => {
  // The rehearsal recorded exactly this pair: a PASS on an empty tree, then a PASS on the real one.
  // The outcome field cannot tell them apart, so the oracle cannot detect losing its own case.
  const events = [run('EVT-EARLY', 'PASS'), implementation, run('EVT-LATE', 'PASS')]
  expect(() => assertOracleSensitivity(contract(), events)).toThrow(
    'ACCEPTANCE_ORACLE_INSENSITIVE: YS01 passed before its implementation (EVT-EARLY)'
  )
  // A FAIL before implementation is the expected shape and proves the oracle discriminates.
  expect(() =>
    assertOracleSensitivity(contract(), [run('EVT-EARLY', 'FAIL'), implementation])
  ).not.toThrow()
  // Never running it early accuses nobody: absence is not evidence in either direction.
  expect(() => assertOracleSensitivity(contract(), [implementation])).not.toThrow()
  // A PASS after implementation is the ordinary result.
  expect(() =>
    assertOracleSensitivity(contract(), [implementation, run('EVT-LATE', 'PASS')])
  ).not.toThrow()
})

test('the rule applies only where the contract claims the behaviour does not exist yet', () => {
  const early = [run('EVT-EARLY', 'PASS'), implementation]
  // A baseline-verified acceptance is expected to pass beforehand; that is what the timing says.
  expect(() => assertOracleSensitivity(contract('VERIFIED_BASELINE'), early)).not.toThrow()
  expect(() =>
    assertOracleSensitivity(contract('IMPLEMENTATION_REQUIRED', 'NOT_APPLICABLE'), early)
  ).not.toThrow()
  // An unrelated acceptance passing early says nothing about the one under the rule.
  expect(() =>
    assertOracleSensitivity(contract(), [run('EVT-EARLY', 'PASS', ['YS02']), implementation])
  ).not.toThrow()
})

test('an early PASS of a different command says nothing about the method now declared', () => {
  // The real delivery that produced this rule shipped exactly this history: the insensitive method
  // passed on an empty tree, was replaced by amendment, and the replacement never did. Condemning
  // the new oracle for the old one's run would make replacing an insensitive method pointless.
  const superseded = [
    run('EVT-OLD', 'PASS', ['YS01'], 'vitest run -t "CASE"'),
    implementation,
    run('EVT-NEW', 'PASS')
  ]
  expect(() => assertOracleSensitivity(contract(), superseded)).not.toThrow()
  // The same history with the current method is still refused, so this is not a way out.
  expect(() =>
    assertOracleSensitivity(contract(), [run('EVT-OLD', 'PASS'), implementation])
  ).toThrow('ACCEPTANCE_ORACLE_INSENSITIVE')
})

test('a later round is measured against the first receipt, not its own', () => {
  // A re-verified round runs its acceptance before recording that round's receipt, with the product
  // change already in the tree. Anchoring on the latest receipt would call every re-verification
  // insensitive; anchoring on the first says what the rule means — before anything was delivered.
  const second = [
    run('EVT-R1', 'PASS'),
    implementation,
    run('EVT-R2-EARLY', 'PASS'),
    { event_id: 'EVT-IMPL-2', type: 'implementation' } as Item
  ]
  expect(() => assertOracleSensitivity(contract(), second.slice(1))).not.toThrow()
  // A delivery with no receipt at all has produced nothing to compare against.
  expect(() => assertOracleSensitivity(contract(), [run('EVT-ONLY', 'PASS')])).not.toThrow()
})
