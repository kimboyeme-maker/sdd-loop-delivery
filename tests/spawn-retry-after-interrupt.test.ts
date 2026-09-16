import { expect, test } from 'bun:test'
import { spawnDecision } from '../scripts/helpers/runtime-facts'

type Item = Record<string, unknown>
const record = (payload: Item): Item => ({ type: 'runtime_record', payload })
const limit = record({ action: 'spawn_result', result: 'LIMIT' })

test('an interruption reopens exactly one spawn attempt on a host that cannot close', () => {
  // Without this, a host with no `close` and no slot count never leaves LIMIT_UNCHANGED: no close
  // will ever be recorded and there is nothing to observe, so the delivery stalls permanently.
  expect(spawnDecision([limit])).toBe('LIMIT_UNCHANGED')
  const interrupted = record({ action: 'interrupt_result', ended_turn: true })
  expect(spawnDecision([limit, interrupted])).toBe('ALLOWED')
  // One interruption, one attempt: the attempt consumes it whatever its outcome, so the same
  // evidence cannot keep reopening the door.
  const attempt = record({ action: 'spawn_result', result: 'LIMIT' })
  expect(spawnDecision([limit, interrupted, attempt])).toBe('LIMIT_UNCHANGED')
  expect(spawnDecision([limit, interrupted, attempt, interrupted])).toBe('ALLOWED')
  // An interruption that did not end a turn frees nothing and claims nothing.
  expect(spawnDecision([limit, record({ action: 'interrupt_result' })])).toBe('LIMIT_UNCHANGED')
  // A successful spawn or a real release still reopens it, as before.
  expect(spawnDecision([limit, record({ action: 'spawn_result', result: 'CREATED' })])).toBe(
    'ALLOWED'
  )
  expect(spawnDecision([limit, record({ action: 'close_result', capacity_released: true })])).toBe(
    'ALLOWED'
  )
})
