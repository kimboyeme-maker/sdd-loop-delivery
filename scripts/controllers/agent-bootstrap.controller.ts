import { committedEventReader } from '../resource/store/event-window'
import { parseEvents } from '../resource/store/event-log'
import { bootstrapReceiptFor, findLeaseByAgent } from '../helpers/lease-slots'
import { assertMutablePhase } from '../domain/policies/phase'
import { roleCapabilityToken } from '../resource/role-capability'
import { roleTransactionSecurity } from '../resource/role-transaction'
import { signRoleEvent, rolePublicKey } from '../resource/role-signature'
import { assertCurrentSource } from '../helpers/source-binding'
import { nextControlRevision } from '../domain/policies/control-revision'
import { correlateEvent } from '../context/command-context'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { decodeState, sidecarPaths } from '../resource/state'
import { commitSidecar } from '../resource/store/sidecar-transaction'
import { type BootstrapReceipt } from '../domain/policies/bootstrap'
import { parseBootstrapReceipt } from '../schemas/host'
import { assertActiveLease } from '../domain/policies/active-lease'
import { assertRoleEventPhase } from '../domain/policies/role-event-phase'
import { assertBootstrapEvidence } from '../helpers/bootstrap-evidence'

const COORDINATOR_ENV = 'SDD_LOOP_COORDINATOR_TOKEN'
const PHASES = ['OPEN', 'REAUTHENTICATE', 'READY'] as const

