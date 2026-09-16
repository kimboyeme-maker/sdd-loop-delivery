import { mkdirSync as makeDirectory } from 'node:fs'
import { resolvePackageRoots } from '../scripts/helpers/execution-inputs'
import { cpSync } from 'node:fs'
import { admissionFixture as budgetFixture } from './fixtures/admission'
import { COORDINATOR as COORDINATOR_TOKEN } from './fixtures/native-chain'
import { existsSync as markerExists } from 'node:fs'
import { testRun as timedRun } from '../scripts/controllers/test-run.controller'
import { operatorTestUsage } from '../scripts/helpers/test-budget-usage'
import { coordinatorBrief } from '../scripts/services/coordinator-brief'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertAdmissionScope } from '../scripts/domain/policies/admission-scope'
import { assertTestBudget } from '../scripts/domain/policies/test-budget'
import type { Contract } from '../scripts/domain/contract'
import { productSnapshot } from '../scripts/helpers/worktree-candidate'
import { admissionFixture } from './fixtures/admission'
import { createNativeChain } from './fixtures/native-chain'

type Item = Record<string, unknown>

/** A focused created test entry that satisfies naming and justification rules. */
const createdTest = (path: string, concept: string, acceptance = 'YS01') => ({
  path,
  business_concept: concept,
  business_oracle: 'value equals two',
  action: 'CREATED',
  layer: 'UNIT',
  requirement_ids: ['XQ01'],
  acceptance_ids: [acceptance],
  reuse_candidates: ['check.ts'],
  separation_boundary: 'TEST_LAYER',
  separation_reason: 'the existing check script is not a unit test host'
})

test('admitted packets carry a strict test budget bounded by the plan', () => {
  const fixture = admissionFixture('packages/app')
  const payload = structuredClone(fixture.payload) as Item
  const packet = (payload.execution_packets as Item[])[0]!
  const contract = fixture.contract as unknown as Contract
  for (const [budget, error] of [
    [undefined, 'EXECUTION_PACKET_TEST_BUDGET_INVALID'],
    [{ minutes: 16, max_new_test_files: 0 }, 'EXECUTION_PACKET_TEST_BUDGET_JUSTIFICATION_REQUIRED'],
    [{ minutes: 5, max_new_test_files: 2 }, 'EXECUTION_PACKET_TEST_BUDGET_JUSTIFICATION_REQUIRED']
  ] as const) {
    packet.test_budget = budget
    expect(() => assertAdmissionScope(contract, payload)).toThrow(error)
  }
  packet.test_budget = { minutes: 10, max_new_test_files: 1 }
  expect(() => assertAdmissionScope(contract, payload)).not.toThrow()
  const planned = {
    ...contract,
    delivery_plan: {
      batches: [
        {
          id: packet.id,
          requirement_ids: packet.requirement_ids,
          modification_packages: ['packages/app'],
          test_budget: { minutes: 5, max_new_test_files: 0 }
        }
      ]
    }
  } as unknown as Contract
  expect(() => assertAdmissionScope(planned, payload)).toThrow('EXECUTION_PACKET_PLAN_MISMATCH')
})

