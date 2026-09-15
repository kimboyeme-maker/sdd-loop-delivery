import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  advancePoint,
  assertEventLogBinding,
  bindEventLog,
  eventLogBinding,
  isEventLogPoint,
  LOG_START,
  parseStateObject,
  samePoint,
  type EventLogPoint
} from './event-log-binding'
import { readEventBytes, readFrom, windowStart } from './event-window'
import { acquireControlLock } from './control-lock'

export type SidecarFiles = Readonly<{
  state: string
  events: string
  journal: string
  lock: string
}>

/** Appending journal: the event log grows by `appendedEventsBytes` at `beforeEventsBytes`. */
type JournalV2 = Readonly<{
  protocol: 'control-transaction/v2'
  beforeState: string
  beforeEventsBytes: number
  afterState: string
  appendedEvents: string
  afterStateBytes: string
  appendedEventsBytes: string
  proof: string
}>

export type JournalSecurity = Readonly<{
  sign: (bytes: Uint8Array) => string
  verify: (bytes: Uint8Array, proof: string) => boolean
}>

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Commit state and appended event bytes in journal → events → state order.
 * The lock covers this commit, not the caller's earlier reads or authentication.
 * Controllers supply the exact state bytes used for their decision in `expected`; the state binds
 * the event log, so equal state bytes and a verified log mean the decision's history is current.
 * A stale decision must be recomputed and reauthenticated, never blindly retried.
 * The expected snapshot is mandatory; omitting it must never bypass this check.
 * Only the lines after the checkpoint are verified here, and only the appended bytes are written, so
 * a commit costs the current round, not the whole delivery.
 * A failure after journal persistence leaves recovery data; do not replay the use case.
 */
export function commitSidecar(
  files: SidecarFiles,
  nextState: Uint8Array,
  appendedEvents: Uint8Array,
  security: JournalSecurity,
  expected: Readonly<{ state: Uint8Array; allowEventTailAhead?: boolean }>,
  afterStage: (stage: 'journal' | 'events' | 'state') => void = () => {}
): void {
  if (!expected || !(expected.state instanceof Uint8Array))
    throw new Error('CONTROL_TRANSACTION_SNAPSHOT_REQUIRED')
  const lock = acquireControlLock(files.lock)
  try {
    if (existsSync(files.journal)) throw new Error('CONTROL_TRANSACTION_PENDING')
    const beforeState = readRequired(files.state)
    // Compare under the lock before creating any durable transaction output.
    if (!Buffer.from(beforeState).equals(Buffer.from(expected.state)))
      throw new Error('CONTROL_TRANSACTION_STALE_SNAPSHOT')
    // Every mutation proves the log it builds on is the committed one, then binds its own.
    const base = committedEnd(
      files.events,
      beforeState,
      nextState,
      expected.allowEventTailAhead === true
    )
    nextState = bindEventLog(nextState, eventLogBinding(appendedEvents, base))
    const unsigned: Omit<JournalV2, 'proof'> = {
      protocol: 'control-transaction/v2',
      beforeState: digest(beforeState),
      beforeEventsBytes: base.bytes,
      afterState: digest(nextState),
      appendedEvents: digest(appendedEvents),
      afterStateBytes: Buffer.from(nextState).toString('base64'),
      appendedEventsBytes: Buffer.from(appendedEvents).toString('base64')
    }
    const unsignedBytes = Buffer.from(JSON.stringify(unsigned))
    const journal: JournalV2 = { ...unsigned, proof: security.sign(unsignedBytes) }
    atomic(files.journal, Buffer.from(JSON.stringify(journal)))
    afterStage('journal')
    appendAt(files.events, base.bytes, appendedEvents)
    afterStage('events')
    atomic(files.state, nextState)
    afterStage('state')
    unlinkRequired(files.journal)
    syncDirectory(dirname(files.state))
  } finally {
    closeSync(lock)
    unlinkIfPresent(files.lock)
  }
}

/**
 * Verify the committed log from the checkpoint and return its end, where appended events go. A
 * commit that moves the checkpoint must place it on a verified line boundary; one that moves it
 * backwards verifies the whole log.
 */
function committedEnd(
  eventsPath: string,
  beforeState: Uint8Array,
  nextState: Uint8Array,
  allowTailAhead: boolean
): EventLogPoint {
  const committed = parseStateObject(beforeState)
  if (!committed) return eventLogBinding(readFrom(eventsPath, 0))
  const prior = windowStart(committed)
  const proposed = parseStateObject(nextState)?.event_checkpoint
  const moved =
    proposed != null &&
    !(
      isEventLogPoint(committed.event_checkpoint) &&
      isEventLogPoint(proposed) &&
      samePoint(proposed, committed.event_checkpoint)
    )
  if (moved && !isEventLogPoint(proposed)) throw new Error('EVENT_CHECKPOINT_INVALID')
  const from = moved && (proposed as EventLogPoint).count < prior.count ? LOG_START : prior
  const bytes = readEventBytes(eventsPath, from)
  const end = assertEventLogBinding(committed, bytes, allowTailAhead, from)
  if (moved) {
    const point = proposed as EventLogPoint
    const at = advancePoint(bytes, from, point.count)
    if (point.count > end.count || !samePoint(at, point))
      throw new Error('EVENT_CHECKPOINT_INVALID')
  }
  return end
}

