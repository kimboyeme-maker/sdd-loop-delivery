import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sidecarPaths } from './state'

/** Who a run belongs to, so a person can reclaim one agent's processes by name. */
export type RunOwner = Readonly<{
  agent: string
  agent_id: string
  lease_id: string | null
  prepared_id: string | null
}>
type RunFiles = Readonly<{ spec: string; record: string; output: string; result: string }>
export type RunSpec = Readonly<{
  argv: readonly string[]
  cwd: string
  timeout_ms: number
  owner: RunOwner
  files: RunFiles
}>
/** A live process group, present only while its runner supervises it. */
export type RunRecord = RunOwner &
  Readonly<{
    pgid: number
    runner_pid: number
    argv: readonly string[]
    cwd: string
    started_at: string
    reclaimed_at?: string
  }>
export type RunResult = Readonly<{
  exit_code: number | null
  signal: string | null
  /** Spawn failure code such as ENOENT; the command never ran. */
  error: string | null
  timed_out: boolean
  reclaimed: boolean
  duration_ms: number
}>
export type ProcessRun = RunResult &
  Readonly<{ output_sha256: string; output_bytes: number; output_tail: string }>

const RUNNER = fileURLToPath(new URL('./process-runner.ts', import.meta.url))
/** Extra time the launcher waits for the runner itself before killing the group directly. */
const RUNNER_GRACE_MS = 15_000
const RECORD = /^[0-9a-f-]{36}\.json$/

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const killGroup = (pgid: number): void => {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // ESRCH: the group has already gone.
  }
}
const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Per-SDD directory holding run records, outside every worktree. */
export function processDirectory(sdd: string): string {
  return sidecarPaths(sdd).processes
}

export function runFiles(sdd: string, runId: string = randomUUID()): RunFiles {
  const directory = processDirectory(sdd)
  return {
    spec: join(directory, `${runId}.spec`),
    record: join(directory, `${runId}.json`),
    output: join(directory, `${runId}.out`),
    result: join(directory, `${runId}.result`)
  }
}

export function writeRunSpec(spec: RunSpec): void {
  mkdirSync(join(spec.files.spec, '..'), { recursive: true })
  writeFileSync(spec.files.spec, JSON.stringify(spec))
}

export function runnerArgv(spec: RunSpec): string[] {
  return [process.execPath, RUNNER, spec.files.spec]
}

/** Hash, size and tail of the combined output, read in chunks so any size is handled. */
function digestOutput(path: string, tailBytes: number) {
  const hash = createHash('sha256')
  if (!existsSync(path))
    return { output_sha256: hash.digest('hex'), output_bytes: 0, output_tail: '' }
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const chunk = Buffer.alloc(1024 * 1024)
    for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0;)
      hash.update(chunk.subarray(0, read))
    const tail = Buffer.alloc(Math.min(tailBytes, size))
    readSync(fd, tail, 0, tail.length, size - tail.length)
    return {
      output_sha256: hash.digest('hex'),
      output_bytes: size,
      output_tail: tail.toString('utf8')
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Run a command in its own process group and wait for it. Timeout or reclamation kills the whole
 * group; if the runner itself does not report in time the launcher kills the recorded group.
 */
export function runInProcessGroup(
  input: Readonly<{
    sdd: string
    argv: readonly string[]
    cwd: string
    env: NodeJS.ProcessEnv
    timeoutSeconds: number
    owner: RunOwner
    tailBytes: number
  }>
): ProcessRun {
  const spec: RunSpec = {
    argv: input.argv,
    cwd: input.cwd,
    timeout_ms: input.timeoutSeconds * 1000,
    owner: input.owner,
    files: runFiles(input.sdd)
  }
  writeRunSpec(spec)
  try {
    const started = performance.now()
    const [command, ...args] = runnerArgv(spec)
    spawnSync(command!, args, {
      env: input.env,
      stdio: 'ignore',
      timeout: spec.timeout_ms + RUNNER_GRACE_MS,
      killSignal: 'SIGKILL'
    })
    let result = readJson<RunResult>(spec.files.result)
    if (!result) {
      const record = readJson<RunRecord>(spec.files.record)
      if (record) killGroup(record.pgid)
      result = {
        exit_code: null,
        signal: 'SIGKILL',
        error: record ? null : 'RUNNER_FAILED',
        timed_out: !!record,
        reclaimed: !!record?.reclaimed_at,
        duration_ms: Math.round(performance.now() - started)
      }
    }
    return { ...result, ...digestOutput(spec.files.output, input.tailBytes) }
  } finally {
    for (const file of Object.values(spec.files)) rmSync(file, { force: true })
  }
}

export type ReclaimedRun = Readonly<{
  pgid: number
  agent_id: string
  lease_id: string | null
  prepared_id: string | null
  argv: readonly string[]
  started_at: string
  status: 'KILLED' | 'STALE_RECORD_REMOVED'
}>

/**
 * Kill every process group started by `test-run` for this agent. A live runner reports the run as
 * reclaimed (INCONCLUSIVE). A record whose runner is gone is stale: its group is killed only while a
 * member still runs the recorded executable, so a reused process group id is never touched.
 */
export function reclaimProcesses(sdd: string, agentId: string): ReclaimedRun[] {
  const directory = processDirectory(sdd)
  if (!existsSync(directory)) return []
  const reclaimed: ReclaimedRun[] = []
  for (const name of readdirSync(directory)
    .filter((entry) => RECORD.test(entry))
    .sort()) {
    const path = join(directory, name)
    const record = readJson<RunRecord>(path)
    if (!record || record.agent_id !== agentId) continue
    const summary = {
      pgid: record.pgid,
      agent_id: record.agent_id,
      lease_id: record.lease_id,
      prepared_id: record.prepared_id,
      argv: record.argv,
      started_at: record.started_at
    }
    if (alive(record.runner_pid)) {
      writeFileSync(path, JSON.stringify({ ...record, reclaimed_at: new Date().toISOString() }))
      killGroup(record.pgid)
      reclaimed.push({ ...summary, status: 'KILLED' })
      continue
    }
    if (groupRuns(record.pgid, basename(record.argv[0] ?? ''))) killGroup(record.pgid)
    rmSync(path, { force: true })
    reclaimed.push({ ...summary, status: 'STALE_RECORD_REMOVED' })
  }
  return reclaimed
}

/** True when some member of the process group still runs the named executable. */
function groupRuns(pgid: number, executable: string): boolean {
  const listed = spawnSync('ps', ['-A', '-o', 'pgid=,comm='], { encoding: 'utf8' })
  return (listed.stdout ?? '').split('\n').some((line) => {
    const [group, ...command] = line.trim().split(/\s+/)
    return Number(group) === pgid && basename(command.join(' ')) === executable
  })
}
