import { committedEventReader } from '../resource/store/event-window'
import { parseEvents } from '../resource/store/event-log'
import { assertMutablePhase } from '../domain/policies/phase'
import { roleTransactionSecurity } from '../resource/role-transaction'
import { preparationBootstrapCount } from '../helpers/preparation-bootstrap'
import { assertCurrentSource } from '../helpers/source-binding'
import { nextControlRevision } from '../domain/policies/control-revision'
import { correlateEvent } from '../context/command-context'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { decodeState, sidecarPaths } from '../resource/state'
import { commitSidecar } from '../resource/store/sidecar-transaction'
import { currentAdmission } from '../helpers/admission-authority'
import { signRoleEvent } from '../resource/role-signature'
import { assertContextReadEvidence } from '../services/context-read-evidence'
import { readContractDocument } from '../services/contract-document'
import { assertPreparedChecks } from '../helpers/prepared-checks'
import { deriveChecks } from '../helpers/check-derivation'
import { assertPreparationReady, authorizePreparation } from '../helpers/preparation-auth'
import { assertMeasuredCheck } from '../helpers/measured-check'
import { chargeCredit, creditWeight } from '../helpers/credit-ledger'

const TOKEN_ENV = 'SDD_LOOP_COORDINATOR_TOKEN'
const PHASES = ['OPEN', 'REAUTHENTICATE', 'READY'] as const

