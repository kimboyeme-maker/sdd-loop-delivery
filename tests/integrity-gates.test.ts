import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { roleRuntime } from '../scripts/config/host'
import { runtimeRecord } from '../scripts/controllers/runtime-record.controller'
import {
  assertEventLogBinding,
  bindEventLog,
  eventLogBinding
} from '../scripts/resource/store/event-log-binding'
import { readCapabilityFile } from '../scripts/resource/role-capability'
import { audit, status } from '../scripts/controllers/read-only.controller'
import { dispatch } from '../scripts/controllers/dispatch.controller'
import { findingUpdate } from '../scripts/controllers/finding.controller'
import { assertAuthenticCurrentEpoch } from '../scripts/services/event-authentication'
import { initLoop } from '../scripts/controllers/init.controller'
import { createHmac } from 'node:crypto'
import { hostname } from 'node:os'
import {
  acquireControlLock,
  assertLockOwnerNotRunning,
  lockOwner
} from '../scripts/resource/store/control-lock'
import { assertChallengeResponse } from '../scripts/helpers/design-challenge'
import { admissionFixture } from './fixtures/admission'
import { COORDINATOR, createNativeChain } from './fixtures/native-chain'

type Item = Record<string, unknown>
const lines = (...events: Item[]) =>
  Buffer.from(events.map((e) => `${JSON.stringify(e)}\n`).join(''))

test('committed state binds its event log and only an interrupted tail is recoverable', () => {
  const two = lines({ event_id: 'A' }, { event_id: 'B' })
  const state = { event_log: eventLogBinding(two) }
  expect(() => assertEventLogBinding(state, two)).not.toThrow()
  expect(() => assertEventLogBinding({}, two)).not.toThrow()
  const tail = Buffer.concat([two, lines({ event_id: 'C' })])
  expect(() => assertEventLogBinding(state, tail)).toThrow('EVENT_LOG_TAIL_AHEAD')
  expect(() => assertEventLogBinding(state, tail, true)).not.toThrow()
  for (const altered of [
    lines({ event_id: 'A' }),
    lines({ event_id: 'B' }, { event_id: 'A' }),
    lines({ event_id: 'A' }, { event_id: 'X' }, { event_id: 'B' })
  ])
    expect(() => assertEventLogBinding(state, altered, true)).toThrow('EVENT_LOG_HISTORY_MISMATCH')
  expect(() => assertEventLogBinding({ event_log: { sha256: 1 } }, two)).toThrow(
    'EVENT_LOG_BINDING_INVALID'
  )
  expect(bindEventLog(Buffer.from('opaque'), eventLogBinding(two)).toString()).toBe('opaque')
})

