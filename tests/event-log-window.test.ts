import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { roundCheckpoint, roundScopedEvents } from '../scripts/helpers/event-checkpoint'
import { eventLogBinding } from '../scripts/resource/store/event-log-binding'
import { pointAt, readCommittedEvents } from '../scripts/resource/store/event-window'
import { commitSidecar } from '../scripts/resource/store/sidecar-transaction'

type Item = Record<string, unknown>
const line = (id: string, type = 'note', payload: Item = {}) =>
  JSON.stringify({ event_id: id, type, payload }) + '\n'
const sign = (bytes: Uint8Array) => createHmac('sha256', 'key').update(bytes).digest('hex')
const security = { sign, verify: (bytes: Uint8Array, proof: string) => sign(bytes) === proof }
const sameSize = (text: string, from: string, to: string) => {
  expect(to.length).toBe(from.length)
  return text.replace(from, to)
}

test('a checkpoint window verifies only what it reads; the whole log verifies everything', () => {
  const root = mkdtempSync(join(tmpdir(), 'event-window-'))
  const path = join(root, 'events')
  try {
    const log = ['EVT-1', 'EVT-2', 'EVT-3', 'EVT-4', 'EVT-5'].map((id) => line(id)).join('')
    const bytes = Buffer.from(log)
    const state = { event_log: eventLogBinding(bytes), event_checkpoint: pointAt(bytes, 2) }
    writeFileSync(path, log)
    const window = readCommittedEvents(path, state, 'window')
    expect(window.from.count).toBe(2)
    expect(window.bytes.toString()).toBe([3, 4, 5].map((n) => line(`EVT-${n}`)).join(''))
    // An interrupted commit's extra line is reported as such, and adoptable when allowed.
    writeFileSync(path, log + line('EVT-6'))
    expect(() => readCommittedEvents(path, state, 'window')).toThrow('EVENT_LOG_TAIL_AHEAD')
    expect(readCommittedEvents(path, state, 'window', true).end.count).toBe(6)
    // Altered, removed or shifted lines inside the window are refused.
    writeFileSync(path, sameSize(log, 'EVT-4', 'EVT-X'))
    expect(() => readCommittedEvents(path, state, 'window')).toThrow('EVENT_LOG_HISTORY_MISMATCH')
    writeFileSync(path, log.replace(line('EVT-1'), ''))
    expect(() => readCommittedEvents(path, state, 'window')).toThrow('EVENT_LOG_HISTORY_MISMATCH')
    // A same-size change before the checkpoint is outside the window; reading history finds it.
    writeFileSync(path, sameSize(log, 'EVT-1', 'EVT-Y'))
    expect(readCommittedEvents(path, state, 'window').end.count).toBe(5)
    expect(() => readCommittedEvents(path, state, 'full')).toThrow('EVENT_LOG_HISTORY_MISMATCH')
    expect(() =>
      readCommittedEvents(
        path,
        { ...state, event_checkpoint: pointAt(Buffer.from(log + line('EVT-6')), 6) },
        'window'
      )
    ).toThrow('EVENT_CHECKPOINT_INVALID')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a commit appends after the verified window and accepts only a checkpoint on a verified boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'event-commit-'))
  const files = {
    state: join(root, 'state'),
    events: join(root, 'events'),
    journal: join(root, 'journal'),
    lock: join(root, 'lock')
  }
  try {
    const log = ['EVT-1', 'EVT-2', 'EVT-3', 'EVT-4'].map((id) => line(id)).join('')
    const bytes = Buffer.from(log)
    const before = Buffer.from(
      JSON.stringify({
        revision: 1,
        event_log: eventLogBinding(bytes),
        event_checkpoint: pointAt(bytes, 1)
      })
    )
    writeFileSync(files.state, before)
    writeFileSync(files.events, log)
    const next = (checkpoint: unknown) =>
      Buffer.from(JSON.stringify({ revision: 2, event_checkpoint: checkpoint }))
    const forged = { ...pointAt(bytes, 3), chain: pointAt(bytes, 2).chain }
    expect(() =>
      commitSidecar(files, next(forged), Buffer.from(line('EVT-5')), security, { state: before })
    ).toThrow('EVENT_CHECKPOINT_INVALID')
    expect(readFileSync(files.state)).toEqual(before)
    expect(readFileSync(files.events, 'utf8')).toBe(log)
    expect(existsSync(files.journal)).toBe(false)
    commitSidecar(files, next(pointAt(bytes, 3)), Buffer.from(line('EVT-5')), security, {
      state: before
    })
    const after = Buffer.from(log + line('EVT-5'))
    expect(readFileSync(files.events)).toEqual(after)
    const committed = JSON.parse(readFileSync(files.state, 'utf8')) as Item
    expect(committed.event_log).toEqual(eventLogBinding(after))
    expect(committed.event_checkpoint).toEqual(pointAt(after, 3))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a round checkpoint keeps the admission, candidate and live grants readable as one window', () => {
  const events = [
    { event_id: 'EVT-old', type: 'note' },
    { event_id: 'EVT-a0', type: 'contract_admission' },
    { event_id: 'EVT-a1', type: 'contract_admission' },
    { event_id: 'EVT-i', type: 'implementation' },
    { event_id: 'EVT-d', type: 'dispatch' },
    { event_id: 'EVT-s', type: 'agent_started' }
  ]
  const bytes = Buffer.from(events.map((event) => JSON.stringify(event) + '\n').join(''))
  const lease = { lease_id: 'L', dispatch_event_id: 'EVT-d', started_event_id: 'EVT-s' }
  expect(roundCheckpoint({ active_lease: lease }, events, bytes)).toEqual(pointAt(bytes, 2))
  // A grant that still refers to an older event keeps that event inside the window.
  const older = { ...lease, guidance_id: 'EVT-old' }
  expect(roundCheckpoint({ active_lease: older }, events, bytes)).toEqual(pointAt(bytes, 0))
  const window = events.slice(2)
  const full = () => events
  expect(roundScopedEvents({ active_lease: lease }, () => window, full)).toBe(window)
  expect(roundScopedEvents({ active_lease: older }, () => window, full)).toBe(events)
  expect(roundScopedEvents({ active_lease: lease }, () => null, full)).toBe(events)
})
