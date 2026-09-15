import { createHash } from 'node:crypto'

/**
 * A verified position in the event log: the first `count` lines, `bytes` long, whose per-line hash
 * chain ends at `chain`. The committed binding stored in controller state is the position of the
 * whole log; a checkpoint is an earlier one. Chaining lets a reader verify only the lines after a
 * trusted position and lets a commit extend the binding by exactly the lines it appends.
 */
export type EventLogPoint = Readonly<{ count: number; bytes: number; chain: string }>
export type EventLogBinding = EventLogPoint

export const LOG_START: EventLogPoint = { count: 0, bytes: 0, chain: '' }

const link = (chain: string, line: Uint8Array) =>
  createHash('sha256').update(chain).update('\n').update(line).digest('hex')

export function isEventLogPoint(value: unknown): value is EventLogPoint {
  const point = value as EventLogPoint | null
  return (
    !!point &&
    typeof point === 'object' &&
    Number.isSafeInteger(point.count) &&
    point.count >= 0 &&
    Number.isSafeInteger(point.bytes) &&
    point.bytes >= 0 &&
    typeof point.chain === 'string' &&
    /^([0-9a-f]{64})?$/.test(point.chain)
  )
}

export const samePoint = (a: EventLogPoint, b: EventLogPoint): boolean =>
  a.count === b.count && a.bytes === b.bytes && a.chain === b.chain

/**
 * Advance from `from` over `bytes`, which start exactly at `from.bytes`, stopping once `until` lines
 * are covered. Empty segments consume bytes but are not lines, matching how events are parsed.
 */
export function advancePoint(
  bytes: Uint8Array,
  from: EventLogPoint,
  until = Infinity
): EventLogPoint {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let { count, bytes: offset, chain } = from
  let start = 0
  while (start < buffer.length && count < until) {
    const newline = buffer.indexOf(10, start)
    const end = newline < 0 ? buffer.length : newline
    if (end > start) {
      chain = link(chain, buffer.subarray(start, end))
      count++
    }
    const consumed = (newline < 0 ? end : end + 1) - start
    offset += consumed
    start += consumed
  }
  return { count, bytes: offset, chain }
}

/** Bind event bytes that begin at `from` (the start of the log by default). */
export function eventLogBinding(
  events: Uint8Array,
  from: EventLogPoint = LOG_START
): EventLogBinding {
  return advancePoint(events, from)
}

/**
 * Detect removed, reordered, inserted or altered history in the bytes read after `from`, and return
 * the position at the end of those bytes. Many evidence gates ask "did a later invalidating event
 * happen?", so a silently truncated log would revive stale evidence. A log that only extends the
 * committed extent is an interrupted commit: transaction recovery or an authorized takeover handles
 * it; any other difference is never repaired. A reader that starts at a checkpoint verifies only what
 * it reads; lines before the checkpoint are verified whenever the whole log is read (audit, SHIP and
 * every rule that consults full history).
 */
export function assertEventLogBinding(
  state: Record<string, unknown>,
  events: Uint8Array,
  allowTailAhead = false,
  from: EventLogPoint = LOG_START
): EventLogPoint {
  if (state.event_log === undefined) return advancePoint(events, from)
  const value = state.event_log
  if (!isEventLogPoint(value)) throw new Error('EVENT_LOG_BINDING_INVALID')
  const binding = value
  if (binding.count < from.count || binding.bytes < from.bytes)
    throw new Error('EVENT_LOG_HISTORY_MISMATCH: committed event history was altered')
  const at = advancePoint(events, from, binding.count)
  if (!samePoint(at, binding))
    throw new Error('EVENT_LOG_HISTORY_MISMATCH: committed event history was altered')
  const end = advancePoint(Buffer.from(events).subarray(at.bytes - from.bytes), at)
  if (end.count === binding.count || allowTailAhead) return end
  throw new Error('EVENT_LOG_TAIL_AHEAD: recover the transaction or use authorized takeover')
}

/** Parse controller state; opaque transaction bytes that are not a JSON object carry no binding. */
export function parseStateObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Return state bytes carrying the binding of the events committed with them. */
export function bindEventLog(stateBytes: Uint8Array, binding: EventLogBinding): Buffer {
  const state = parseStateObject(stateBytes)
  if (!state) return Buffer.from(stateBytes)
  return Buffer.from(JSON.stringify({ ...state, event_log: binding }))
}
