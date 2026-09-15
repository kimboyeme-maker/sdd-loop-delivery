import { eventsWithId } from '../utils/event-index'
import { ledgerNextRevision } from '../helpers/ledger-mutation'
import {
  COORDINATOR_TOKEN_ENV,
  commitControl,
  openCoordinatorCommand,
  signCoordinatorEvent
} from '../services/control-kernel'
import { assertCurrentVerification } from '../helpers/current-verification'
import { assertContractDeferral } from '../helpers/contract-deferral'
import { assertCurrentSource } from '../helpers/source-binding'
import { correlateEvent } from '../context/command-context'
import { randomUUID } from 'node:crypto'

const TOKEN_ENV = COORDINATOR_TOKEN_ENV
const STATUSES = new Set(['pending', 'in-progress', 'verified', 'deferred', 'blocked'])

/** Update one requirement only after current Coordinator and evidence checks pass. */
export function requirementUpdate(
  sdd: string,
  role: string,
  expectedState: string,
  expectedRevision: string,
  id: string,
  status: string,
  evidence: string | undefined,
  owner: string | undefined,
  trigger: string | undefined,
  impact: string | undefined,
  approvedBy: string | undefined,
  token = process.env[TOKEN_ENV]
): Readonly<{ protocol: 'requirement/v1'; eventId: string; id: string; status: string }> {
  if (role !== 'coordinator') throw new Error('ROLE_REQUIREMENT_FORBIDDEN')
  if (!STATUSES.has(status)) throw new Error('REQUIREMENT_STATUS_INVALID')
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  const control = openCoordinatorCommand(sdd, token, expectedState, expectedRevision)
  const { state } = control
  const nextRevision = ledgerNextRevision(state, 'REQUIREMENT')
  const requirements = state.requirements
  if (
    !requirements ||
    typeof requirements !== 'object' ||
    Array.isArray(requirements) ||
    !Object.hasOwn(requirements, id)
  )
    throw new Error(`UNKNOWN_REQUIREMENT: ${id}`)
  const events = control.events()
  if (status === 'verified') {
    if (!evidence) throw new Error('VERIFIED_REQUIRES_ARCHITECT_EVIDENCE')
    const matches = eventsWithId(events, evidence)
    const event = matches.length === 1 ? matches[0] : undefined
    const payload = event?.payload
    if (
      !event ||
      event.role !== 'architect' ||
      event.type !== 'verification' ||
      !payload ||
      typeof payload !== 'object' ||
      (payload as Record<string, unknown>).result !== 'PASS' ||
      !Array.isArray((payload as Record<string, unknown>).requirement_ids) ||
      !((payload as Record<string, unknown>).requirement_ids as unknown[]).includes(id)
    )
      throw new Error('VERIFIED_REQUIRES_ARCHITECT_VERIFICATION_EVENT')
    assertCurrentVerification(sdd, state, events, event)
    const result = payload as Record<string, unknown>
    const contract = state.contract as Record<string, unknown> | undefined
    const definitions = contract?.requirements
    const requirementMatches = Array.isArray(definitions)
      ? definitions.filter(
          (value) => value !== null && typeof value === 'object' && value.id === id
        )
      : []
    const acceptance =
      requirementMatches.length === 1 ? requirementMatches[0].acceptance : undefined
    if (
      !Array.isArray(acceptance) ||
      !acceptance.length ||
      acceptance.some((value) => typeof value !== 'string' || !value.trim()) ||
      !Array.isArray(result.acceptance_ids) ||
      !acceptance.every((value) => (result.acceptance_ids as unknown[]).includes(value))
    )
      throw new Error('VERIFIED_ACCEPTANCE_COVERAGE_REQUIRED')
  }
  if (status === 'deferred') {
    if (
      ![owner, trigger, impact, approvedBy].every(
        (value) => typeof value === 'string' && value.trim()
      )
    )
      throw new Error('DEFERRED_METADATA_REQUIRED')
    const kinds = state.requirement_kinds
    const mustShip =
      (kinds &&
        typeof kinds === 'object' &&
        (kinds as Record<string, unknown>)[id] === 'must-ship') ||
      (Array.isArray(state.must_ship_requirements) && state.must_ship_requirements.includes(id))
    if (mustShip && approvedBy !== 'user') throw new Error('MUST_SHIP_DEFERRAL_REQUIRES_USER')
    assertCurrentSource(state, sdd)
    assertContractDeferral(state.contract, id, { owner, trigger, impact, approved_by: approvedBy })
  }
  const eventId = `EVT-${randomUUID()}`
  const evidenceLedger = state.requirement_evidence
  if (
    evidenceLedger !== undefined &&
    (!evidenceLedger || typeof evidenceLedger !== 'object' || Array.isArray(evidenceLedger))
  )
    throw new Error('REQUIREMENT_EVIDENCE_LEDGER_INVALID')
  const requirementEvidence = { ...(evidenceLedger as Record<string, unknown> | undefined) }
  if (status === 'verified') requirementEvidence[id] = evidence
  else delete requirementEvidence[id]
  const body = correlateEvent({
    event_id: eventId,
    state: state.phase,
    authority_epoch: state.authority_epoch,
    contract_revision: state.contract_revision,
    role: 'coordinator',
    type: 'requirement_status',
    payload: {
      id,
      status,
      evidence: evidence ?? null,
      deferred: status === 'deferred' ? { owner, trigger, impact, approved_by: approvedBy } : null
    }
  })
  const event = signCoordinatorEvent(state, body, token, { proof: true })
  const nextState = {
    ...state,
    requirements: { ...(requirements as Record<string, unknown>), [id]: status },
    requirement_evidence: requirementEvidence,
    revision: nextRevision
  }
  commitControl(control, nextState, event, token)
  return { protocol: 'requirement/v1', eventId, id, status }
}