test('removed or unsigned history is caught by status, audit and the SHIP authentication gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'integrity-history-'))
  const chain = createNativeChain(root)
  const eventsPath = () => chain.sdd + '.events.jsonl'
  try {
    chain.setup()
    chain.admit()
    expect((audit(chain.sdd) as Item).authentication).toMatchObject({
      status: 'AUTHENTIC_CURRENT_EPOCH'
    })
    const intact = readFileSync(eventsPath(), 'utf8')
    // Dropping the latest committed event (e.g. an invalidation) fails closed everywhere.
    writeFileSync(eventsPath(), intact.trim().split('\n').slice(0, -1).join('\n') + '\n')
    expect(() => status(chain.sdd)).toThrow('EVENT_LOG_HISTORY_MISMATCH')
    expect((audit(chain.sdd) as Item).eventLogBinding).toContain('EVENT_LOG_HISTORY_MISMATCH')
    // A consistently rebound but unsigned insertion still fails authentication.
    const forged =
      intact +
      JSON.stringify({ event_id: 'X', role: 'coordinator', type: 'note', payload: {} }) +
      '\n'
    writeFileSync(eventsPath(), forged)
    writeFileSync(
      chain.sdd + '.loop.json',
      bindEventLog(readFileSync(chain.sdd + '.loop.json'), eventLogBinding(Buffer.from(forged)))
    )
    const authentication = (audit(chain.sdd) as Item).authentication as Item
    expect(authentication).toMatchObject({ status: 'UNAUTHENTIC_EVENT', failed_event_id: 'X' })
    const events = forged
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Item)
    expect(() => assertAuthenticCurrentEpoch(chain.state(), events, COORDINATOR)).toThrow(
      'EVENT_AUTHENTICATION_FAILED'
    )
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('later Operator leases keep the round baseline and package claims must match the real delta', () => {
  const root = mkdtempSync(join(tmpdir(), 'integrity-baseline-'))
  const chain = createNativeChain(root, { packetIds: ['PC01', 'PC02'] })
  try {
    chain.setup()
    chain.admit()
    const first = chain.readback('PC01')
    chain.advance('READBACK_APPROVED', 'IMPLEMENTING')
    // Under- or over-claiming touched packages is rejected before any persistence.
    for (const claim of [[], ['packages/other']]) {
      const before = readFileSync(chain.sdd + '.loop.json', 'utf8')
      expect(() =>
        chain.implement(first, 'export const value = 2;', 'PC01', 'candidate', claim)
      ).toThrow('OPERATOR_WORKTREE_PACKAGE_CLAIM_MISMATCH')
      expect(readFileSync(chain.sdd + '.loop.json', 'utf8')).toBe(before)
    }
    chain.implement(first, 'export const value = 2;', 'PC01')
    const retained = (chain.state().operator_worktree_baseline as Item).snapshot as Item
    expect(() =>
      dispatch(
        chain.sdd,
        'coordinator',
        'IMPLEMENTING',
        'v1',
        'operator',
        'operator',
        1,
        5,
        ['.'],
        'PC02',
        COORDINATOR,
        {
          worktreeRoot: join(root, 'elsewhere'),
          packet: 'PC02'
        }
      )
    ).toThrow('WORKTREE_ROOT_CANNOT_CHANGE_WITH_EXISTING_BASELINE')
    const second = chain.start('operator', 'PC02')
    const leases = chain.state().issued_leases as Record<string, Item>
    // The successor sees PC01's edit as part of its delta instead of a clean new baseline.
    expect((leases[second]!.worktree_baseline as Item).fingerprint).toBe(retained.fingerprint)
    expect((leases[first]!.worktree_baseline as Item).fingerprint).toBe(retained.fingerprint)
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('observed runtimes need guidance, lineage drift blocks admission and Findings stay in scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'integrity-scope-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    const draft = chain.state()
    writeFileSync(
      chain.sdd + '.loop.json',
      JSON.stringify({ ...draft, lineage_evidence_fingerprint: 'stale' })
    )
    expect(() => chain.admit()).toThrow('LINEAGE_EVIDENCE_DRIFT')
    writeFileSync(chain.sdd + '.loop.json', JSON.stringify(draft))
    chain.toArchitectVerify()
    // A real authenticated observation passes role history, so dispatch reaches the guidance rule.
    const current = chain.state()
    runtimeRecord(
      chain.sdd,
      'coordinator',
      'ARCHITECT_VERIFY',
      'v1',
      {
        id: 'OBS-architect-9',
        agent_id: 'architect-9',
        previous_record_id: null,
        action: 'observe',
        agent_role: 'architect',
        evidence: 'host receipt',
        controller: resolve(chain.sdd),
        authority_epoch: current.authority_epoch,
        // The fixture bootstrap carries no runtime identity, so the binding field stays absent.
        ...(current.coordinator_agent_id === undefined
          ? {}
          : { coordinator_agent_id: current.coordinator_agent_id }),
        host: {
          model: roleRuntime('architect').spawn_model,
          reasoning_effort: roleRuntime('architect').reasoning_effort,
          status: 'idle',
          controllable: true,
          writer_stopped: false,
          commands_stopped: false,
          close_available: false,
          conversation_id: 'isolated',
          ancestor_ids: ['supervisor'],
          confirmed_by: 'supervisor'
        }
      },
      COORDINATOR
    )
    expect(() =>
      dispatch(
        chain.sdd,
        'coordinator',
        'ARCHITECT_VERIFY',
        'v1',
        'architect',
        'architect-9',
        1,
        5,
        ['.'],
        'verify',
        COORDINATOR
      )
    ).toThrow('RUNTIME_GUIDANCE_REQUIRED')

    const architect = chain.start('architect')
    const finding = (patch: Item) =>
      chain.record('architect', architect, 'finding', {
        id: 'FX01',
        summary: 'value producer regresses',
        priority: 'P1',
        affected_packages: ['.'],
        requirement_ids: ['XQ01'],
        acceptance_ids: ['YS01'],
        ...patch
      })
    const open = (evidence: string) =>
      findingUpdate(
        chain.sdd,
        'coordinator',
        'ARCHITECT_VERIFY',
        'v1',
        'FX01',
        'P1',
        'open',
        evidence,
        COORDINATOR
      )
    expect(() => open(finding({ requirement_ids: ['XQ99'] }))).toThrow('OPEN_FINDING_SCOPE_INVALID')
    expect(open(finding({})).status).toBe('open')
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Coordinator credentials are minted into an owner-only file and reloaded from it', () => {
  const root = mkdtempSync(join(tmpdir(), 'integrity-coordinator-'))
  try {
    const good = join(root, 'good.token')
    writeFileSync(good, 'secret\n', { mode: 0o600 })
    expect(readCapabilityFile(good)).toBe('secret')
    writeFileSync(join(root, 'loose.token'), 'secret', { mode: 0o644 })
    expect(() => readCapabilityFile(join(root, 'loose.token'))).toThrow(
      'COORDINATOR_TOKEN_FILE_INSECURE'
    )
    writeFileSync(join(root, 'empty.token'), '', { mode: 0o600 })
    expect(() => readCapabilityFile(join(root, 'empty.token'))).toThrow(
      'COORDINATOR_TOKEN_FILE_EMPTY'
    )
    symlinkSync(good, join(root, 'link.token'))
    expect(() => readCapabilityFile(join(root, 'link.token'))).toThrow(
      'COORDINATOR_TOKEN_FILE_INSECURE'
    )
    expect(() => readCapabilityFile(join(root, 'missing.token'))).toThrow(
      'COORDINATOR_TOKEN_FILE_MISSING'
    )

    const sdd = join(root, 'task.md')
    writeFileSync(sdd, admissionFixture('.').source)
    initLoop(sdd, 4)
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      SDD_LOOP_CAPABILITY_DIR: join(root, 'capabilities')
    }
    delete env.SDD_LOOP_COORDINATOR_TOKEN
    delete env.SDD_LOOP_COORDINATOR_TOKEN_FILE
    const run = (args: string[], extra: Record<string, string> = {}) =>
      Bun.spawnSync([process.execPath, join(import.meta.dir, '../scripts/main.ts'), ...args], {
        env: { ...env, ...extra },
        stderr: 'pipe'
      })
    const bootstrap = run([
      'auth-bootstrap',
      '--sdd',
      sdd,
      '--expected-state',
      'DISCOVER',
      '--expected-revision',
      'v1',
      '--user-authorized',
      'yes'
    ])
    expect(bootstrap.exitCode).toBe(0)
    const { capabilityFile } = JSON.parse(bootstrap.stdout.toString()) as {
      capabilityFile: string
    }
    const state = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8')) as Item
    expect(state.coordinator_capability_file).toBe(capabilityFile)
    const note = [
      'record',
      '--sdd',
      sdd,
      '--role',
      'coordinator',
      '--expected-state',
      'DISCOVER',
      '--expected-revision',
      'v1',
      '--type',
      'progress_note',
      '--payload-json',
      '{"note":"reloaded"}'
    ]
    expect(run(note).exitCode).toBe(1)
    expect(run(note, { SDD_LOOP_COORDINATOR_TOKEN_FILE: capabilityFile }).exitCode).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a required Operator Goal cannot carry an unavailability reason', () => {
  expect(() =>
    dispatch(
      '/nonexistent.md',
      'coordinator',
      'IMPLEMENTING',
      'v1',
      'operator',
      'operator',
      1,
      5,
      ['.'],
      'work',
      COORDINATOR,
      {
        operatorGoal: 'required',
        goalUnavailableReason: 'no goal tool',
        worktreeRoot: '/tmp'
      }
    )
  ).toThrow('OPERATOR_GOAL_REASON_FORBIDDEN_WHEN_REQUIRED')
})

test('a PASS verdict is rejected when written if its checks do not observe every claimed acceptance', () => {
  const root = mkdtempSync(join(tmpdir(), 'integrity-coverage-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    chain.toArchitectVerify()
    const architect = chain.start('architect')
    chain.architectRun(architect)
    const payload = chain.verificationPayload()
    const before = readFileSync(chain.sdd + '.loop.json', 'utf8')
    // Claim one more admitted-looking acceptance than any check executed.
    expect(() =>
      chain.record('architect', architect, 'verification', {
        ...payload,
        acceptance_ids: [...(payload.acceptance_ids as string[]), 'YS99']
      })
    ).toThrow('VERIFICATION_CHECK_ACCEPTANCE_COVERAGE_INVALID')
    expect(readFileSync(chain.sdd + '.loop.json', 'utf8')).toBe(before)
    expect(chain.record('architect', architect, 'verification', payload)).toStartWith('EVT-')
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('controller locks name their owner and a live owner blocks lock recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'integrity-lock-'))
  try {
    const [first, second] = ['a.lock', 'b.lock'].map((name) => {
      const path = join(root, name)
      acquireControlLock(path)
      return readFileSync(path)
    })
    expect(lockOwner(first!)).toEqual({ pid: process.pid, host: hostname() })
    // A unique nonce makes the expected hash identify exactly one lock instance.
    expect(first!.equals(second!)).toBe(false)
    expect(lockOwner(Buffer.alloc(0))).toBeUndefined()
    const child = Bun.spawn(['sleep', '30'])
    const owned = Buffer.from(`pid=${child.pid} host=${hostname()} nonce=x at=now\n`)
    expect(() => assertLockOwnerNotRunning(owned)).toThrow('LOCK_OWNER_STILL_ACTIVE')
    // Another host's PID cannot be probed here; only the explicit stop confirmation applies.
    expect(() =>
      assertLockOwnerNotRunning(Buffer.from(`pid=${child.pid} host=elsewhere nonce=x\n`))
    ).not.toThrow()
    child.kill()
    await child.exited
    expect(() => assertLockOwnerNotRunning(owned)).not.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a revised design must keep every challenged claim it answers', () => {
  const token = 'coordinator-token'
  const state = { authority_epoch: 1, contract_revision: 'v1', sdd_fingerprint: 'sdd' }
  const body = {
    event_id: 'R1',
    role: 'coordinator',
    type: 'design_resolution',
    authority_epoch: 1,
    contract_revision: 'v1',
    sdd_fingerprint: 'sdd',
    payload: {
      decision: 'CHALLENGE',
      required_revisions: ['bound retries'],
      challenged_claim_ids: ['CL01']
    }
  }
  const challenge = {
    ...body,
    signature: createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
  }
  const proposal = (claimId: string) => ({
    responds_to_design_resolution_event_id: 'R1',
    challenge_responses: [
      { required_revision: 'bound retries', disposition: 'CORRECTED', evidence: ['retry cap 3'] }
    ],
    claims: [{ id: claimId }]
  })
  expect(() => assertChallengeResponse(state, [challenge], proposal('CL02'), token)).toThrow(
    'DESIGN_PROPOSAL_CHALLENGED_CLAIM_MISSING'
  )
  expect(() => assertChallengeResponse(state, [challenge], proposal('CL01'), token)).not.toThrow()
})
