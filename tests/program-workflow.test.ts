import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProgram } from '../scripts/services/program-contract'
import { readProgramRun } from '../scripts/resource/program-store'
import {
  programNext,
  programRecord,
  programStart,
  workflowStatus
} from '../scripts/services/program-workflow'
import { admissionFixture } from './fixtures/admission'
import { createNativeChain } from './fixtures/native-chain'
import { leafContract, programFixture } from './fixtures/program'

/** Command results are asserted structurally; their precise shapes belong to the services. */
// eslint-disable-next-line typescript/no-explicit-any
type Result = Record<string, any>

/** Run with the given variables set (undefined removes one), restoring them afterwards. */
function withEnv<T>(env: Record<string, string | undefined>, action: () => T): T {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
  }
  apply(env)
  try {
    return action()
  } finally {
    apply(previous)
  }
}

/** A fresh program repository; the callback receives the root SDD and a scratch directory. */
function withProgram(action: (path: string, scratch: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'program-flow-')))
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'program-flow-wt-')))
  try {
    action(programFixture(root), scratch)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}

const limits = {
  authorization_ref: 'user message: start',
  max_parallel: 2,
  total_test_seconds: 200
}

test('a scheduled workflow waits for its wake, dispatches through task_create and binds a real task', () =>
  withProgram((path, scratch) =>
    withEnv({ SDD_LOOP_HOST: 'codex', SDD_LOOP_HOST_PROFILE_FILE: undefined }, () => {
      const start = programStart(path, { ...limits, scheduler_task_id: 'sched' }) as Result
      expect(start).toMatchObject({
        status: 'WAITING_HOST',
        wake_mode: 'scheduled',
        host_profile: 'codex'
      })
      withEnv({ SDD_PROGRAM_TOKEN_FILE: start.token_file }, () => {
        const auth = (revision: number) => ({
          scheduler_task_id: 'sched',
          expected_revision: revision
        })
        expect((programNext(path, auth(1)) as Result).action).toBe('WAIT')
        programRecord(path, {
          ...auth(1),
          action: 'wake',
          wake_id: 'auto-1',
          host_receipt: 'automation_update'
        })
        const create = programNext(path, auth(2)) as Result
        expect(create).toMatchObject({
          action: 'CREATE_TASK',
          bundle_id: 'BA',
          host_call: { operation: 'task_create', call: 'create_thread' }
        })
        // The consumer waits for the producer's released commit.
        expect(create.ready).toEqual([])
        const worktree = join(scratch, 'a')
        Bun.spawnSync([
          'git',
          '-C',
          realpathSync(join(path, '../..')),
          'worktree',
          'add',
          '-q',
          worktree,
          'HEAD'
        ])
        const bind = {
          ...auth(3),
          action: 'bind',
          bundle_id: 'BA',
          intent_id: create.intent_id,
          task_id: 'thr-1',
          worktree,
          sdd: join(worktree, 'docs/a.sdd.md'),
          host_receipt: 'create_thread result'
        }
        // Identifiers from one host mean nothing to another.
        expect(() =>
          withEnv({ SDD_LOOP_HOST: 'claude-code' }, () => programRecord(path, bind))
        ).toThrow('PROGRAM_HOST_MISMATCH')
        programRecord(path, bind)
        const status = workflowStatus(path) as Result
        expect(status.tasks).toMatchObject([
          { bundle_id: 'BA', task_id: 'thr-1', creation_state: 'BOUND' }
        ])
        expect(status.children[0]).toMatchObject({ bundle_id: 'BA', phase: 'BOOTSTRAP_PENDING' })
        expect(() => programRecord(path, { ...bind, ...auth(4), task_id: 'thr-2' })).toThrow(
          'PROGRAM_TASK_ALREADY_BOUND'
        )
      })
    })
  ))

test('a host without task creation runs attended and hands creation to the user', () => {
  withProgram((path) =>
    withEnv({ SDD_LOOP_HOST: 'claude-code', SDD_LOOP_HOST_PROFILE_FILE: undefined }, () => {
      const start = programStart(path, {
        ...limits,
        scheduler_task_id: 's',
        wake_mode: 'attended'
      }) as Result
      withEnv({ SDD_PROGRAM_TOKEN_FILE: start.token_file }, () => {
        const create = programNext(path, { scheduler_task_id: 's', expected_revision: 1 }) as Result
        expect(create.host_call).toMatchObject({ available: false, fallback: 'USER_CREATES_TASK' })
        expect(() =>
          programRecord(path, {
            scheduler_task_id: 's',
            expected_revision: 2,
            action: 'wake',
            wake_id: 'w',
            host_receipt: 'r'
          })
        ).toThrow('PROGRAM_WAKE_MODE_INVALID')
      })
    })
  )
  withProgram((path) =>
    withEnv({ SDD_LOOP_HOST: 'generic', SDD_LOOP_HOST_PROFILE_FILE: undefined }, () => {
      expect(() =>
        programStart(path, { ...limits, scheduler_task_id: 's', wake_mode: 'scheduled' })
      ).toThrow('PROGRAM_HOST_OPERATION_UNAVAILABLE')
      expect(programStart(path, { ...limits, scheduler_task_id: 's' })).toMatchObject({
        wake_mode: 'attended'
      })
    })
  )
})

