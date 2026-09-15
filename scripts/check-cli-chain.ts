import { admissionFixture } from '../tests/fixtures/admission'
import { leaseWorktreeFingerprint } from './helpers/worktree-candidate'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Cross-process smoke of the public CLI through the current phase machine:
 * init → auth → admission → readback lease → three-process bootstrap → start receipt
 * → signed checkpoint → Coordinator reconcile (continue, replace). Host receipts are synthetic.
 */
const root = mkdtempSync(join(tmpdir(), 'sdd-loop-cli-smoke-'))
const sdd = join(root, 'task.sdd.md')
const token = 'cli-smoke-coordinator-token'
const entrypoint = join(import.meta.dir, 'main.ts')

/** Role runtimes receive only the controller-minted capability locator returned by dispatch. */
const roleEnv: Record<string, string> = {}
function run(args: readonly string[]): Record<string, unknown> {
  const result = Bun.spawnSync([process.execPath, entrypoint, ...args], {
    env: {
      ...process.env,
      SDD_LOOP_COORDINATOR_TOKEN: token,
      SDD_LOOP_CAPABILITY_DIR: join(root, 'capabilities'),
      ...roleEnv
    },
    stderr: 'pipe'
  })
  if (result.exitCode !== 0)
    throw new Error(`CLI_CHAIN_FAILED:${args[0]}:${result.stderr.toString().trim()}`)
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>
}
const expected = (state: string) => ['--expected-state', state, '--expected-revision', 'v1']
const advance = (from: string, to: string) =>
  run(['transition', '--sdd', sdd, '--role', 'coordinator', ...expected(from), '--to', to])

try {
  Bun.spawnSync(['git', 'init', '-q', root])
  writeFileSync(sdd, admissionFixture('.').source)
  run(['init', '--sdd', sdd, '--max-rounds', '4'])
  run(['auth-bootstrap', '--sdd', sdd, ...expected('DISCOVER'), '--user-authorized', 'yes'])
  advance('DISCOVER', 'ARCHITECT')
  advance('ARCHITECT', 'CONTRACT_DRAFT')
  run([
    'record',
    '--sdd',
    sdd,
    '--role',
    'coordinator',
    ...expected('CONTRACT_DRAFT'),
    '--type',
    'contract_admission',
    '--payload-json',
    JSON.stringify(admissionFixture('.').payload)
  ])
  advance('CONTRACT_DRAFT', 'CONTRACT_ADMITTED')
  advance('CONTRACT_ADMITTED', 'OPERATOR_READBACK')
  const lease = run([
    'dispatch',
    '--sdd',
    sdd,
    '--role',
    'coordinator',
    ...expected('OPERATOR_READBACK'),
    '--agent',
    'operator',
    '--agent-id',
    'operator-cli',
    '--soft-deadline',
    '1',
    '--hard-deadline',
    '5',
    '--scope-json',
    '["."]',
    '--work-item',
    'implement app',
    '--worktree-root',
    root
  ])
  roleEnv.SDD_LOOP_AGENT_TOKEN_FILE = String(lease.capabilityFile)
  const bootstrap = run([
    'agent-bootstrap',
    '--sdd',
    sdd,
    '--agent-id',
    'operator-cli',
    ...expected('OPERATOR_READBACK')
  ])
  const status = run(['status', '--sdd', sdd])
  const readResult = join(root, 'context-page.json')
  const summary = join(root, 'readback.txt')
  writeFileSync(readResult, JSON.stringify(run(['context-read', '--sdd', sdd])))
  writeFileSync(
    summary,
    'Implement the admitted scope and run the required self-check before handoff.'
  )
  const leaseArgs = ['--agent-id', 'operator-cli', '--lease-id', String(lease.leaseId)]
  const started = run([
    'agent-start-receipt',
    '--sdd',
    sdd,
    '--agent',
    'operator',
    ...leaseArgs,
    '--read-result',
    readResult,
    '--summary-file',
    summary,
    ...expected('OPERATOR_READBACK')
  ])
  const checkpoint = run([
    'agent-record',
    '--sdd',
    sdd,
    '--agent',
    'operator',
    ...leaseArgs,
    '--type',
    'checkpoint',
    '--payload-json',
    JSON.stringify({
      status: 'SAFE_TO_RESUME',
      completed_actions: ['read admitted packet'],
      remaining_actions: ['implement value producer'],
      active_commands: [],
      repository_state: {
        head: 'HEAD',
        worktree_fingerprint: `sha256:${'0'.repeat(64)}`,
        changed_paths: [],
        untracked_paths: []
      },
      last_check: { method: 'context-read', outcome: 'PASS', evidence: 'all pages consumed' },
      resume: {
        next_action: 'implement value producer',
        preconditions: ['lease active'],
        stop_conditions: ['scope drift']
      }
    }),
    ...expected('OPERATOR_READBACK')
  ])
  const activeLease = () =>
    (JSON.parse(readFileSync(`${sdd}.loop.json`, 'utf8')) as Record<string, unknown>)
      .active_lease as Record<string, unknown>
  const reconcile = (id: string, disposition: string, stopped: boolean) =>
    run([
      'operator-reconcile',
      '--sdd',
      sdd,
      ...expected('OPERATOR_READBACK'),
      ...leaseArgs,
      '--observation-json',
      JSON.stringify({
        observation_id: id,
        disposition,
        worktree_fingerprint: leaseWorktreeFingerprint(sdd, activeLease()) ?? 'UNBOUND',
        host: {
          runtime_status: stopped ? 'stopped' : 'healthy',
          writer_stopped: stopped,
          commands_stopped: stopped,
          evidence: 'synthetic host observation'
        },
        unfinished: ['implement value producer'],
        next_action: 'implement value producer',
        reason: 'cli smoke observation'
      })
    ])
  const continued = reconcile('obs-cli-continue', 'continue', false)
  const replaced = reconcile('obs-cli-replace', 'replace', true)
  const state = JSON.parse(readFileSync(`${sdd}.loop.json`, 'utf8')) as Record<string, unknown>
  if (
    lease.protocol !== 'dispatch/v1' ||
    (bootstrap.eventIds as unknown[] | undefined)?.length !== 3 ||
    state.active_lease != null ||
    started.protocol !== 'agent-start-receipt/v1' ||
    checkpoint.protocol !== 'agent-record/v1' ||
    continued.disposition !== 'continue' ||
    replaced.disposition !== 'replace'
  )
    throw new Error('CLI_CHAIN_STATE_INVALID')
  const working = (status.process_view as { working_agents?: unknown[] } | undefined)
    ?.working_agents
  if (status.protocol !== 'control-plane/state-v2' || working?.length !== 2)
    throw new Error('CLI_CHAIN_STATUS_INVALID')
  console.log(JSON.stringify({ protocol: 'cli-chain/v1', valid: true, leaseId: lease.leaseId }))
} finally {
  rmSync(root, { recursive: true, force: true })
}
