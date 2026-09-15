import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { coordinatorHistory } from '../domain/policies/coordinator-history'
import { rolePublicKey } from '../resource/role-signature'
import { decodeState, sidecarPaths } from '../resource/state'
import { commitSidecar } from '../resource/store/sidecar-transaction'

type Item = Record<string, unknown>

/** Environment variable holding the successor Coordinator credential during a rotation. */
export const NEW_COORDINATOR_TOKEN_ENV = 'SDD_LOOP_NEW_COORDINATOR_TOKEN'

/**
 * Raw state and events for an authority change. The command kernel authenticates with the
 * current credential; bootstrap has none yet and rotations replace it, so they read directly.
 */
export type AuthoritySnapshot = Readonly<{
  paths: ReturnType<typeof sidecarPaths>
  stateBytes: Buffer
  readonly eventBytes: Buffer
  state: Item
}>

export function readAuthoritySnapshot(sdd: string): AuthoritySnapshot {
  const paths = sidecarPaths(sdd)
  if (!existsSync(paths.state)) throw new Error('LOOP_NOT_INITIALIZED')
  const stateBytes = readFileSync(paths.state)
  const state = decodeState(JSON.parse(stateBytes.toString('utf8'))) as Item
  let events: Buffer | undefined
  return {
    paths,
    stateBytes,
    // Raw bytes: recovery commands inspect a log that may legitimately run ahead of this state.
    get eventBytes() {
      return (events ??= existsSync(paths.events) ? readFileSync(paths.events) : Buffer.alloc(0))
    },
    state
  }
}

/** Both credentials exist and differ; `sameCode` names the command-specific rejection. */
export function capabilityPair(
  oldToken: string | undefined,
  newToken: string | undefined,
  sameCode: string
): Readonly<{ oldToken: string; newToken: string; oldHash: string; newHash: string }> {
  if (!oldToken || !newToken) throw new Error('COORDINATOR_CAPABILITY_REQUIRED')
  const oldHash = createHash('sha256').update(oldToken).digest('hex')
  const newHash = createHash('sha256').update(newToken).digest('hex')
  if (timingSafeEqual(Buffer.from(oldHash), Buffer.from(newHash))) throw new Error(sameCode)
  return { oldToken, newToken, oldHash, newHash }
}

/** Epoch and revision counters must be safe to increment before authority changes. */
export function assertRotationCounters(state: Item): void {
  if (
    !Number.isSafeInteger(state.authority_epoch) ||
    Number(state.authority_epoch) < 1 ||
    Number(state.authority_epoch) >= Number.MAX_SAFE_INTEGER
  )
    throw new Error('COORDINATOR_EPOCH_INVALID')
  if (
    !Number.isSafeInteger(state.revision) ||
    Number(state.revision) < 1 ||
    Number(state.revision) >= Number.MAX_SAFE_INTEGER
  )
    throw new Error('CONTROL_REVISION_INVALID')
}

/**
 * State after installing `token` at the next epoch. A first bootstrap starts the key and identity
 * history; a rotation keeps earlier verification keys and historical Coordinator exclusions.
 */
export function rotatedAuthorityState(
  state: Item,
  token: string,
  options: Readonly<{
    initial: boolean
    runtime?: Readonly<Record<string, string>>
    capabilityFile?: string
    extra?: Item
  }>
): Item {
  const epoch = Number(state.authority_epoch) + 1
  const key = { [String(epoch)]: rolePublicKey(token) }
  const agentId = options.runtime?.agent_id
  return {
    ...state,
    coordinator_token_hash: createHash('sha256').update(token).digest('hex'),
    coordinator_event_keys: options.initial
      ? key
      : { ...(state.coordinator_event_keys as Record<string, string> | undefined), ...key },
    ...(options.initial
      ? {
          // Private locator only; public status never projects it.
          ...(options.capabilityFile
            ? { coordinator_capability_file: options.capabilityFile }
            : {}),
          ...(options.runtime && agentId
            ? {
                coordinator_agent_id: agentId,
                coordinator_agent_ids: [agentId],
                coordinator_runtime: options.runtime
              }
            : {})
        }
      : {
          coordinator_agent_id: agentId,
          coordinator_runtime: options.runtime,
          coordinator_capability_file: options.capabilityFile ?? null,
          coordinator_agent_ids: coordinatorHistory(state, String(agentId))
        }),
    authority_epoch: epoch,
    ...options.extra,
    revision: Number(state.revision) + 1
  }
}

/** HMAC journal security for the first authority, which has no earlier public key. */
export function tokenTransactionSecurity(token: string) {
  const sign = (bytes: Uint8Array) => createHmac('sha256', token).update(bytes).digest('hex')
  return { sign, verify: (bytes: Uint8Array, proof: string) => sign(bytes) === proof }
}

/** Sign the authority event with the credential it installs and commit state and log together. */
export function commitAuthorityChange(
  snapshot: AuthoritySnapshot,
  nextState: Item,
  body: Item,
  signingToken: string,
  security: Parameters<typeof commitSidecar>[3],
  allowEventTailAhead = false
): void {
  const signature = createHmac('sha256', signingToken).update(JSON.stringify(body)).digest('hex')
  commitSidecar(
    snapshot.paths,
    Buffer.from(JSON.stringify(nextState)),
    Buffer.from(`${JSON.stringify({ ...body, signature })}\n`),
    security,
    {
      state: snapshot.stateBytes,
      ...(allowEventTailAhead ? { allowEventTailAhead: true } : {})
    }
  )
}
