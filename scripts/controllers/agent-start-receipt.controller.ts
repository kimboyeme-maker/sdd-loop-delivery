import { committedEventReader } from '../resource/store/event-window'
import { parseEvents } from '../resource/store/event-log'
import { findLease, storeLease } from '../helpers/lease-slots'
import { roleTransactionSecurity } from '../resource/role-transaction'
import { signRoleEvent } from '../resource/role-signature'
import { roleCapabilityToken } from '../resource/role-capability'
import { requireOperatorGoalAck } from '../helpers/operator-goal'
import { nextControlRevision } from '../domain/policies/control-revision'
import { correlateEvent } from '../context/command-context'
import { assertBootstrapEvidence } from '../helpers/bootstrap-evidence'
import { assertCurrentSource } from '../helpers/source-binding'
import { assertContextReadEvidence } from '../services/context-read-evidence'
import { assertActiveLease } from '../domain/policies/active-lease'
import { assertRoleEventPhase } from '../domain/policies/role-event-phase'
import { assertMutablePhase } from '../domain/policies/phase'
import { currentAdmission } from '../helpers/admission-authority'
import { currentGuidance, guidanceAck } from '../helpers/guidance-ack'
import { leaseWorktreeFingerprint } from '../helpers/worktree-candidate'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { decodeState, sidecarPaths } from '../resource/state'
import { commitSidecar } from '../resource/store/sidecar-transaction'

type Item = Record<string, unknown>
const COORDINATOR_TOKEN_ENV = 'SDD_LOOP_COORDINATOR_TOKEN'
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** Role-authored start inputs that the controller cannot derive. */
export type StartExtras = Readonly<{
  /** `{next_action, check_method, stop_condition}` for a guided lease. */
  guidanceResponse?: unknown
  /** Required when the lease carries a recovery binding. */
  recoveryReadback?: unknown
}>

/**
 * Controller-derived scope the role signs at start. Round required roles to hand-copy these
 * canonical fields; deriving and signing them removes transcription errors while the role's
 * own summary, guidance response and recovery readback remain the independent readback.
 */
function scopeReadback(state: Item, events: readonly Item[], lease: Item, token?: string): Item {
  const base = {
    work_item: lease.work_item,
    packet_id: lease.packet_id ?? null,
    modification_packages: list(lease.scope)
  }
  if (!lease.admission_event_id) return base
  const admission = currentAdmission(state, events, token)
  if (admission.event_id !== lease.admission_event_id)
    throw new Error('AGENT_STARTED_ADMISSION_STALE')
  const payload = object(admission.payload)!
  const packet = Array.isArray(payload.execution_packets)
    ? (payload.execution_packets as Item[]).find((item) => item.id === lease.packet_id)
    : undefined
  return {
    ...base,
    objective: payload.round_outcome ?? null,
    requirement_ids: list(
      lease.requirement_ids ?? packet?.requirement_ids ?? payload.requirement_ids
    ),
    acceptance_ids: list(lease.acceptance_ids ?? packet?.acceptance_ids ?? payload.acceptance_ids),
    packet_outcome: packet?.outcome ?? null,
    preconditions: list(packet?.preconditions),
    causal_scope: list(packet?.causal_scope),
    stop_conditions: list(packet?.stop_or_escalate)
  }
}

/**
 * A successor never starts from an empty epistemic state: it names the predecessor,
 * the currently observed worktree, what it inspected and the recorded next action.
 */
function recoveryReadback(sdd: string, lease: Item, value: unknown): Item {
  const recovery = object(lease.recovery)!
  const readback = object(value)
  const current = leaseWorktreeFingerprint(sdd, lease)
  if (
    !readback ||
    readback.predecessor_lease_id !== (recovery.predecessor_lease_id ?? recovery.lease_id) ||
    typeof readback.worktree_fingerprint !== 'string' ||
    (current !== null && readback.worktree_fingerprint !== current) ||
    !list(readback.inspected_paths).length ||
    list(readback.inspected_paths).length !== (readback.inspected_paths as unknown[]).length ||
    (typeof recovery.next_action === 'string' && readback.next_action !== recovery.next_action) ||
    typeof readback.summary !== 'string' ||
    readback.summary.trim().length < 20
  )
    throw new Error('RECOVERY_READBACK_INVALID')
  return readback
}

