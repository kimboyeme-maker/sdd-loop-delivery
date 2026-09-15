import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rolePublicKey } from './role-signature'

type Item = Record<string, unknown>
/** Locator of the private capability file handed to exactly one dispatched role runtime. */
export const AGENT_TOKEN_FILE_ENV = 'SDD_LOOP_AGENT_TOKEN_FILE'
/** Optional directory for controller-minted capabilities; defaults outside any repository. */
export const CAPABILITY_DIR_ENV = 'SDD_LOOP_CAPABILITY_DIR'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Mint a grant-duration Operator/Architect credential inside the controller. The
 * Coordinator only receives the file locator, so it never chooses or holds the token
 * through arguments or environment. The file needs no deletion on revocation: every
 * role command additionally requires the matching active grant.
 */
export function mintRoleCapability(
  grantId: string,
  env: NodeJS.ProcessEnv = process.env
): Readonly<{ path: string; hash: string; publicKey: string }> {
  const directory = resolve(env[CAPABILITY_DIR_ENV] ?? join(tmpdir(), 'sdd-loop-capabilities'))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString('base64url')
  const path = join(directory, `${grantId}.token`)
  writeFileSync(path, token, { mode: 0o600, flag: 'wx' })
  return { path, hash: sha256(token), publicKey: rolePublicKey(token) }
}

/** Locator of the Coordinator's persistent private credential file. */
export const COORDINATOR_TOKEN_FILE_ENV = 'SDD_LOOP_COORDINATOR_TOKEN_FILE'

/**
 * Read a credential file that must be a regular owner-only file. Callers still compare the
 * token with the committed hash; this only refuses symlinks, empty files and loose modes.
 */
export function readCapabilityFile(path: string): string {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) throw new Error('COORDINATOR_TOKEN_FILE_MISSING')
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error('COORDINATOR_TOKEN_FILE_INSECURE')
  const token = readFileSync(path, 'utf8').trim()
  if (!token) throw new Error('COORDINATOR_TOKEN_FILE_EMPTY')
  return token
}

/** Read the dispatched runtime's credential from its private file and bind it to the grant. */
export function roleCapabilityToken(grant: Item, env: NodeJS.ProcessEnv = process.env): string {
  const path = env[AGENT_TOKEN_FILE_ENV]
  if (!path || typeof grant.capability_file !== 'string' || resolve(path) !== grant.capability_file)
    throw new Error(`ROLE_CAPABILITY_FILE_REQUIRED: set ${AGENT_TOKEN_FILE_ENV} to the grant file`)
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info || info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error('ROLE_CAPABILITY_FILE_INSECURE')
  const token = readFileSync(path, 'utf8').trim()
  if (
    !token ||
    sha256(token) !== grant.agent_token_hash ||
    rolePublicKey(token) !== grant.event_public_key
  )
    throw new Error('ROLE_CAPABILITY_INVALID')
  return token
}
