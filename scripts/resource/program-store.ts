import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { acquireControlLock } from './store/control-lock'

export type ProgramBinding = {
  state_path: string
  bundle_id: string
  sdd: string
  intent_id: string
}
/** A frozen delivery binds acceptance to candidate bytes; commit is recorded separately. */
export type ProgramHandoff = {
  product_hash: string
  event_hash: string
  contract_revision?: string
  candidate_id?: string
  acceptance_events?: Record<string, string>
  assets?: Record<string, { path: string; files: { path: string; mode: string; sha256: string }[] }>
}
export type ProgramSlot = {
  intent_id: string
  task_id: string | null
  worktree: string | null
  sdd: string | null
  base_commit: string
  required_commits: string[]
  allowance: number
  reserved_seconds: number
  host_receipt: string | null
  definition_hash: string
  integration_batch_id?: string
  /** Only explicit failed creation is retryable. */
  creation_state: 'RESERVED' | 'UNKNOWN' | 'FAILED' | 'BOUND'
  previous_attempts?: { intent_id: string; host_receipt: string }[]
  handoff?: ProgramHandoff
  release_commit?: string
  /** Host confirms all assigned writers/commands stopped at this authenticated history. */
  stopped?: { event_hash: string; host_receipt: string }
}
export type ProgramRun = {
  protocol: 'sdd-workflow/v1'
  program: string
  fingerprint: string
  revision: number
  scheduler_task_id: string
  token_hash: string
  authorization_ref: string
  /** Host profile id active at start; mutations under another profile are rejected. */
  host_profile: string
  /** Opaque references the host's `task_create` needs (saved project, remote host); null when unused. */
  project_ref: string | null
  host_ref: string | null
  /** `scheduled`: dispatch waits for a recorded recurring wake. `attended`: advances only while the scheduler is active. */
  wake_mode: 'scheduled' | 'attended'
  wake_id: string | null
  paused: boolean
  base_commit: string
  max_parallel: number
  total_test_seconds: number
  slots: Record<string, ProgramSlot>
}

/** Git queries only; argv never runs through a shell. */
export function programGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`PROGRAM_GIT_QUERY_FAILED: ${args[0]}`)
  return result.stdout.toString().trim()
}

/** Absence of ancestry is an expected false; repository errors must not become missing inputs. */
export function programHasCommit(cwd: string, commit: string, head = 'HEAD'): boolean {
  const result = Bun.spawnSync(['git', '-C', cwd, 'merge-base', '--is-ancestor', commit, head], {
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw new Error('PROGRAM_GIT_QUERY_FAILED: merge-base')
}

/** Durable single-file replace; callers hold the program lock. */
export function writeProgramFile(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  const directory = openSync(dirname(path), 'r')
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

/** All dispatch and test reservations share one lock, independent of the child round. */
export function withProgramLock<T>(path: string, action: () => T): T {
  const lock = `${path}.lock`,
    fd = acquireControlLock(lock)
  try {
    return action()
  } finally {
    closeSync(fd)
    unlinkSync(lock)
  }
}

export function readProgramRun(path: string): ProgramRun {
  const v = JSON.parse(readFileSync(path, 'utf8')) as ProgramRun | null
  if (
    !v ||
    v.protocol !== 'sdd-workflow/v1' ||
    !Number.isSafeInteger(v.revision) ||
    !v.slots ||
    typeof v.slots !== 'object'
  )
    throw new Error('PROGRAM_STATE_INVALID')
  return v
}

/** Bind through Git's common directory so child init cannot silently omit an environment flag. */
function bindingPath(sdd: string): string {
  const common = programGit(dirname(sdd), 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const key = createHash('sha256').update(realpathSync(sdd)).digest('hex')
  return join(common, 'sdd-workflows', `${key}.json`)
}

export function readProgramBinding(sdd: string): ProgramBinding | undefined {
  // Non-Git single-SDD workflows keep their existing behavior.
  let path: string
  try {
    path = bindingPath(sdd)
  } catch {
    return undefined
  }
  if (!existsSync(path)) return undefined
  const binding = JSON.parse(readFileSync(path, 'utf8')) as ProgramBinding
  if (
    binding.sdd !== realpathSync(sdd) ||
    !binding.state_path ||
    !binding.bundle_id ||
    !binding.intent_id
  )
    throw new Error('PROGRAM_BINDING_INVALID')
  return binding
}

export function bindProgramChild(binding: ProgramBinding): void {
  const path = bindingPath(binding.sdd)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path)) {
    if (JSON.stringify(readProgramBinding(binding.sdd)) !== JSON.stringify(binding))
      throw new Error('PROGRAM_CHILD_ALREADY_BOUND')
    return
  }
  writeProgramFile(path, binding)
}

/**
 * Reserve the entire command timeout before launch, for every role and every round. Reservations
 * are never refunded: an interrupted process or lost completion cannot create free retry budget.
 * This is a conservative execution-time ceiling, not a meter of actual spend or user consent.
 */
export function reserveProgramTest(sdd: string, stateBinding: unknown, timeout: number): number {
  const binding = readProgramBinding(sdd)
  if (!binding && stateBinding === undefined) return timeout
  if (!binding || JSON.stringify(binding) !== JSON.stringify(stateBinding))
    throw new Error('PROGRAM_BINDING_MISMATCH')
  return withProgramLock(binding.state_path, () => {
    const run = readProgramRun(binding.state_path),
      slot = run.slots[binding.bundle_id]
    if (!slot || slot.intent_id !== binding.intent_id || slot.sdd !== realpathSync(sdd))
      throw new Error('PROGRAM_BUDGET_BINDING_INVALID')
    const available = slot.allowance - slot.reserved_seconds
    const seconds = Math.min(Math.floor(timeout), available)
    if (seconds < 1) throw new Error('PROGRAM_TEST_BUDGET_EXHAUSTED')
    slot.reserved_seconds += seconds
    run.revision += 1
    writeProgramFile(resolve(binding.state_path), run)
    return seconds
  })
}
