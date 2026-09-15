import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  processDirectory,
  reclaimProcesses,
  runFiles,
  runInProcessGroup,
  runnerArgv,
  writeRunSpec,
  type RunSpec
} from '../scripts/resource/process-group'

const owner = {
  agent: 'architect',
  agent_id: 'architect-7',
  lease_id: 'lease-1',
  prepared_id: null
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = async (condition: () => boolean) => {
  for (let tries = 0; tries < 200 && !condition(); tries++) await Bun.sleep(25)
  expect(condition()).toBe(true)
}

test('a timeout kills the whole process group, including background grandchildren', () => {
  const root = mkdtempSync(join(tmpdir(), 'process-group-'))
  const pidFile = join(root, 'grandchild.pid')
  try {
    const run = runInProcessGroup({
      sdd: join(root, 'task.sdd.md'),
      argv: ['sh', '-c', `sleep 60 & echo $! > ${pidFile}; wait`],
      cwd: root,
      env: process.env,
      timeoutSeconds: 1,
      owner,
      tailBytes: 100
    })
    expect(run).toMatchObject({ timed_out: true, reclaimed: false, error: null })
    expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false)
    // Nothing of the run is left for a later reclaim to find.
    expect(existsSync(join(processDirectory(join(root, 'task.sdd.md'))))).toBe(true)
    expect(reclaimProcesses(join(root, 'task.sdd.md'), owner.agent_id)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('large output is digested from a file and never turns a passing command into NOT_RUN', () => {
  const root = mkdtempSync(join(tmpdir(), 'process-output-'))
  try {
    const bytes = 40 * 1024 * 1024
    const run = runInProcessGroup({
      sdd: join(root, 'task.sdd.md'),
      argv: [process.execPath, '-e', `process.stdout.write('x'.repeat(${bytes - 3}) + 'end')`],
      cwd: root,
      env: process.env,
      timeoutSeconds: 30,
      owner,
      tailBytes: 10
    })
    expect(run).toMatchObject({ exit_code: 0, error: null, timed_out: false, output_bytes: bytes })
    expect(run.output_tail).toBe('xxxxxxxend')
    const missing = runInProcessGroup({
      sdd: join(root, 'task.sdd.md'),
      argv: [join(root, 'no-such-command')],
      cwd: root,
      env: process.env,
      timeoutSeconds: 5,
      owner,
      tailBytes: 10
    })
    expect(missing.error).toBe('ENOENT')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reclaiming by agent name kills only that agent group and marks the run reclaimed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'process-reclaim-'))
  const sdd = join(root, 'task.sdd.md')
  const start = (agentId: string, pidFile: string) => {
    const spec: RunSpec = {
      argv: ['sh', '-c', `sleep 60 & echo $! > ${pidFile}; wait`],
      cwd: root,
      timeout_ms: 60_000,
      owner: { ...owner, agent_id: agentId },
      files: runFiles(sdd)
    }
    writeRunSpec(spec)
    return { spec, runner: Bun.spawn(runnerArgv(spec)) }
  }
  const mine = start('architect-7', join(root, 'mine.pid'))
  const other = start('operator-1', join(root, 'other.pid'))
  try {
    await waitFor(
      () =>
        existsSync(mine.spec.files.record) &&
        existsSync(other.spec.files.record) &&
        existsSync(join(root, 'mine.pid')) &&
        existsSync(join(root, 'other.pid'))
    )
    const runs = reclaimProcesses(sdd, 'architect-7')
    expect(runs.map((run) => [run.agent_id, run.status])).toEqual([['architect-7', 'KILLED']])
    await mine.runner.exited
    expect(JSON.parse(readFileSync(mine.spec.files.result, 'utf8'))).toMatchObject({
      reclaimed: true,
      timed_out: false
    })
    expect(alive(Number(readFileSync(join(root, 'mine.pid'), 'utf8')))).toBe(false)
    expect(alive(Number(readFileSync(join(root, 'other.pid'), 'utf8')))).toBe(true)
    // A record whose runner is gone is stale and removed without killing an unrelated group.
    other.runner.kill('SIGKILL')
    await other.runner.exited
    writeFileSync(
      other.spec.files.record,
      JSON.stringify({
        ...JSON.parse(readFileSync(other.spec.files.record, 'utf8')),
        argv: ['not-running-here']
      })
    )
    expect(reclaimProcesses(sdd, 'operator-1').map((run) => run.status)).toEqual([
      'STALE_RECORD_REMOVED'
    ])
    expect(existsSync(other.spec.files.record)).toBe(false)
  } finally {
    for (const file of ['mine.pid', 'other.pid'])
      if (existsSync(join(root, file)))
        try {
          process.kill(Number(readFileSync(join(root, file), 'utf8')), 'SIGKILL')
        } catch {}
    rmSync(root, { recursive: true, force: true })
    rmSync(processDirectory(sdd), { recursive: true, force: true })
  }
})
