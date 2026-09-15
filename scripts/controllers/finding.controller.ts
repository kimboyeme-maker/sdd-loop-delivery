import { eventsWithId } from '../utils/event-index'
import { ledgerNextRevision } from '../helpers/ledger-mutation'
import {
  COORDINATOR_TOKEN_ENV,
  commitControl,
  openCoordinatorCommand,
  signCoordinatorEvent
} from '../services/control-kernel'
import { currentAdmission } from '../helpers/admission-authority'
import { readContractDocument } from '../services/contract-document'
import { assertCurrentVerification } from '../helpers/current-verification'
import { correlateEvent } from '../context/command-context'
import { randomUUID } from 'node:crypto'
import { assertRoleEvidence } from '../helpers/role-evidence'

const TOKEN_ENV = COORDINATOR_TOKEN_ENV
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3', 'P4'])

/**
 * A Finding's scope is inherited by successors, so it may only name requirements, acceptance
 * and packages the verification that produced it could observe: the current admission for a
 * round verification, the whole Must-Ship contract for FINAL_VERIFY.
 */
function assertOpenFindingScope(
  sdd: string,
  state: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  token: string
): void {
  let requirements: string[], acceptance: string[], packages: string[]
  if (event.state === 'FINAL_VERIFY') {
    const contract = readContractDocument(sdd)
    if (!contract) throw new Error('OPEN_FINDING_SCOPE_INVALID')
    const mustShip = contract.requirements.filter((item) => item.kind === 'must-ship')
    requirements = mustShip.map((item) => item.id)
    acceptance = mustShip.flatMap((item) => item.acceptance ?? [])
    packages = (contract.acceptance as Record<string, unknown>[])
      .filter((item) => acceptance.includes(String(item.id)))
      .flatMap((item) => (item.packages as string[] | undefined) ?? [])
  } else {
    const admission = currentAdmission(state, events, token).payload as Record<string, unknown>
    requirements = (admission.requirement_ids as string[] | undefined) ?? []
    acceptance = (admission.acceptance_ids as string[] | undefined) ?? []
    packages = (
      ((admission.verification_scope as Record<string, unknown> | undefined)?.surfaces ??
        []) as Record<string, unknown>[]
    ).flatMap((surface) => (surface.packages as string[] | undefined) ?? [])
  }
  const within = (values: unknown, allowed: readonly string[]) =>
    Array.isArray(values) && values.every((value) => allowed.includes(String(value)))
  if (
    !within(data.requirement_ids, requirements) ||
    !within(data.acceptance_ids, acceptance) ||
    !Array.isArray(data.affected_packages) ||
    !data.affected_packages.every((path) =>
      packages.some((root) => root === '.' || path === root || String(path).startsWith(`${root}/`))
    )
  )
    throw new Error('OPEN_FINDING_SCOPE_INVALID')
}

/**
 * Register a Finding or reference an Architect's successful re-verification.
 * A resolution must explicitly name this Finding; an unrelated PASS is not closure.
 * Resolution also checks current candidate bytes, provenance, independence, and revocation.
 */
export function findingUpdate(
  sdd: string,
  role: string,
  expectedState: string,
  expectedRevision: string,
  id: string,
  priority: string,
  status: string,
  evidence: string | undefined,
  token = process.env[TOKEN_ENV]
): Readonly<{ protocol: 'finding/v1'; eventId: string; id: string; status: string }> {
  if (role !== 'coordinator') throw new Error('ROLE_FINDING_FORBIDDEN')
  if (!PRIORITIES.has(priority) || !new Set(['open', 'resolved']).has(status))
    throw new Error('FINDING_INPUT_INVALID')
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  const control = openCoordinatorCommand(sdd, token, expectedState, expectedRevision)
  const { state } = control
  const nextRevision = ledgerNextRevision(state, 'FINDING')
  if (
    state.findings !== undefined &&
    (state.findings === null || typeof state.findings !== 'object' || Array.isArray(state.findings))
  )
    throw new Error('FINDING_LEDGER_INVALID')
  const findings = (state.findings ?? {}) as Record<string, unknown>
  if (status === 'resolved') {
    if (!Object.hasOwn(findings, id)) throw new Error('UNKNOWN_FINDING: ' + id)
    const prior = findings[id]
    if (
      !prior ||
      typeof prior !== 'object' ||
      Array.isArray(prior) ||
      (prior as Record<string, unknown>).id !== id
    )
      throw new Error('FINDING_LEDGER_INVALID')
    if ((prior as Record<string, unknown>).priority !== priority)
      throw new Error('FINDING_RESOLUTION_PRIORITY_MISMATCH')
  }
  // Missing evidence must not skip the verification branch below.
  if (status === 'resolved' && !evidence?.trim())
    throw new Error('FINDING_REVERIFY_EVIDENCE_REQUIRED')
  if (status === 'open' && !evidence) throw new Error('OPEN_FINDING_REQUIRES_EVIDENCE')
  const events = control.events()
  if (evidence) {
    const matches = eventsWithId(events, evidence)
    const event = matches.length === 1 ? matches[0] : undefined
    if (
      !event ||
      event.role !== 'architect' ||
      !['finding', 'verification'].includes(String(event.type))
    )
      throw new Error('FINDING_EVIDENCE_INVALID')
    assertRoleEvidence(state, event, 'architect')
    const payload = event.payload
    if (!payload || typeof payload !== 'object') throw new Error('FINDING_EVIDENCE_INVALID')
    const data = payload as Record<string, unknown>
    if (status === 'open' && (data.id !== id || data.priority !== priority))
      throw new Error('OPEN_FINDING_EVIDENCE_INVALID')
    if (status === 'open') assertOpenFindingScope(sdd, state, events, event, data, token)
    if (status === 'resolved' && (event.type !== 'verification' || data.result !== 'PASS'))
      throw new Error('FINDING_REVERIFY_EVIDENCE_REQUIRED')
    if (
      status === 'resolved' &&
      (!Array.isArray(data.finding_ids) ||
        !data.finding_ids.every((value) => typeof value === 'string' && value.trim()) ||
        !data.finding_ids.includes(id))
    )
      throw new Error('FINDING_REVERIFY_SCOPE_MISMATCH')
    if (status === 'resolved') assertCurrentVerification(sdd, state, events, event)
  }
  const eventId = `EVT-${randomUUID()}`
  const nextFinding = {
    ...(findings[id] && typeof findings[id] === 'object'
      ? (findings[id] as Record<string, unknown>)
      : {}),
    id,
    priority,
    status,
    evidence: evidence ?? null
  }
  const body = correlateEvent({
    event_id: eventId,
    role: 'coordinator',
    type: 'finding_status',
    payload: nextFinding
  })
  const nextState = {
    ...state,
    findings: { ...findings, [id]: nextFinding },
    revision: nextRevision
  }
  commitControl(control, nextState, signCoordinatorEvent(state, body, token), token)
  return { protocol: 'finding/v1', eventId, id, status }
}