test('implementation rejects test sprawl and tests outside the packet acceptance', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-budget-sprawl-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    chain.admit()
    const lease = chain.readback()
    chain.advance('READBACK_APPROVED', 'IMPLEMENTING')
    const submit = (files: Record<string, string>, testChanges: Item[]) => {
      writeFileSync(join(chain.workspace, chain.productFile), 'export const value = 2;')
      for (const [path, content] of Object.entries(files))
        writeFileSync(join(chain.workspace, path), content)
      const changes = [
        { path: chain.productFile, action: 'MODIFIED' },
        ...Object.keys(files).map((path) => ({ path, action: 'CREATED' }))
      ]
      const candidate = {
        candidate_id: 'candidate',
        environment_fingerprint: 'fixture-bun',
        changes,
        manifest_sha256: createHash('sha256').update(JSON.stringify(changes)).digest('hex'),
        worktree_fingerprint: productSnapshot(chain.sdd, chain.workspace).fingerprint
      }
      return () =>
        chain.record('operator', lease, 'implementation', {
          candidate,
          execution_packet_ids: ['PC01'],
          changed_packages: chain.admission.modification_packages,
          test_changes: testChanges
        })
    }
    // The packet allows one new test file; a second one for the same outcome is sprawl.
    const before = readFileSync(chain.sdd + '.loop.json', 'utf8')
    expect(
      submit({ 'value-parsing.test.ts': 'parse', 'value-format.test.ts': 'format' }, [
        createdTest('value-parsing.test.ts', 'value parsing'),
        createdTest('value-format.test.ts', 'value formatting')
      ])
    ).toThrow('TEST_SPRAWL_FORBIDDEN')
    expect(readFileSync(chain.sdd + '.loop.json', 'utf8')).toBe(before)
    rmSync(join(chain.workspace, 'value-format.test.ts'))
    // A test proving an acceptance outside the packet chases someone else's gate.
    expect(
      submit({ 'value-parsing.test.ts': 'parse' }, [
        createdTest('value-parsing.test.ts', 'value parsing', 'YS99')
      ])
    ).toThrow('TEST_CHANGE_SCOPE_INVALID')
    expect(readFileSync(chain.sdd + '.loop.json', 'utf8')).toBe(before)
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('test runs are controller-timed and scoped, and a self-check cites measured runs only', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-budget-runs-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    chain.admit()
    const lease = chain.readback()
    chain.advance('READBACK_APPROVED', 'IMPLEMENTING')
    chain.implement(lease, 'export const value = 2;')
    chain.advance('OPERATOR_SELF_CHECK')
    const statePath = chain.sdd + '.loop.json'
    // A role cannot self-report timing: only the controller-timed command records a run.
    expect(() => chain.record('operator', lease, 'test_run', { duration_seconds: 1 })).toThrow(
      'TEST_RUN_REQUIRES_CONTROLLER_MEASUREMENT'
    )
    expect(() => chain.runTests(lease, ['YS99'])).toThrow('TEST_RUN_SCOPE_INVALID')
    const passed = chain.runTests(lease)
    expect(passed.outcome).toBe('PASS')
    expect(coordinatorBrief(chain.sdd).budgets).toMatchObject({
      test_seconds: { round_spent: passed.duration_seconds }
    })
    expect((chain.state().credit_ledger as Item).spent).toBeGreaterThan(0)
    const before = readFileSync(statePath, 'utf8')
    expect(() =>
      chain.record('operator', lease, 'self_check', {
        ...chain.selfCheckPayload(),
        test_run_event_ids: ['EVT-forged']
      })
    ).toThrow('TEST_RUN_EVIDENCE_INVALID')
    const { test_run_event_ids: _omit, ...withoutRuns } = chain.selfCheckPayload()
    expect(() => chain.record('operator', lease, 'self_check', withoutRuns)).toThrow(
      'SELF_CHECK_TEST_RUNS_REQUIRED'
    )
    expect(readFileSync(statePath, 'utf8')).toBe(before)
    chain.record('operator', lease, 'self_check', chain.selfCheckPayload('PASS', [passed.eventId]))
    expect(chain.state().active_lease).toBeNull()
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the controller kills a run at the acceptance timeout', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-budget-kill-'))
  const fixture = budgetFixture('.')
  const contract = structuredClone(fixture.contract) as unknown as Item
  const acceptance = (contract.acceptance as Item[])[0]!
  acceptance.execution = { ...(acceptance.execution as Item), timeout_seconds: 2 }
  // The acceptance declares the slow command, because test-run binds argv to the declared method.
  const chain = createNativeChain(root, { contract, acceptanceMethod: 'sleep 5' })
  try {
    chain.setup()
    chain.admit()
    const lease = chain.readback()
    chain.advance('READBACK_APPROVED', 'IMPLEMENTING')
    chain.implement(lease, 'export const value = 2;')
    const slow = chain.runTests(lease, undefined, ['sleep', '5'])
    expect(slow).toMatchObject({ outcome: 'INCONCLUSIVE', timed_out: true })
    expect(slow.duration_seconds).toBeLessThan(5)
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('test-run authorizes the role before executing anything', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-run-auth-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    chain.admit()
    const lease = chain.readback()
    chain.advance('READBACK_APPROVED', 'IMPLEMENTING')
    const marker = join(root, 'ran.txt')
    expect(() =>
      timedRun(
        chain.sdd,
        'operator',
        'operator',
        lease,
        chain.phase(),
        'v1',
        ['YS01'],
        ['sh', '-c', `touch ${marker}`],
        undefined,
        'wrong-credential',
        COORDINATOR_TOKEN
      )
    ).toThrow('AGENT_TOKEN_INVALID')
    expect(markerExists(marker)).toBe(false)
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a packet admitted with a zero test budget hands off on its receipt without runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-budget-zero-'))
  const fixture = budgetFixture('.')
  const admission = {
    ...fixture.payload,
    execution_packets: (fixture.payload.execution_packets as unknown as Item[]).map((packet) => ({
      ...packet,
      test_budget: { minutes: 0, max_new_test_files: 0 }
    }))
  } as unknown as Item
  const chain = createNativeChain(root, { admission })
  try {
    chain.setup()
    chain.admit()
    const lease = chain.readback()
    chain.advance('READBACK_APPROVED', 'IMPLEMENTING')
    chain.implement(lease, 'export const value = 2;')
    chain.advance('OPERATOR_SELF_CHECK')
    expect(() => chain.runTests(lease)).toThrow('TEST_BUDGET_ZERO')
    chain.record('operator', lease, 'self_check', chain.selfCheckPayload('PASS', []))
    expect(chain.state().active_lease).toBeNull()
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('packet and round test budgets are measured separately', () => {
  const admission = {
    execution_packets: [
      { id: 'PC01', test_budget: { minutes: 3 } },
      { id: 'PC02', test_budget: { minutes: 1 } }
    ]
  }
  const state = { issued_leases: { L1: { packet_id: 'PC01' }, L2: { packet_id: 'PC02' } } }
  const run = (lease: string, seconds: number) => ({
    type: 'test_run',
    role: 'operator',
    actor: { lease_id: lease },
    payload: { duration_seconds: seconds }
  })
  // PC01 already spent six minutes; PC02 has not run and keeps its own allowance.
  expect(operatorTestUsage(state, [run('L1', 360)], admission, ['PC02'])).toMatchObject({
    packet_spent_seconds: 0,
    remaining_seconds: 120
  })
  // The round cap (twice every packet budget) still binds across packets.
  expect(operatorTestUsage(state, [run('L1', 450)], admission, ['PC02']).remaining_seconds).toBe(30)
  // A closed round starts a new clock.
  const closed = [run('L1', 480), { type: 'state_transition', payload: { to: 'ROUND_CLOSED' } }]
  expect(operatorTestUsage(state, closed, admission, ['PC01']).round_spent_seconds).toBe(0)
})

test('an executed Architect check is exactly its controller-measured run', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-budget-verify-'))
  // The declared method reads a flag outside the workspace, so this test can produce a genuinely
  // failing run without touching the candidate: test-run binds argv to the method, and both the
  // copy gate and the candidate gate refuse a product edited to make a command fail.
  const flag = join(root, 'fail-flag')
  const chain = createNativeChain(root, {
    acceptanceMethod: `test ! -f ${flag}`
  })
  try {
    chain.setup()
    chain.toArchitectVerify()
    const architect = chain.start('architect')
    chain.architectRun(architect)
    const payload = chain.verificationPayload()
    const withCheck = (patch: Item) => () =>
      chain.record('architect', architect, 'verification', {
        ...payload,
        checks: (payload.checks as Item[]).map((check) => ({ ...check, ...patch }))
      })
    // A reported duration or outcome that differs from the run is rejected.
    expect(withCheck({ duration_seconds: 31 })).toThrow('VERIFICATION_CHECK_MEASUREMENT_MISMATCH')
    // A PASS check citing a run that actually failed is rejected.
    const failCopy = join(root, 'fail-copy')
    cpSync(chain.workspace, failCopy, { recursive: true })
    writeFileSync(flag, 'the declared method fails while this exists')
    const failed = timedRun(
      chain.sdd,
      'architect',
      'architect',
      architect,
      chain.phase(),
      'v1',
      ['YS01'],
      ['sh', '-c', chain.declaredMethod],
      failCopy,
      chain.token(architect),
      COORDINATOR_TOKEN
    )
    expect(failed.outcome).toBe('FAIL')
    rmSync(flag)
    expect(
      withCheck({ test_run_event_id: failed.eventId, duration_seconds: failed.duration_seconds })
    ).toThrow('VERIFICATION_CHECK_MEASUREMENT_MISMATCH')
    // No measured run, no executed check.
    expect(() =>
      chain.record('architect', architect, 'verification', {
        ...payload,
        checks: (payload.checks as Item[]).map(({ test_run_event_id: _omit, ...check }) => check)
      })
    ).toThrow('VERIFICATION_TEST_RUN_REQUIRED')
    expect(withCheck({ test_run_event_id: 'EVT-forged' })).toThrow(
      'VERIFICATION_TEST_RUN_BINDING_INVALID'
    )
    // The later failing run of the same acceptance supersedes the earlier pass.
    expect(withCheck({})).toThrow('VERIFICATION_EVIDENCE_SUPERSEDED')
    // After a new passing run, a check naming only the acceptance and the run is complete.
    chain.architectRun(architect)
    const fresh = chain.verificationPayload()
    expect(
      chain.record('architect', architect, 'verification', {
        ...fresh,
        checks: (fresh.checks as Item[]).map((check) => ({
          acceptance_ids: check.acceptance_ids,
          test_run_event_id: check.test_run_event_id
        }))
      })
    ).toStartWith('EVT-')
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('another SDD controller state inside the worktree is rejected by name', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-budget-foreign-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    chain.admit()
    writeFileSync(join(chain.workspace, 'other.sdd.md.loop.json'), '{}')
    expect(() => chain.readback()).toThrow('WORKTREE_FOREIGN_CONTROLLER_STATE')
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('final verification traces the product through the candidate after the round baseline retires', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-run-final-source-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    chain.toArchitectVerify()
    chain.verify()
    chain.advance('COORDINATOR_TRIAGE', 'FINAL_CANDIDATE', 'FINAL_VERIFY')
    // Round closure retires the frozen baseline; the candidate still names its product.
    const statePath = chain.sdd + '.loop.json'
    writeFileSync(
      statePath,
      JSON.stringify({
        ...JSON.parse(readFileSync(statePath, 'utf8')),
        operator_worktree_baseline: null
      })
    )
    const architect = chain.start('architect')
    const run = (directory: string) => () =>
      timedRun(
        chain.sdd,
        'architect',
        'architect',
        architect,
        chain.phase(),
        'v1',
        ['YS01'],
        ['sh', '-c', chain.declaredMethod],
        directory,
        chain.token(architect),
        COORDINATOR_TOKEN
      )
    expect(run(chain.workspace)).toThrow('TEST_RUN_ISOLATED_COPY_REQUIRED')
    const copy = join(root, 'final-copy')
    cpSync(chain.workspace, copy, { recursive: true })
    writeFileSync(join(copy, chain.productFile), 'export const value = 3;')
    expect(run(copy)).toThrow('TEST_RUN_COPY_DIVERGED')
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('observed packages resolve through manifest identities and never to an empty input set', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-run-packages-'))
  try {
    makeDirectory(join(root, 'packages', 'foo'), { recursive: true })
    writeFileSync(
      join(root, 'packages', 'foo', 'package.json'),
      JSON.stringify({ name: '@scope/foo' })
    )
    writeFileSync(join(root, 'packages', 'foo', 'index.ts'), 'export const foo = 1')
    expect(resolvePackageRoots(root, ['@scope/foo'])).toEqual(['packages/foo'])
    expect(() => resolvePackageRoots(root, ['@scope/missing'])).toThrow(
      'TEST_RUN_PACKAGE_UNRESOLVED'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a budget above the defaults is admitted only with a basis in its own acceptance', () => {
  const over = { minutes: 20, max_new_test_files: 2 }
  expect(() => assertTestBudget(over, 'BATCH', 90, ['YS01'])).toThrow(
    'BATCH_TEST_BUDGET_JUSTIFICATION_REQUIRED'
  )
  const basis = { acceptance_ids: ['YS01'], reason: 'the browser journey needs a cold build' }
  expect(assertTestBudget({ ...over, acceptance_basis: basis }, 'BATCH', 90, ['YS01'])).toEqual(
    over
  )
  expect(() =>
    assertTestBudget(
      { ...over, acceptance_basis: { ...basis, acceptance_ids: ['YS09'] } },
      'BATCH',
      90,
      ['YS01']
    )
  ).toThrow('BATCH_TEST_BUDGET_JUSTIFICATION_REQUIRED')
})
