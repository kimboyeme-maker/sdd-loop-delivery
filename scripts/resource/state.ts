import { createHash as diagnosticHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join as joinPath } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { readCommittedEvents } from './store/event-window'

export type StateSnapshot = Readonly<{
  state: Record<string, unknown>
  /** Private event bytes from the same stable read; never expose the snapshot wholesale. */
  eventText: string
  eventCount: number
  stateHash: string
  eventsHash: string
}>

/**
 * Read native field spellings without manufacturing missing authority metadata.
 * Old aliases are unsupported even when they duplicate a native field exactly.
 * This shape check does not authenticate state or grant execution permission.
 */
export function decodeState(value: unknown, initializing = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('CONTROL_STATE_INVALID')
  if (!('protocol' in value) || value.protocol !== 'control-plane/state-v2')
    throw new Error('CONTROL_STATE_PROTOCOL_UNSUPPORTED')
  if (Object.hasOwn(value, 'initial_event') && !initializing)
    throw new Error('INIT_PUBLICATION_PENDING_RERUN_INIT')
  return { ...value }
}

/** Directory for rejection diagnostics; defaults to the user cache, outside every worktree. */
export const DIAGNOSTICS_DIR_ENV = 'SDD_LOOP_DIAGNOSTICS_DIR'

export function sidecarPaths(sdd: string): Readonly<{
  state: string
  events: string
  journal: string
  lock: string
  rejections: string
  processes: string
  retrospective: string
}> {
  const path = resolve(sdd)
  const diagnostics =
    process.env[DIAGNOSTICS_DIR_ENV] ?? joinPath(homedir(), '.cache', 'sdd-loop-delivery')
  const key = diagnosticHash('sha256').update(path).digest('hex').slice(0, 24)
  return {
    state: `${path}.loop.json`,
    events: `${path}.events.jsonl`,
    journal: `${path}.transaction.json`,
    lock: `${path}.loop.lock`,
    // Non-authoritative diagnostics. Rejections live outside the repository so a rejected command
    // still writes nothing next to the SDD; the retrospective is written only after a commit.
    rejections: joinPath(diagnostics, `${key}.rejections.jsonl`),
    // Records of running test-run process groups, so a person can reclaim them by agent name.
    processes: joinPath(diagnostics, `${key}.processes`),
    retrospective: `${path}.retrospective.json`
  }
}

/** Read a stable pair; unchanged bytes during an unfinished commit are still not committed state. */
export function readSnapshot(sdd: string): StateSnapshot {
  const paths = sidecarPaths(sdd)
  if (existsSync(paths.journal)) throw new Error('CONTROL_TRANSACTION_PENDING')
  if (existsSync(paths.lock)) throw new Error('CONTROL_TRANSACTION_IN_PROGRESS')
  if (!existsSync(paths.state)) throw new Error('LOOP_NOT_INITIALIZED: run init')
  const stateBytes = readFileSync(paths.state)
  const state = decodeState(JSON.parse(stateBytes.toString('utf8')) as Record<string, unknown>)
  let eventBytes: Buffer
  try {
    eventBytes = readCommittedEvents(paths.events, state, 'full').bytes
  } catch (error) {
    // A commit that started meanwhile explains a log ahead of this state better than tampering.
    if (existsSync(paths.journal)) throw new Error('CONTROL_TRANSACTION_PENDING')
    if (existsSync(paths.lock)) throw new Error('CONTROL_TRANSACTION_IN_PROGRESS')
    throw error
  }
  if (existsSync(paths.journal)) throw new Error('CONTROL_TRANSACTION_PENDING')
  if (existsSync(paths.lock)) throw new Error('CONTROL_TRANSACTION_IN_PROGRESS')
  // Commits only append to the log and replace state, so unchanged state bytes and log size mean
  // the pair read above is still the committed one.
  const eventSize = existsSync(paths.events) ? statSync(paths.events).size : 0
  if (!readFileSync(paths.state).equals(stateBytes) || eventSize !== eventBytes.length)
    throw new Error('CONCURRENT_STATE_CHANGED')
  return {
    state,
    eventText: eventBytes.toString('utf8'),
    eventCount:
      eventBytes.length === 0 ? 0 : eventBytes.toString('utf8').split('\n').filter(Boolean).length,
    stateHash: createHash('sha256').update(stateBytes).digest('hex'),
    eventsHash: createHash('sha256').update(eventBytes).digest('hex')
  }
}
