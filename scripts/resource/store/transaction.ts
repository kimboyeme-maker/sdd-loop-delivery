import { createHash, sign, verify, type KeyObject } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireControlLock } from './control-lock'

/** Reference transaction only: fixed fixture files; production paths remain controller-owned. */
export type Stage = 'journal' | 'events' | 'state' | 'cleanup'
type JournalBody = {
  version: 'design-transaction/v1'
  beforeState: string
  beforeEvents: string
  nextState: string
  nextEvents: string
}
type Envelope = { body: string; signature: string }
type Files = { state: string; events: string; journal: string; lock: string }
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

/** File data and directory entries must both be durable before advancing. */
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function atomicText(path: string, value: string): void {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, value)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, path)
    syncDirectory(dirname(path))
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
function files(root: string): Files {
  return {
    state: join(root, 'state'),
    events: join(root, 'events'),
    journal: join(root, 'journal'),
    lock: join(root, 'lock')
  }
}
function withLock<T>(path: string, body: () => T): T {
  const fd = acquireControlLock(path)
  try {
    return body()
  } finally {
    closeSync(fd)
    unlinkSync(path)
  }
}

/** Authorize and plan under the lock, before the first transaction write. */
export function commit(
  root: string,
  privateKey: KeyObject,
  plan: (state: string, events: string) => { nextState: string; nextEvents: string },
  afterStage: (stage: Stage) => void = () => {},
  cleanup: () => void = () => {}
): void {
  const f = files(root)
  withLock(f.lock, () => {
    if (existsSync(f.journal)) throw new Error('TRANSACTION_PENDING')
    const state = readFileSync(f.state, 'utf8'),
      events = readFileSync(f.events, 'utf8')
    const next = plan(state, events)
    const body: JournalBody = {
      version: 'design-transaction/v1',
      beforeState: hash(state),
      beforeEvents: hash(events),
      ...next
    }
    const bodyText = JSON.stringify(body)
    const envelope: Envelope = {
      body: bodyText,
      signature: sign(null, Buffer.from(bodyText), privateKey).toString('base64')
    }
    atomicText(f.journal, JSON.stringify(envelope))
    afterStage('journal')
    atomicText(f.events, next.nextEvents)
    afterStage('events')
    atomicText(f.state, next.nextState)
    afterStage('state')
    cleanup()
    afterStage('cleanup')
    unlinkSync(f.journal)
    syncDirectory(root)
  })
}

/** Recovery accepts only reachable write-order states and never re-executes the command. */
export function recover(
  root: string,
  publicKey: KeyObject,
  cleanup: () => void = () => {}
): 'recovered' | 'nothing-pending' {
  const f = files(root)
  return withLock(f.lock, () => {
    if (!existsSync(f.journal)) return 'nothing-pending'
    const envelope = JSON.parse(readFileSync(f.journal, 'utf8')) as Envelope
    if (
      !verify(
        null,
        Buffer.from(envelope.body),
        publicKey,
        Buffer.from(envelope.signature, 'base64')
      )
    )
      throw new Error('JOURNAL_SIGNATURE_INVALID')
    const body = JSON.parse(envelope.body) as JournalBody
    if (body.version !== 'design-transaction/v1') throw new Error('JOURNAL_VERSION_INVALID')
    const state = hash(readFileSync(f.state, 'utf8')),
      events = hash(readFileSync(f.events, 'utf8'))
    const before = state === body.beforeState && events === body.beforeEvents
    const eventsWritten = state === body.beforeState && events === hash(body.nextEvents)
    const bothWritten = state === hash(body.nextState) && events === hash(body.nextEvents)
    if (!before && !eventsWritten && !bothWritten) throw new Error('JOURNAL_STORE_MISMATCH')
    atomicText(f.events, body.nextEvents)
    atomicText(f.state, body.nextState)
    cleanup()
    unlinkSync(f.journal)
    syncDirectory(root)
    return 'recovered'
  })
}