/** Accept a role's first-start readback only after lease, capability and reading checks. */
export function agentStartReceipt(
  sdd: string,
  agent: 'operator' | 'architect',
  agentId: string,
  leaseId: string,
  readResult: string,
  summary: string,
  expectedState: string,
  expectedRevision: string,
  token = process.env[COORDINATOR_TOKEN_ENV],
  goalAck?: unknown,
  extras: StartExtras = {},
  agentToken?: string
): Readonly<{ protocol: 'agent-start-receipt/v1'; eventId: string }> {
  if (summary.trim().length < 20) throw new Error('AGENT_START_READBACK_REQUIRED')
  const paths = sidecarPaths(sdd)
  if (!existsSync(paths.state)) throw new Error('LOOP_NOT_INITIALIZED')
  const stateBytes = readFileSync(paths.state)
  const eventBytes = committedEventReader(paths.events, () => state as Item)
  const state = decodeState(JSON.parse(stateBytes.toString('utf8')))
  assertMutablePhase(state.phase)
  assertRoleEventPhase(
    agent,
    'agent_started',
    state.phase,
    findLease(state as Item, leaseId)?.verification_mode
  )
  assertCurrentSource(state, sdd)
  if (String(state.phase ?? '') !== expectedState) throw new Error('EXPECTED_STATE_MISMATCH')
  if (String(state.contract_revision ?? '') !== expectedRevision)
    throw new Error('EXPECTED_REVISION_MISMATCH')
  const lease = findLease(state as Item, leaseId)
  if (!lease || lease.lease_id !== leaseId || lease.agent_id !== agentId || lease.role !== agent)
    throw new Error('AGENT_LEASE_MISMATCH')
  const credential = agentToken ?? roleCapabilityToken(lease)
  if (lease.agent_token_hash !== createHash('sha256').update(credential).digest('hex'))
    throw new Error('AGENT_TOKEN_INVALID')
  assertActiveLease(state, lease)
  if (lease.repair_probe_root || lease.lease_kind === 'PIPELINE_PROBE')
    throw new Error('PIPELINE_PROBE_FORBIDS_PRODUCT_START')
  if (lease.started_event_id) throw new Error('AGENT_ALREADY_STARTED')
  const events = parseEvents(eventBytes())
  assertBootstrapEvidence(state, lease, events, credential)
  const reading = assertContextReadEvidence(sdd, readResult, {
    role: agent,
    agentId,
    packetId: typeof lease.packet_id === 'string' ? lease.packet_id : undefined
  })
  if (
    typeof lease.context_fingerprint === 'string' &&
    reading.context_fingerprint !== lease.context_fingerprint
  )
    throw new Error('AGENT_STARTED_CONTEXT_MISMATCH')
  const binding = currentGuidance(state, events, lease, token)
  if (!binding && extras.guidanceResponse !== undefined)
    throw new Error('GUIDANCE_RESPONSE_UNEXPECTED')
  if (!lease.recovery && extras.recoveryReadback !== undefined)
    throw new Error('RECOVERY_READBACK_UNEXPECTED')
  const startPayload = {
    read_result: true,
    reading,
    summary,
    readback: scopeReadback(state, events, lease, token),
    ...(binding ? { guidance_ack: guidanceAck(binding, extras.guidanceResponse) } : {}),
    ...(lease.recovery
      ? { recovery_readback: recoveryReadback(sdd, lease, extras.recoveryReadback) }
      : {}),
    ...(goalAck !== undefined ? { goal_ack: goalAck } : {})
  }
  requireOperatorGoalAck(state, [], lease, startPayload, 'agent_started')
  const eventId = `EVT-${randomUUID()}`
  const body = correlateEvent({
    event_id: eventId,
    state: state.phase,
    contract_revision: state.contract_revision,
    role: agent,
    type: 'agent_started',
    payload: startPayload,
    actor: { agent_id: agentId, lease_id: leaseId, authority_epoch: state.authority_epoch }
  })
  const event = `${JSON.stringify(signRoleEvent(body, credential))}\n`
  const nextState = {
    ...state,
    ...storeLease(state as Item, { ...lease, started_event_id: eventId }),
    // A replacement's accepted readback consumes the pending recovery observation.
    ...(object(lease.recovery)?.source === 'replacement' ? { operator_recovery: null } : {}),
    revision: nextControlRevision(state.revision)
  }
  const security = roleTransactionSecurity(state, lease, credential)
  commitSidecar(paths, Buffer.from(JSON.stringify(nextState)), Buffer.from(event), security, {
    state: stateBytes
  })
  return { protocol: 'agent-start-receipt/v1', eventId }
}
