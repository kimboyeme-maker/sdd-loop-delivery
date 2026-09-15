import { parseEvents } from '../resource/store/event-log'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { assertMutablePhase } from '../domain/policies/phase'
import { coordinatorProof, verifyPendingBootstrap } from '../resource/coordinator-evidence'
import { rolePublicKey } from '../resource/role-signature'
import { decodeState, sidecarPaths } from '../resource/state'
import { commitSidecar } from '../resource/store/sidecar-transaction'
import { readCommittedEvents, windowStart } from '../resource/store/event-window'
import { roundScopedEvents } from '../helpers/event-checkpoint'
import { assertCurrentSource } from '../helpers/source-binding'

type Item = Record<string, unknown>

/** Environment variable holding the Coordinator credential; main.ts loads it from its file. */
export const COORDINATOR_TOKEN_ENV = 'SDD_LOOP_COORDINATOR_TOKEN'

/**
 * One consistent view of controller state for a single command. Events are read, verified and
 * parsed lazily and once, so a command that rejects before reading history keeps its original
 * error order. `eventBytes` and `events` are the whole verified log; `windowEvents` are the
 * verified lines after the round checkpoint (null when the state has none).
 */
export type ControlSnapshot = Readonly<{
  sdd: string
  paths: ReturnType<typeof sidecarPaths>
  stateBytes: Buffer
  readonly eventBytes: Buffer
  state: Item
  events: () => Item[]
  windowEvents: () => Item[] | null
}>

/** Read state now and history on demand; later commits compare exactly these state bytes. */
export function loadControl(sdd: string): ControlSnapshot {
  const paths = sidecarPaths(sdd)
  if (!existsSync(paths.state)) throw new Error('LOOP_NOT_INITIALIZED')
  const stateBytes = readFileSync(paths.state)
  const state = decodeState(JSON.parse(stateBytes.toString('utf8'))) as Item
  let full: Buffer | undefined
  let parsed: Item[] | undefined
  let window: Item[] | null | undefined
  return {
    sdd,
    paths,
    stateBytes,
    get eventBytes() {
      return (full ??= readCommittedEvents(paths.events, state, 'full').bytes)
    },
    state,
    events: () =>
      (parsed ??= parseEvents((full ??= readCommittedEvents(paths.events, state, 'full').bytes))),
    windowEvents: () =>
      window !== undefined
        ? window
        : (window =
            windowStart(state).count === 0
              ? null
              : [...parseEvents(readCommittedEvents(paths.events, state, 'window').bytes)])
  }
}

/** Events for round-scoped rules; see `roundScopedEvents`. */
export function roundEvents(control: ControlSnapshot): Item[] {
  return roundScopedEvents(control.state, control.windowEvents, control.events)
}

/** Optimistic concurrency: the caller names the phase and contract revision it reasoned about. */
export function assertExpected(state: Item, expectedState: string, expectedRevision: string): void {
  if (String(state.phase ?? '') !== expectedState) throw new Error('EXPECTED_STATE_MISMATCH')
  if (String(state.contract_revision ?? '') !== expectedRevision)
    throw new Error('EXPECTED_REVISION_MISMATCH')
}

/** The presented credential must hash to the current epoch's registered Coordinator token. */
export function assertCoordinatorToken(state: Item, token: string): void {
  if (typeof state.coordinator_token_hash !== 'string')
    throw new Error('COORDINATOR_AUTH_BOOTSTRAP_REQUIRED')
  if (createHash('sha256').update(token).digest('hex') !== state.coordinator_token_hash)
    throw new Error('COORDINATOR_AUTH_INVALID')
}

/**
 * Standard Coordinator mutation prologue, in the fixed order every writer shares:
 * load → mutable-phase guard → expected state/revision → credential. Callers keep their own
 * role and input validation before it, and `if (!token)` for type narrowing.
 */
export function openCoordinatorCommand(
  sdd: string,
  token: string,
  expectedState: string,
  expectedRevision: string,
  options: Readonly<{ mutable?: boolean }> = {}
): ControlSnapshot {
  const control = loadControl(sdd)
  if (options.mutable !== false) assertMutablePhase(control.state.phase)
  assertExpected(control.state, expectedState, expectedRevision)
  assertCoordinatorToken(control.state, token)
  return control
}

