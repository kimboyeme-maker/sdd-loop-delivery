import { randomUUID } from 'node:crypto'
import { fsyncSync, openSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'

/**
 * Create the exclusive controller lock and record its owner inside it.
 * The random nonce makes every lock instance's SHA-256 unique, so `recover --kind lock
 * --expected-lock-hash` names one exact orphan instead of any lock ever taken.
 */
export function acquireControlLock(path: string): number {
  const fd = openSync(path, 'wx', 0o600)
  writeSync(
    fd,
    `pid=${process.pid} host=${hostname()} nonce=${randomUUID()} at=${new Date().toISOString()}\n`
  )
  fsyncSync(fd)
  return fd
}

/** Parse the owner line; locks written before owner records existed carry none. */
export function lockOwner(bytes: Uint8Array): Readonly<{ pid: number; host: string }> | undefined {
  const text = Buffer.from(bytes).toString('utf8')
  const pid = /\bpid=(\d+)\b/.exec(text)?.[1]
  const host = /\bhost=(\S+)/.exec(text)?.[1]
  return pid && host && Number.isSafeInteger(Number(pid)) ? { pid: Number(pid), host } : undefined
}

/**
 * Refuse to remove a lock whose owner is observably alive on this host. A dead or foreign-host
 * owner still needs the caller's explicit stop confirmation; absence of a live PID is not proof
 * that no other writer exists (PID reuse, other hosts), so this only narrows, never grants.
 */
export function assertLockOwnerNotRunning(bytes: Uint8Array): void {
  const owner = lockOwner(bytes)
  if (!owner || owner.host !== hostname() || owner.pid === process.pid) return
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    throw new Error('LOCK_OWNER_POSSIBLY_ACTIVE')
  }
  throw new Error('LOCK_OWNER_STILL_ACTIVE')
}
