import { existsSync, lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { ACCEPTANCE_TIMEOUT_MAX_SECONDS, TEST_RUN_OUTPUT_TAIL_BYTES } from '../config/constants'
import { currentAdmission } from '../helpers/admission-authority'
import { chargeCredit, creditWeight } from '../helpers/credit-ledger'
import { assertPreparationReady, authorizePreparation } from '../helpers/preparation-auth'
import { authorizeRoleLease, leaseSecondsRemaining } from '../helpers/role-lease-auth'
import { admittedPacketIds, operatorTestUsage } from '../helpers/test-budget-usage'
import {
  assertExecutableControl,
  assertExpected,
  COORDINATOR_TOKEN_ENV,
  loadControl,
  roundEvents
} from '../services/control-kernel'
import { containsPath, freezeExecutionInputs } from '../helpers/execution-inputs'
import { candidateProductRoot, currentCandidateEventId } from '../helpers/candidate-source'
import { currentCandidate } from '../helpers/candidate-evidence'
import { readContractDocument } from '../services/contract-document'
import { runInProcessGroup } from '../resource/process-group'
import { agentRecord } from './agent-record.controller'
import { prepareRecord } from './prepare-record.controller'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined

/** Phases in which each role may execute acceptance commands under a formal lease. */
const TEST_PHASES: Readonly<Record<'operator' | 'architect', readonly string[]>> = {
  operator: ['IMPLEMENTING', 'OPERATOR_SELF_CHECK'],
  architect: ['ARCHITECT_VERIFY', 'FINAL_VERIFY']
}

/**
 * Execute one acceptance command under a controller-owned timer and record the measured result
 * as signed role evidence (`test_run`). Authority is checked before anything runs: a formal lease,
 * or (with `preparedId`) a ready Architect preparation grant that runs on an isolated copy while
 * the Operator still works. The timeout is the smallest of the acceptances' timeouts, the lease's
 * remaining time and, for an Operator, the packet and round test allowances. Capability variables
 * never reach the child. This measures what ran; it does not prove the command is the right oracle.
 */
export function testRun(
  sdd: string,
  agent: string,
  agentId: string,
  leaseId: string,
  expectedState: string,
  expectedRevision: string,
  acceptanceIds: readonly string[],
  argv: readonly string[],
  cwd: string | undefined,
  agentToken?: string,
  coordinatorToken = process.env[COORDINATOR_TOKEN_ENV],
  preparedId?: string
): Readonly<{
  protocol: 'test-run/v1'
  eventId: string
  outcome: string
  duration_seconds: number
  timed_out: boolean
  exit_code: number | null
}> {
  if (agent !== 'operator' && agent !== 'architect') throw new Error('AGENT_ROLE_INVALID')
  if (!argv.length || argv.some((part) => typeof part !== 'string' || !part))
    throw new Error('TEST_RUN_COMMAND_REQUIRED')
  if (!acceptanceIds.length || new Set(acceptanceIds).size !== acceptanceIds.length)
    throw new Error('TEST_RUN_ACCEPTANCE_REQUIRED')
  const control = loadControl(sdd)
  const { state } = control
  assertExpected(state, expectedState, expectedRevision)
  // Journal, committed history and normative sources are checked before anything runs.
  assertExecutableControl(sdd, control)
  // Authorization, admission, candidate and budget are round-scoped; a prepared run also checks
  // design independence, which needs the whole history.
  const events = preparedId === undefined ? roundEvents(control) : control.events()
  let lease: Item | undefined
  let admission: Item
  let scope: string[]
  if (preparedId !== undefined) {
    if (agent !== 'architect') throw new Error('TEST_RUN_PREPARATION_ARCHITECT_ONLY')
    // Full preparation authority before anything runs; recording re-checks the same facts.
    const { grant } = authorizePreparation(sdd, state as Item, events, {
      agentId,
      preparedId,
      expectedState,
      coordinatorToken
    })
    assertPreparationReady(state as Item, grant, events)
    admission = currentAdmission(state, events, coordinatorToken).payload as Item
    scope = (admission.acceptance_ids as string[]) ?? []
  } else {
    if (!TEST_PHASES[agent].includes(String(state.phase))) throw new Error('TEST_RUN_STATE_INVALID')
    // Full role authority before anything runs; recording afterwards re-checks the same facts.
    lease = authorizeRoleLease(state as Item, events, {
      agent,
      agentId,
      leaseId,
      agentToken,
      type: 'test_run'
    }).lease
    admission = currentAdmission(state, events, coordinatorToken).payload as Item
    const packet = (Array.isArray(admission.execution_packets) ? admission.execution_packets : [])
      .map((value) => object(value) ?? {})
      .find((item) => item.id === lease!.packet_id)
    scope = (
      agent === 'operator'
        ? (packet?.acceptance_ids ?? admission.acceptance_ids)
        : (lease.acceptance_ids ?? admission.acceptance_ids)
    ) as string[]
  }
  if (acceptanceIds.some((id) => !scope.includes(id))) throw new Error('TEST_RUN_SCOPE_INVALID')
  const definitions = (readContractDocument(sdd)?.acceptance ?? []) as Item[]
  let timeout = Math.min(
    ...acceptanceIds.map((id) =>
      Number(
        object(definitions.find((item) => item.id === id)?.execution)?.timeout_seconds ??
          ACCEPTANCE_TIMEOUT_MAX_SECONDS
      )
    )
  )
  if (lease && agent === 'operator') {
    const usage = operatorTestUsage(
      state as Item,
      events,
      admission,
      typeof lease.packet_id === 'string' ? [lease.packet_id] : admittedPacketIds(admission)
    )
    if (!usage.packet_budget_seconds)
      throw new Error('TEST_BUDGET_ZERO: this work was admitted without Operator test execution')
    if (usage.remaining_seconds <= 0)
      throw new Error('TEST_BUDGET_EXHAUSTED: record implementation_escalation')
    timeout = Math.min(timeout, usage.remaining_seconds)
  }
  if (lease) {
    // A run never outlives the authority it was granted under.
    const leaseSeconds = leaseSecondsRemaining(lease)
    if (leaseSeconds < 1) throw new Error('AGENT_LEASE_EXPIRED')
    timeout = Math.min(timeout, leaseSeconds)
  }
  // Refuse to start when not even one test minute of credit remains.
  chargeCredit(state, creditWeight('test_minute'))
  // The product location is traced through the authenticated candidate, never round-scoped state;
  // a formal Architect run also re-checks that the product still holds that candidate.
  if (agent === 'architect' && preparedId === undefined)
    currentCandidate(sdd, state as Item, events)
  const baselineRoot = object(state.operator_worktree_baseline)?.root
  const productRoot =
    candidateProductRoot(state as Item, events) ??
    (typeof baselineRoot === 'string' && existsSync(baselineRoot) ? baselineRoot : null)
  const directory = agent === 'operator' ? String(lease?.worktree_root ?? '') : (cwd ?? '')
  if (
    !directory ||
    !isAbsolute(directory) ||
    !existsSync(directory) ||
    !lstatSync(directory).isDirectory()
  )
    throw new Error(
      agent === 'architect' ? 'TEST_RUN_ISOLATED_COPY_REQUIRED' : 'TEST_RUN_WORKTREE_REQUIRED'
    )
  // An Architect never runs inside the Operator worktree: not its root, a subdirectory, an alias
  // or a directory containing it. This prevents mistakes; it is not operating-system isolation.
  if (
    agent === 'architect' &&
    productRoot &&
    (containsPath(productRoot, directory) || containsPath(directory, productRoot))
  )
    throw new Error('TEST_RUN_ISOLATED_COPY_REQUIRED')
  const packages = [
    ...new Set(
      acceptanceIds.flatMap((id) => {
        const declared = definitions.find((item) => item.id === id)?.packages
        return Array.isArray(declared) && declared.length ? (declared as string[]) : ['.']
      })
    )
  ]
  // Freeze what this run executes against before it starts. An Architect copy must hold the
  // product bytes of the observed packages; evidence later compares against this record only.
  const inputs = freezeExecutionInputs({
    directory,
    sourceRoot: agent === 'operator' ? directory : productRoot,
    packages,
    candidateEventId: currentCandidateEventId(state as Item, events)
  })
  // Scanning inputs takes time. Right before launch, re-check authority and the absolute deadline on
  // fresh state and recompute the timeout: preparation time never extends execution authority.
  const launch = loadControl(sdd)
  if (launch.state.contract_revision !== expectedRevision)
    throw new Error('EXPECTED_REVISION_MISMATCH')
  assertExecutableControl(sdd, launch)
  const launchEvents = preparedId === undefined ? roundEvents(launch) : launch.events()
  if (preparedId !== undefined) {
    const { grant } = authorizePreparation(sdd, launch.state as Item, launchEvents, {
      agentId,
      preparedId,
      expectedState: String(launch.state.phase ?? ''),
      coordinatorToken
    })
    assertPreparationReady(launch.state as Item, grant, launchEvents)
  } else {
    const current = authorizeRoleLease(launch.state as Item, launchEvents, {
      agent,
      agentId,
      leaseId,
      agentToken,
      type: 'test_run'
    }).lease
    const leaseSeconds = leaseSecondsRemaining(current)
    if (leaseSeconds < 1) throw new Error('AGENT_LEASE_EXPIRED')
    timeout = Math.min(timeout, leaseSeconds)
    if (agent === 'operator') {
      const usage = operatorTestUsage(
        launch.state as Item,
        launchEvents,
        admission,
        typeof current.packet_id === 'string' ? [current.packet_id] : admittedPacketIds(admission)
      )
      if (usage.remaining_seconds <= 0)
        throw new Error('TEST_BUDGET_EXHAUSTED: record implementation_escalation')
      timeout = Math.min(timeout, usage.remaining_seconds)
    }
  }
  chargeCredit(launch.state, creditWeight('test_minute'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^SDD_LOOP_.*TOKEN/.test(key))
  )
  const run = runInProcessGroup({
    sdd,
    argv,
    cwd: directory,
    env,
    timeoutSeconds: timeout,
    owner: {
      agent,
      agent_id: agentId,
      lease_id: preparedId === undefined ? leaseId : null,
      prepared_id: preparedId ?? null
    },
    tailBytes: TEST_RUN_OUTPUT_TAIL_BYTES
  })
  const duration = Math.max(1, Math.ceil(run.duration_ms / 1000))
  const timedOut = run.timed_out
  // A killed group (timeout, reclamation or an outside SIGKILL) proves nothing either way; output
  // size never changes the outcome because output is written to a file.
  const outcome =
    timedOut || run.reclaimed || run.signal === 'SIGKILL'
      ? 'INCONCLUSIVE'
      : run.error
        ? 'NOT_RUN'
        : run.exit_code === 0
          ? 'PASS'
          : 'FAIL'
  const payload = {
    argv: [...argv],
    acceptance_ids: [...acceptanceIds],
    cwd: directory,
    duration_seconds: duration,
    timeout_seconds: timeout,
    exit_code: run.exit_code,
    signal: run.signal,
    timed_out: timedOut,
    reclaimed: run.reclaimed,
    outcome,
    output_sha256: run.output_sha256,
    output_bytes: run.output_bytes,
    output_tail: run.output_tail,
    controller_measured: true,
    inputs
  }
  // Registration re-checks authority on the state as it is now. Ordinary phase advancement while
  // the command ran keeps a still-valid result; a changed revision or revoked authority refuses it,
  // and the measurement is reported as unregistered instead of being silently lost.
  const now = loadControl(sdd).state
  let eventId: string
  try {
    if (now.contract_revision !== expectedRevision) throw new Error('EXPECTED_REVISION_MISMATCH')
    const registerState = String(now.phase ?? '')
    eventId = (
      preparedId !== undefined
        ? prepareRecord(
            sdd,
            agentId,
            preparedId,
            'test_run',
            payload,
            registerState,
            expectedRevision,
            coordinatorToken,
            true
          )
        : agentRecord(
            sdd,
            agent,
            agentId,
            leaseId,
            registerState,
            expectedRevision,
            'test_run',
            payload,
            agentToken,
            coordinatorToken,
            true
          )
    ).eventId
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'TEST_RUN_REGISTRATION_FAILED'
    throw new Error(
      `TEST_RUN_RESULT_UNREGISTERED: ${reason}; ${JSON.stringify({
        outcome,
        duration_seconds: duration,
        timed_out: timedOut,
        exit_code: run.exit_code,
        output_sha256: payload.output_sha256,
        inputs_fingerprint: inputs.files_fingerprint
      })}`
    )
  }
  return {
    protocol: 'test-run/v1',
    eventId,
    outcome,
    duration_seconds: duration,
    timed_out: timedOut,
    exit_code: run.exit_code
  }
}