/** HMAC transaction security bound to the Coordinator credential. */
export function coordinatorSecurity(token: string) {
  const sign = (bytes: Uint8Array) => createHmac('sha256', token).update(bytes).digest('hex')
  return { sign, verify: (bytes: Uint8Array, proof: string) => sign(bytes) === proof }
}

/**
 * Serialize one Coordinator event line. `proof` adds an epoch-verifiable coordinator_proof;
 * by default that requires the credential to match the epoch's registered public key.
 */
export function signCoordinatorEvent(
  state: Item,
  body: Item,
  token: string,
  options: Readonly<{ proof?: boolean; requireKeyBinding?: boolean }> = {}
): string {
  let value = body
  if (options.proof) {
    if (
      options.requireKeyBinding !== false &&
      (state.coordinator_event_keys as Item | undefined)?.[String(state.authority_epoch)] !==
        rolePublicKey(token)
    )
      throw Error('COORDINATOR_EVENT_KEY_BINDING_INVALID')
    value = { ...body, coordinator_proof: coordinatorProof(body, token) }
  }
  return `${JSON.stringify({
    ...value,
    signature: createHmac('sha256', token).update(JSON.stringify(value)).digest('hex')
  })}\n`
}

/** Append event lines and replace state atomically against the snapshot the command read. */
export function commitControl(
  control: ControlSnapshot,
  nextState: Item,
  appendedEvents: string,
  token: string
): void {
  commitSidecar(
    control.paths,
    Buffer.from(JSON.stringify(nextState)),
    Buffer.from(appendedEvents),
    coordinatorSecurity(token),
    { state: control.stateBytes }
  )
}

/**
 * Authentication for recovery commands that must run while a journal or lock blocks the normal
 * kernel path. A pending first bootstrap authenticates by its journal; `uninitializedLock`
 * additionally admits the lock left by a first authorization that never wrote a journal.
 */
export function authenticateRecovery(
  paths: ReturnType<typeof sidecarPaths>,
  token: string,
  options: Readonly<{
    allowUninitializedLock?: boolean
    /** Checks that must reject before authentication, preserving each command's error order. */
    beforeAuthentication?: (state: Item) => void
  }> = {}
): Readonly<{ state: Item; stateBytes: Buffer; pendingBootstrap: boolean }> {
  if (!existsSync(paths.state)) throw new Error('LOOP_NOT_INITIALIZED')
  const stateBytes = readFileSync(paths.state)
  const state = decodeState(JSON.parse(stateBytes.toString('utf8'))) as Item
  options.beforeAuthentication?.(state)
  const unauthenticated = !Object.hasOwn(state, 'coordinator_token_hash')
  const pendingBootstrap =
    unauthenticated &&
    existsSync(paths.journal) &&
    verifyPendingBootstrap(stateBytes, readFileSync(paths.journal), token)
  const uninitializedLock =
    options.allowUninitializedLock === true &&
    unauthenticated &&
    !existsSync(paths.journal) &&
    state.phase === 'DISCOVER' &&
    state.active_lease == null &&
    state.preparation == null &&
    !Object.hasOwn(state, 'coordinator_event_keys')
  if (typeof state.coordinator_token_hash !== 'string' && !pendingBootstrap && !uninitializedLock)
    throw new Error('COORDINATOR_AUTH_BOOTSTRAP_REQUIRED')
  if (
    !pendingBootstrap &&
    !uninitializedLock &&
    createHash('sha256').update(token).digest('hex') !== state.coordinator_token_hash
  )
    throw new Error('COORDINATOR_AUTH_INVALID')
  return { state, stateBytes, pendingBootstrap }
}

/**
 * Preconditions for starting work that the later commit would re-check: no journal awaiting
 * recovery, committed event history intact, and the normative sources unchanged. Checking them
 * before execution means a command never runs only to have its result refused for these reasons.
 */
export function assertExecutableControl(sdd: string, control: ControlSnapshot): void {
  if (existsSync(control.paths.journal)) throw new Error('CONTROL_TRANSACTION_PENDING')
  readCommittedEvents(control.paths.events, control.state, 'window')
  assertCurrentSource(control.state, sdd)
}