/**
 * Finish the signed after-image only when current bytes match a reachable commit stage.
 * Reject unrelated bytes instead of overwriting them. This validates the journal
 * supplied to this implementation.
 */
export function recoverSidecar(
  files: SidecarFiles,
  security: JournalSecurity
): 'recovered' | 'nothing-pending' {
  const lock = acquireControlLock(files.lock)
  try {
    if (!existsSync(files.journal)) return 'nothing-pending'
    const journal = parseJournal(readRequired(files.journal), security)
    const state = digest(readRequired(files.state))
    const appended = Buffer.from(journal.appendedEventsBytes, 'base64')
    const tail = readFrom(files.events, journal.beforeEventsBytes)
    // The events stage may have been cut short: any prefix of the appended bytes is resumable.
    const partial = tail.length <= appended.length && appended.subarray(0, tail.length).equals(tail)
    const before = state === journal.beforeState && partial
    const complete = state === journal.afterState && tail.equals(appended)
    if (!before && !complete) throw new Error('CONTROL_TRANSACTION_STORE_MISMATCH')
    if (!complete) {
      appendAt(files.events, journal.beforeEventsBytes, appended)
      atomic(files.state, Buffer.from(journal.afterStateBytes, 'base64'))
    }
    unlinkRequired(files.journal)
    syncDirectory(dirname(files.state))
    return 'recovered'
  } finally {
    closeSync(lock)
    unlinkIfPresent(files.lock)
  }
}

function parseJournal(bytes: Uint8Array, security: JournalSecurity): JournalV2 {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new Error('CONTROL_TRANSACTION_JOURNAL_INVALID')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('CONTROL_TRANSACTION_JOURNAL_INVALID')
  const record = value as Record<string, unknown>
  const hex = (key: string) =>
    typeof record[key] === 'string' && /^[0-9a-f]{64}$/.test(record[key] as string)
  const valid =
    record.protocol === 'control-transaction/v2' &&
    ['beforeState', 'afterState', 'appendedEvents'].every(hex) &&
    Number.isSafeInteger(record.beforeEventsBytes) &&
    Number(record.beforeEventsBytes) >= 0 &&
    typeof record.afterStateBytes === 'string' &&
    typeof record.appendedEventsBytes === 'string'
  if (!valid || typeof record.proof !== 'string')
    throw new Error('CONTROL_TRANSACTION_JOURNAL_INVALID')
  const journal = record as unknown as JournalV2
  const { proof: _proof, ...unsigned } = journal
  if (!security.verify(Buffer.from(JSON.stringify(unsigned)), journal.proof))
    throw new Error('CONTROL_TRANSACTION_JOURNAL_SIGNATURE_INVALID')
  const [events, eventsDigest] = [journal.appendedEventsBytes, journal.appendedEvents]
  if (
    digest(Buffer.from(journal.afterStateBytes, 'base64')) !== journal.afterState ||
    digest(Buffer.from(events, 'base64')) !== eventsDigest
  )
    throw new Error('CONTROL_TRANSACTION_JOURNAL_INVALID')
  return journal
}

function readRequired(path: string): Uint8Array {
  if (!existsSync(path)) throw new Error('CONTROL_TRANSACTION_FILE_MISSING')
  return readFileSync(path)
}

function atomic(path: string, bytes: Uint8Array): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, path)
    syncDirectory(dirname(path))
  } finally {
    unlinkIfPresent(temporary)
  }
}

/** Write `bytes` at `offset`, discarding anything after it (an interrupted earlier attempt). */
function appendAt(path: string, offset: number, bytes: Uint8Array): void {
  const created = !existsSync(path)
  if (created && offset > 0) throw new Error('CONTROL_TRANSACTION_FILE_MISSING')
  const fd = openSync(path, created ? 'w' : 'r+', 0o600)
  try {
    ftruncateSync(fd, offset)
    for (let written = 0; written < bytes.length;)
      written += writeSync(fd, bytes, written, bytes.length - written, offset + written)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (created) syncDirectory(dirname(path))
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function unlinkRequired(path: string): void {
  if (!existsSync(path)) throw new Error('CONTROL_TRANSACTION_FILE_MISSING')
  unlinkSync(path)
}

function unlinkIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path)
}