/** Authenticate and persist one process-local phase; the helper controls ordered subprocess execution. */
export function agentBootstrap(
  sdd: string,
  agentId: string,
  receiptsPath: string | readonly BootstrapReceipt[],
  expectedState: string,
  expectedRevision: string,
  coordinatorToken = process.env[COORDINATOR_ENV],
  agentToken?: string,
  singlePhase = false
): Readonly<{ protocol: 'agent-bootstrap/v1'; eventIds: readonly string[]; agentStarted: false }> {
  if (!singlePhase) throw new Error('BOOTSTRAP_USE_AUTHENTICATED_SUBPROCESSES')
  const paths = sidecarPaths(sdd)
  if (!existsSync(paths.state)) throw new Error('LOOP_NOT_INITIALIZED')
  let raw: unknown
  try {
    raw =
      typeof receiptsPath === 'string'
        ? JSON.parse(readFileSync(receiptsPath, 'utf8'))
        : receiptsPath
  } catch {
    throw new Error('BOOTSTRAP_PAYLOAD_INVALID')
  }
  if (!Array.isArray(raw)) throw new Error('BOOTSTRAP_PAYLOAD_ARRAY_REQUIRED')
  const receipts = raw.map((item) => parseBootstrapReceipt(item)) as BootstrapReceipt[]
  if (receipts.length !== 1) throw new Error('BOOTSTRAP_SINGLE_PHASE_REQUIRED')
  if (receipts[0]!.agentId !== agentId) throw new Error('BOOTSTRAP_AGENT_MISMATCH')
  const stateBytes = readFileSync(paths.state)
  const eventBytes = committedEventReader(paths.events, () => state as Record<string, unknown>)
  const state = decodeState(JSON.parse(stateBytes.toString('utf8')))
  assertMutablePhase(state.phase)
  assertCurrentSource(state, sdd)
  if (String(state.phase ?? '') !== expectedState) throw new Error('EXPECTED_STATE_MISMATCH')
  if (String(state.contract_revision ?? '') !== expectedRevision)
    throw new Error('EXPECTED_REVISION_MISMATCH')
  const active = findLeaseByAgent(state as Record<string, unknown>, agentId)
  if (
    !active ||
    typeof active !== 'object' ||
    (active as Record<string, unknown>).agent_id !== agentId
  )
    throw new Error('BOOTSTRAP_ACTIVE_LEASE_REQUIRED')
  const boundAgentHash = (active as Record<string, unknown>).agent_token_hash
  const lease = active as Record<string, unknown>
  if (typeof lease.lease_id !== 'string' || !lease.lease_id.trim())
    throw new Error('BOOTSTRAP_ACTIVE_LEASE_REQUIRED')
  if (lease.role !== 'operator' && lease.role !== 'architect')
    throw new Error('BOOTSTRAP_ROLE_INVALID')
  const roleToken = agentToken ?? roleCapabilityToken(lease)
  if (
    !roleToken ||
    typeof boundAgentHash !== 'string' ||
    createHash('sha256').update(roleToken).digest('hex') !== boundAgentHash
  )
    throw new Error('BOOTSTRAP_AGENT_AUTH_INVALID')
  if (lease.event_public_key !== rolePublicKey(roleToken))
    throw new Error('AGENT_EVENT_KEY_MISMATCH')
  assertActiveLease(state, lease)
  if (!lease.repair_probe_root)
    assertRoleEventPhase(lease.role, 'capability_probe', state.phase, lease.verification_mode)
  const repair = state.pending_pipeline_repair as Record<string, unknown> | undefined
  if (
    lease.repair_probe_root &&
    (!repair ||
      repair.root_cause_key !== lease.repair_probe_root ||
      !lease.repair_candidate_hash ||
      repair.candidate_hash !== lease.repair_candidate_hash)
  )
    throw new Error('PIPELINE_REPAIR_PROBE_BINDING_INVALID')
  const currentPrior = bootstrapReceiptFor(state as Record<string, unknown>, lease.lease_id)
  const priorReceipts = (currentPrior?.receipts ?? []) as BootstrapReceipt[]
  const priorIds = (currentPrior?.event_ids ?? []) as string[]
  if (currentPrior) {
    assertBootstrapEvidence(
      state,
      lease,
      parseEvents(eventBytes()),
      roleToken,
      priorReceipts,
      false
    )
  }
  if (receipts[0]!.stage !== PHASES[priorReceipts.length])
    throw new Error('BOOTSTRAP_STAGE_ORDER_INVALID')
  if (receipts[0]!.processId !== String(process.pid) || receipts[0]!.success !== true)
    throw new Error('BOOTSTRAP_PROCESS_INVALID')
  if (priorReceipts.some((item) => item.processId === receipts[0]!.processId))
    throw new Error('BOOTSTRAP_PROCESS_NOT_DISTINCT')
  const allReceipts = [...priorReceipts, ...receipts]
  const finished = allReceipts.length === PHASES.length
  const eventIds: string[] = []
  let eventText = ''
  for (const receipt of receipts) {
    const eventId = `EVT-${randomUUID()}`
    const body = correlateEvent({
      event_id: eventId,
      state: state.phase,
      contract_revision: state.contract_revision,
      role: (active as Record<string, unknown>).role ?? 'operator',
      type: 'capability_probe',
      payload: receipt,
      actor: {
        agent_id: agentId,
        lease_id: lease.lease_id,
        authority_epoch: state.authority_epoch
      }
    })
    eventText += `${JSON.stringify(signRoleEvent(body, roleToken))}\n`
    eventIds.push(eventId)
  }
  if (!eventIds.length) return { protocol: 'agent-bootstrap/v1', eventIds, agentStarted: false }
  const nextState = {
    ...state,
    ...(lease.repair_probe_root && finished
      ? {
          pending_pipeline_repair: null,
          active_lease: null,
          last_pipeline_repair: {
            root_cause_key: lease.repair_probe_root,
            candidate_hash: lease.repair_candidate_hash,
            evidence: eventIds.at(-1)
          }
        }
      : {}),
    capability_probe_phases: PHASES.slice(0, allReceipts.length),
    bootstrap_receipts: {
      ...(state.bootstrap_receipts as Record<string, unknown> | undefined),
      [String(lease.lease_id)]: {
        lease_id: lease.lease_id,
        receipts: allReceipts,
        event_ids: [...priorIds, ...eventIds]
      }
    },
    revision: nextControlRevision(state.revision, eventIds.length)
  }

  const security = roleTransactionSecurity(state, lease, roleToken)
  commitSidecar(paths, Buffer.from(JSON.stringify(nextState)), Buffer.from(eventText), security, {
    state: stateBytes
  })
  return { protocol: 'agent-bootstrap/v1', eventIds, agentStarted: false }
}
