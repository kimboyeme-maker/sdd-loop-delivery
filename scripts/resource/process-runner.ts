import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { RunRecord, RunResult, RunSpec } from './process-group'

/**
 * Supervises one test command in its own process group. It records the group before waiting, kills
 * the whole group on timeout, and after the leader exits kills whatever the command left behind.
 * Output goes to a file, so its size never affects how the run is judged.
 */
const specFile = process.argv[2]!
const spec = JSON.parse(readFileSync(specFile, 'utf8')) as RunSpec
const started = Date.now()
const output = openSync(spec.files.output, 'a')
let timedOut = false
let finished = false

const killGroup = (pgid: number) => {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // ESRCH: the group has already gone.
  }
}
const finish = (result: Omit<RunResult, 'duration_ms' | 'timed_out' | 'reclaimed'>) => {
  if (finished) return
  finished = true
  closeSync(output)
  let reclaimed = false
  try {
    reclaimed = !!(JSON.parse(readFileSync(spec.files.record, 'utf8')) as RunRecord).reclaimed_at
  } catch {
    // No record: the command never started.
  }
  const value: RunResult = {
    ...result,
    timed_out: timedOut,
    reclaimed,
    duration_ms: Date.now() - started
  }
  writeFileSync(spec.files.result + '.tmp', JSON.stringify(value))
  renameSync(spec.files.result + '.tmp', spec.files.result)
  rmSync(spec.files.record, { force: true })
  process.exit(0)
}

const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
  cwd: spec.cwd,
  detached: true,
  stdio: ['ignore', output, output]
})
child.on('error', (error: NodeJS.ErrnoException) =>
  finish({ exit_code: null, signal: null, error: error.code ?? 'SPAWN_FAILED' })
)
if (child.pid !== undefined) {
  const pgid = child.pid
  const record: RunRecord = {
    ...spec.owner,
    pgid,
    runner_pid: process.pid,
    argv: spec.argv,
    cwd: spec.cwd,
    started_at: new Date(started).toISOString()
  }
  writeFileSync(spec.files.record, JSON.stringify(record))
  const timer = setTimeout(() => {
    timedOut = true
    killGroup(pgid)
  }, spec.timeout_ms)
  child.on('exit', (code, signal) => {
    clearTimeout(timer)
    // Background processes the command started would outlive the measurement; reclaim them too.
    killGroup(pgid)
    finish({ exit_code: code, signal, error: null })
  })
}
