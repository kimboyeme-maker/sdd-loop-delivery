import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { sidecarPaths } from '../resource/state'
import { assertLockOwnerNotRunning } from '../resource/store/control-lock'
import { COORDINATOR_TOKEN_ENV, authenticateRecovery } from '../services/control-kernel'

/**
 * Remove an authenticated orphan lock after the caller confirms its owner stopped.
 * Preserve a pending journal: recovery needs this lock and will authenticate the
 * journal before finishing its after-image. Rejecting journals here deadlocks recovery.
 */
export function lockRecover(
  sdd: string,
  expectedLockHash: string,
  ownerStopped: string,
  userAuthorized: string,
  token = process.env[COORDINATOR_TOKEN_ENV]
): Readonly<{ protocol: 'lock-recover/v1'; status: 'removed' | 'nothing-present' }> {
  if (ownerStopped !== 'yes') throw new Error('OWNER_STOP_CONFIRMATION_REQUIRED')
  if (userAuthorized !== 'yes') throw new Error('USER_AUTHORIZATION_REQUIRED')
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  const paths = sidecarPaths(sdd)
  // First authorization can stop after acquiring the lock but before creating its journal; no
  // credential exists then, so user authorization, owner stop and the exact lock hash apply.
  authenticateRecovery(paths, token, { allowUninitializedLock: true })
  if (!existsSync(paths.lock)) return { protocol: 'lock-recover/v1', status: 'nothing-present' }
  const lockBytes = readFileSync(paths.lock)
  const lockHash = createHash('sha256').update(lockBytes).digest('hex')
  if (!/^[0-9a-f]{64}$/.test(expectedLockHash) || lockHash !== expectedLockHash)
    throw new Error('LOCK_HASH_MISMATCH')
  // The confirmation is still required; an observably running owner overrides it.
  assertLockOwnerNotRunning(lockBytes)
  unlinkSync(paths.lock)
  return { protocol: 'lock-recover/v1', status: 'removed' }
}
