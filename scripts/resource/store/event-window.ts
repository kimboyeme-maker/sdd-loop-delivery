import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import {
  advancePoint,
  assertEventLogBinding,
  isEventLogPoint,
  LOG_START,
  type EventLogPoint
} from './event-log-binding'

type Item = Record<string, unknown>
const MISMATCH = 'EVENT_LOG_HISTORY_MISMATCH: committed event history was altered'

/**
 * Where round-scoped readers start: the checkpoint recorded when the last round closed, when the
 * state carries a chained binding and a checkpoint inside it; otherwise the start of the log.
 */
export function windowStart(state: Item): EventLogPoint {
  const binding = state.event_log
  const checkpoint = state.event_checkpoint
  if (!isEventLogPoint(binding) || checkpoint == null) return LOG_START
  if (
    !isEventLogPoint(checkpoint) ||
    checkpoint.count > binding.count ||
    checkpoint.bytes > binding.bytes
  )
    throw new Error('EVENT_CHECKPOINT_INVALID')
  return checkpoint
}

/** Raw bytes from `offset` to the end of the file; an absent file reads as empty. */
export function readFrom(path: string, offset: number): Buffer {
  if (!existsSync(path)) {
    if (offset > 0) throw new Error(MISMATCH)
    return Buffer.alloc(0)
  }
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size < offset) throw new Error(MISMATCH)
    const bytes = Buffer.alloc(size - offset)
    for (let read = 0; read < bytes.length;) {
      const count = readSync(fd, bytes, read, bytes.length - read, offset + read)
      if (count === 0) throw new Error(MISMATCH)
      read += count
    }
    return bytes
  } finally {
    closeSync(fd)
  }
}

/** Bytes after a position, which must fall on a line boundary. */
export function readEventBytes(path: string, from: EventLogPoint): Buffer {
  if (from.bytes > 0) {
    const boundary = readFrom(path, from.bytes - 1)
    if (boundary[0] !== 10) throw new Error(MISMATCH)
    return boundary.subarray(1)
  }
  return readFrom(path, 0)
}

/**
 * Read committed events and verify exactly what was read against the state's binding: the whole log
 * (`full`) or the lines after the checkpoint (`window`).
 */
export function readCommittedEvents(
  path: string,
  state: Item,
  scope: 'full' | 'window',
  allowTailAhead = false
): Readonly<{ bytes: Buffer; from: EventLogPoint; end: EventLogPoint }> {
  const from = scope === 'full' ? LOG_START : windowStart(state)
  const bytes = readEventBytes(path, from)
  return { bytes, from, end: assertEventLogBinding(state, bytes, allowTailAhead, from) }
}

/** A lazily read, verified event source for controllers that decode state before reading history. */
export function committedEventReader(
  path: string,
  state: () => Item,
  scope: 'full' | 'window' = 'full'
): () => Buffer {
  let bytes: Buffer | undefined
  return () => (bytes ??= readCommittedEvents(path, state(), scope).bytes)
}

/** The position after `count` lines of a log that starts at the beginning of `bytes`. */
export function pointAt(bytes: Uint8Array, count: number): EventLogPoint {
  const point = advancePoint(bytes, LOG_START, count)
  if (point.count !== count) throw new Error('EVENT_CHECKPOINT_INVALID')
  return point
}