/** Accept only ordered read-only preparation receipts; never records product evidence. */
export function prepareRecord(
  sdd: string,
  agentId: string,
  preparedId: string,
  type: string,
  payload: unknown,
  expectedState: string,
  expectedRevision: string,
  token = process.env[TOKEN_ENV],
  // Set only by the test-run controller after it has timed the command itself.
  controllerMeasured = false
): Readonly<{ protocol: 'prepare-record/v1'; eventId: string; preparedId: string }> {
  // Prepared checks observe bytes on an isolated copy; they are evidence, never product verdicts.
  if (
    !['capability_probe', 'context_ready', 'baseline_check', 'packet_check', 'test_run'].includes(
      type
    )
  )
    throw new Error('PREPARATION_FORBIDS_PRODUCT_EVENT')
  if (type === 'test_run' && !controllerMeasured)
    throw new Error('TEST_RUN_REQUIRES_CONTROLLER_MEASUREMENT: use test-run --prepared-id')
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('EVENT_PAYLOAD_MUST_BE_OBJECT')
  const paths = sidecarPaths(sdd)
  if (!existsSync(paths.state)) throw new Error('LOOP_NOT_INITIALIZED')
  const stateBytes = readFileSync(paths.state)
  const eventBytes = committedEventReader(paths.events, () => state as Record<string, unknown>)
  const state = decodeState(JSON.parse(stateBytes.toString('utf8')))
  assertMutablePhase(state.phase)
  if (String(state.phase ?? '') !== expectedState) throw new Error('EXPECTED_STATE_MISMATCH')
  if (String(state.contract_revision ?? '') !== expectedRevision)
    throw new Error('EXPECTED_REVISION_MISMATCH')
  assertCurrentSource(state, sdd)
  const events = parseEvents(eventBytes())
  const { grant: current, agentToken } = authorizePreparation(
    sdd,
    state as Record<string, unknown>,
    events,
    { agentId, preparedId, expectedState, coordinatorToken: token }
  )
  const completed = Array.isArray(current.capability_probe_phases)
    ? ([...current.capability_probe_phases] as string[])
    : []
  preparationBootstrapCount(state, current, events)
  const input = { ...(payload as Record<string, unknown>) }
  let creditAfter: Record<string, unknown> | undefined
  if (type === 'capability_probe') {
    const phase = input.phase
    if (
      typeof phase !== 'string' ||
      completed.length >= PHASES.length ||
      phase !== PHASES[completed.length]
    )
      throw new Error('CAPABILITY_PROBE_SEQUENCE_INVALID')
    completed.push(phase)
  } else if (type === 'context_ready') {
    if (completed.length !== PHASES.length || current.ready_event_id)
      throw new Error('PREPARATION_READINESS_INVALID')
    if (typeof input.summary !== 'string' || input.summary.trim().length < 20)
      throw new Error('PREPARATION_READ_RECEIPTS_INVALID')
    if (typeof input.read_result !== 'string') throw new Error('PREPARATION_READ_RECEIPTS_INVALID')
    input.reading = assertContextReadEvidence(sdd, input.read_result, {
      role: 'architect',
      agentId,
      preparedId,
      fresh: current.fresh === true
    })
  } else if (type === 'test_run') {
    assertPreparationReady(state as Record<string, unknown>, current, events)
    creditAfter = chargeCredit(
      state as Record<string, unknown>,
      Math.ceil(Number(input.duration_seconds) / 60) * creditWeight('test_minute'),
      { allowOverrun: true }
    )
  } else {
    // Prepared checks run while the Operator still owns the worktree, so they need completed
    // reading, an isolated copy, and exact contract bindings for admitted acceptance.
    if (completed.length !== PHASES.length || typeof current.ready_event_id !== 'string')
      throw new Error('PREPARATION_READINESS_REQUIRED')
    if (typeof input.isolated_copy !== 'string' || input.isolated_copy.trim().length < 10)
      throw new Error('PREPARED_CHECK_ISOLATION_REQUIRED')
    const contract = readContractDocument(sdd) as Record<string, unknown> | null
    if (!contract) throw new Error('PREPARED_CHECK_CONTRACT_REQUIRED')
    const admission = currentAdmission(state, events, token).payload as Record<string, unknown>
    if (type === 'baseline_check') {
      const baseline = (state.operator_worktree_baseline as Record<string, unknown> | null)
        ?.snapshot as Record<string, unknown> | undefined
      if (!baseline || input.baseline_fingerprint !== baseline.fingerprint)
        throw new Error('BASELINE_CHECK_BASELINE_MISMATCH')
      input.checks = deriveChecks(contract, events, input.checks)
      assertPreparedChecks(contract, (admission.acceptance_ids as string[]) ?? [], input.checks)
      assertPreparedEvidence(state as Record<string, unknown>, events, current, input)
    } else {
      const packet = (
        Array.isArray(admission.execution_packets)
          ? (admission.execution_packets as Record<string, unknown>[])
          : []
      ).find((item) => item.id === input.packet_id)
      const record = (state.packet_candidates as Record<string, Record<string, unknown>> | null)?.[
        String(input.packet_id)
      ]
      if (!packet || !record || record.implementation_event_id !== input.implementation_event_id)
        throw new Error('PACKET_CHECK_CANDIDATE_INVALID')
      input.checks = deriveChecks(contract, events, input.checks)
      assertPreparedChecks(contract, (packet.acceptance_ids as string[]) ?? [], input.checks)
      assertPreparedEvidence(state as Record<string, unknown>, events, current, input)
    }
  }
  current.capability_probe_phases = completed
  const eventId = `EVT-${randomUUID()}`
  if (type === 'context_ready') current.ready_event_id = eventId
  const body = correlateEvent({
    event_id: eventId,
    state: state.phase,
    contract_revision: state.contract_revision,
    role: 'architect',
    type,
    payload: input,
    actor: { agent_id: agentId, prepared_id: preparedId, authority_epoch: state.authority_epoch }
  })
  const event = `${JSON.stringify(signRoleEvent(body, agentToken))}\n`
  const nextState = {
    ...state,
    ...(creditAfter ? { credit_ledger: creditAfter } : {}),
    preparation: current,
    revision: nextControlRevision(state.revision)
  }
  const security = roleTransactionSecurity(state, current, agentToken)
  commitSidecar(paths, Buffer.from(JSON.stringify(nextState)), Buffer.from(event), security, {
    state: stateBytes
  })
  return { protocol: 'prepare-record/v1', eventId, preparedId }
}

/**
 * A prepared check that cites a measured run must equal that run of this grant. Runs freeze their own
 * inputs, so a binding supplied afterwards is refused. Unmeasured checks remain preparation
 * information and can never be reused as verification evidence.
 */
function assertPreparedEvidence(
  state: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
  grant: Record<string, unknown>,
  input: Record<string, unknown>
): void {
  for (const check of (input.checks as Record<string, unknown>[]) ?? [])
    if (check.test_run_event_id !== undefined)
      assertMeasuredCheck(state, events, check, {
        prepared_id: String(grant.prepared_id),
        event_public_key: String(grant.event_public_key)
      })
}