test('a shipped child hands off, releases its commit and unblocks its consumer', () =>
  withProgram((path, scratch) =>
    withEnv({ SDD_LOOP_HOST: 'codex', SDD_LOOP_HOST_PROFILE_FILE: undefined }, () => {
      const start = programStart(path, { ...limits, scheduler_task_id: 's' }) as Result
      withEnv({ SDD_PROGRAM_TOKEN_FILE: start.token_file }, () => {
        // Test reservations also advance the revision, so every mutation re-reads it.
        const record = (payload: Result) =>
          programRecord(path, {
            scheduler_task_id: 's',
            expected_revision: (workflowStatus(path) as Result).revision,
            ...payload
          }) as Result
        record({ action: 'wake', wake_id: 'w', host_receipt: 'automation_update' })
        const create = programNext(path, { scheduler_task_id: 's', expected_revision: 2 }) as Result
        const worktree = join(scratch, 'a')
        const repo = realpathSync(join(path, '../..'))
        Bun.spawnSync(['git', '-C', repo, 'worktree', 'add', '-q', worktree, 'HEAD'])
        const sdd = join(worktree, 'docs/a.sdd.md')
        const common = { bundle_id: 'BA', intent_id: create.intent_id, task_id: 't-a' }
        record({ ...common, action: 'bind', worktree, sdd, host_receipt: 'create_thread' })

        const chain = createNativeChain(join(scratch, 'chain'), {
          sdd,
          workspace: worktree,
          guided: true,
          contract: leafContract('packages/a'),
          admission: admissionFixture('packages/a').payload
        })
        try {
          chain.setup()
          chain.toArchitectVerify()
          chain.verify()
          chain.advance('COORDINATOR_TRIAGE', 'FINAL_CANDIDATE', 'FINAL_VERIFY')
          chain.markVerified(chain.verify())
          chain.advance('SHIP')
        } finally {
          chain.restore()
        }
        // Commit authority is separate: freeze the verified candidate first, then commit it.
        expect(() =>
          record({ action: 'release', bundle_id: 'BA', commit: 'f'.repeat(40) })
        ).toThrow('PROGRAM_HANDOFF_REQUIRED')
        const handoff = record({ action: 'handoff', bundle_id: 'BA' })
        expect(handoff.children[0].phase).toBe('SHIP')
        const git = (...args: string[]) =>
          Bun.spawnSync([
            'git',
            '-C',
            worktree,
            '-c',
            'user.name=f',
            '-c',
            'user.email=f@x',
            ...args
          ])
            .stdout.toString()
            .trim()
        git('add', 'packages')
        git('commit', '-qm', 'deliver a')
        const commit = git('rev-parse', 'HEAD')
        record({ action: 'release', bundle_id: 'BA', commit })
        // A released child still occupies its slot until its writers are observed stopped.
        record({
          ...common,
          action: 'stopped',
          writers_stopped: true,
          commands_stopped: true,
          host_receipt: 'thread idle, no running commands'
        })
        const status = workflowStatus(path) as Result
        expect(status.children[0]).toMatchObject({ bundle_id: 'BA', phase: 'SHIP', commit })
        expect(status.ready).toEqual(['BB'])
        const next = programNext(path, {
          scheduler_task_id: 's',
          expected_revision: status.revision
        }) as Result
        expect(next).toMatchObject({
          bundle_id: 'BB',
          required_commits: [commit],
          base_commit: commit
        })
      })
    })
  ))

test('start rejects an invalid child and check rejects an estimate that cannot hold the batch plan', () =>
  withProgram((path) => {
    const child = join(path, '../a.sdd.md')
    const original = readFileSync(child, 'utf8')
    writeFileSync(child, original.replace('## Breaking Changes', '## Notes'))
    expect(() => programStart(path, { ...limits, scheduler_task_id: 's' })).toThrow(
      'PROGRAM_CHILD_INVALID'
    )
    writeFileSync(child, original)
    const root = readFileSync(path, 'utf8')
    writeFileSync(
      path,
      root.replace(
        '"implementation":[30,45],"integration":[0,0],"verification":[30,45]',
        '"implementation":[1,2],"integration":[0,0],"verification":[1,2]'
      )
    )
    expect(() => readProgram(path)).toThrow('PROGRAM_ESTIMATE_DIVERGED')
  }))

test('status on a program that was never started names the missing run, not a read error', () => {
  const missing = join(tmpdir(), `program-never-started-${Date.now()}.workflow.json`)
  expect(() => readProgramRun(missing)).toThrow('PROGRAM_RUN_NOT_STARTED: run program-start')
})
