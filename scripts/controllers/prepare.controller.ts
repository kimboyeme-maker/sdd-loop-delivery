import { nextControlRevision } from '../domain/policies/control-revision'
import { assertDesignIndependence } from '../helpers/design-independence'
import { correlateEvent } from '../context/command-context'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  COORDINATOR_TOKEN_ENV,
  commitControl,
  openCoordinatorCommand,
  signCoordinatorEvent
} from '../services/control-kernel'
import { assertActiveLease } from '../domain/policies/active-lease'
import { assertCurrentSource } from '../helpers/source-binding'
import { assertProductRoleHistory } from '../helpers/product-role'
import { currentAdmission } from '../helpers/admission-authority'
import { mintRoleCapability } from '../resource/role-capability'
import { chargeCredit, creditWeight } from '../helpers/credit-ledger'
import { contextDocument } from '../services/context-document'

const TOKEN_ENV = COORDINATOR_TOKEN_ENV

/** Grant one Architect a read-only preparation capability while an Operator runs. */
export function prepare(
  sdd: string,
  role: string,
  expectedState: string,
  expectedRevision: string,
  agentId: string,
  fresh: boolean,
  cancel: boolean,
  token = process.env[TOKEN_ENV]
): Readonly<{
  protocol: 'prepare/v1'
  eventId: string
  preparedId: string
  capabilityFile?: string
  cancelled?: boolean
}> {
  if (role !== 'coordinator') throw new Error('PREPARE_COORDINATOR_ONLY')
  if (!agentId.trim() || (fresh && cancel)) throw new Error('PREPARE_ARGS_INVALID')
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  const control = openCoordinatorCommand(sdd, token, expectedState, expectedRevision)
  const { state } = control
  const current = String(state.phase ?? '')
  const active = state.active_lease
  const existing = state.preparation
  if (cancel) {
    if (!existing || typeof existing !== 'object')
      return {
        protocol: 'prepare/v1',
        eventId: 'NOTHING_TO_CANCEL',
        preparedId: '',
        cancelled: true
      }
    const nextState = {
      ...state,
      preparation: null,
      revision: nextControlRevision(state.revision)
    }
    const eventId = `EVT-${randomUUID()}`
    const body = correlateEvent({
      event_id: eventId,
      role: 'coordinator',
      type: 'preparation_revoked',
      payload: { prepared_id: (existing as Record<string, unknown>).prepared_id }
    })
    commitControl(control, nextState, signCoordinatorEvent(state, body, token), token)
    return {
      protocol: 'prepare/v1',
      eventId,
      preparedId: String((existing as Record<string, unknown>).prepared_id),
      cancelled: true
    }
  }
  // Preparation overlaps delivery from the moment a route is admitted, so the eventual
  // Architect reads while Operator readback and implementation run. It stays read-only,
  // bound to that admission, and never coexists with a non-Operator formal lease.
  if (
    ![
      'CONTRACT_ADMITTED',
      'OPERATOR_READBACK',
      'READBACK_APPROVED',
      'IMPLEMENTING',
      'OPERATOR_SELF_CHECK'
    ].includes(current)
  )
    throw new Error('PREPARATION_STATE_INVALID')
  const operators = Object.values(
    (state.issued_leases ?? {}) as Record<string, Record<string, unknown>>
  ).filter(
    (lease) =>
      lease.role === 'operator' &&
      !lease.repair_probe_root &&
      lease.authority_epoch === state.authority_epoch &&
      lease.contract_revision === state.contract_revision
  )
  // A pipeline probe carries no product route, so it cannot anchor product preparation.
  if (
    active != null &&
    ((active as Record<string, unknown>).role !== 'operator' ||
      (active as Record<string, unknown>).repair_probe_root)
  )
    throw new Error('PREPARE_REQUIRES_OPERATOR_LEASE')
  const operator = (active ?? operators.at(-1) ?? null) as Record<string, unknown> | null
  if (
    operators.some((lease) => lease.agent_id === agentId) ||
    state.coordinator_agent_id === agentId
  )
    throw new Error('PREPARE_ROLE_IDENTITY_CONFLICT')
  if (active != null) assertActiveLease(state, operator!)
  assertCurrentSource(state, sdd)
  assertProductRoleHistory(state, control.events(), agentId, 'architect')

  assertDesignIndependence(state, control.events(), agentId)
  if (existing != null) throw new Error('PREPARATION_ALREADY_EXISTS')
  const events = control.events()
  const admission = currentAdmission(state, events, token)
  const preparedId = `PREP-${randomUUID()}`
  const capability = mintRoleCapability(preparedId)
  const eventId = `EVT-${randomUUID()}`
  const context = contextDocument(sdd, { role: 'architect', fresh })
  const preparation = {
    protocol: 'preparation/v2',
    prepared_id: preparedId,
    agent_id: agentId,
    role: 'architect',
    admission_event_id: admission.event_id,
    event_public_key: capability.publicKey,
    lease_kind: 'READ_CONTEXT',
    authority_epoch: state.authority_epoch ?? 1,
    contract_revision: state.contract_revision ?? null,
    source_sha256: createHash('sha256').update(readFileSync(sdd)).digest('hex'),
    operator_lease_id: operator?.lease_id ?? null,
    context_fingerprint: context.fingerprint,
    context_snapshot: {
      text: context.bytes.toString('utf8'),
      fingerprint: context.fingerprint,
      sources: context.sources
    },
    issued_at: new Date().toISOString(),
    fresh,
    agent_token_hash: capability.hash,
    capability_file: capability.path
  }
  const body = correlateEvent({
    event_id: eventId,
    role: 'coordinator',
    type: 'preparation_grant',
    payload: preparation
  })
  const credit = chargeCredit(state, creditWeight('preparation'))
  const nextState = {
    ...state,
    preparation,
    ...(credit ? { credit_ledger: credit } : {}),
    revision: nextControlRevision(state.revision)
  }
  commitControl(control, nextState, signCoordinatorEvent(state, body, token), token)
  return { protocol: 'prepare/v1', eventId, preparedId, capabilityFile: capability.path }
}
