import { leaseSlots } from '../helpers/lease-slots'
import { assertMutablePhase } from '../domain/policies/phase'
import { nextControlRevision } from '../domain/policies/control-revision'
import {
  COORDINATOR_TOKEN_ENV,
  assertCoordinatorToken,
  assertExpected,
  commitControl,
  loadControl,
  signCoordinatorEvent
} from '../services/control-kernel'
import { canonicalJson } from '../resource/wire/canonical-json'
import { assertRecordedDependencyDecision } from '../helpers/dependency-evidence'
import { assertExecutionSubstrate } from '../schemas/execution-substrate'
import { assertAttemptConvergencePayload } from '../helpers/attempt-convergence'
import { assertDesignResolution } from '../helpers/design-resolution'
import { authorizationRequestHash, validateAdmissionEvidence } from '../services/admission'
import {
  assertDecisionEvidenceReview,
  assertFindingDecision,
  assertTerminalBlocker
} from '../domain/policies/authority-decisions'
import { randomUUID } from 'node:crypto'
import { stagePipelineRepair } from '../helpers/pipeline-repair'
import { commandCorrelation } from '../context/command-context'
import { assertCurrentSource } from '../helpers/source-binding'
import { expandPlannedPackets } from '../domain/planned-packets'
import { readContractDocument } from '../services/contract-document'

const TOKEN_ENV = COORDINATOR_TOKEN_ENV
/** Only their dedicated commands may attest state transitions or role evidence. */
const RESERVED = new Set([
  'runtime_record',
  'operator_reconcile',
  'recovery',
  'coordinator_identity',
  'coordinator_takeover',
  'requirement_status',
  'finding_status',
  'attempt_completed',
  'context_policy',
  'preparation_revoked',
  'preparation_grant',
  'contract_amendment',
  'user_decision',
  'state_transition',
  'dispatch',
  'project_context',
  'agent_started',
  'capability_probe',
  'implementation',
  'self_check',
  'verification',
  'finding',
  'design_proposal',
  'timeout_decision',
  'pipeline_incident',
  // Command names are not generic notes: accepting one would falsely appear to
  // record a failure while bypassing its counter, revocation and recovery logic.
  'pipeline_failure'
])

/**
 * State effect of a validated route decision. ADMIT consumes the reviewed failure and the
 * resolved user wait; USER_DECISION opens a nonterminal wait without touching counters.
 */
function admissionEffects(
  payload: Record<string, unknown>,
  eventId: string
): Record<string, unknown> {
  if (payload.decision !== 'USER_DECISION')
    return { pending_execution_failure: null, pending_user_decision: null }
  const request = payload.authorization_request as Record<string, unknown>
  return {
    pending_user_decision: {
      authority_basis: request.authority_basis,
      question: request.question,
      request_hash: authorizationRequestHash(request),
      event_id: eventId
    }
  }
}

/** Evolution targets a delivery may name; a finding about anything else is not this loop's business. */
const FINDING_TARGETS = ['create-sdd', 'sdd-loop-delivery', 'host-profile']

/**
 * A finding the delivery makes about the skills themselves, in its own words. This is the only
 * issue channel the retrospective does not derive: everything else it reports is inferred from
 * counters and rejection codes, which capture friction but never the substance a role actually
 * found. The shape is enforced here so the record cannot become a prose dumping ground: a finding
 * names one target, one stable key, what is wrong, what it costs, and what was done about it.
 */
export function assertFindingProposal(payload: Record<string, unknown>): void {
  const text = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0
  const texts = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length > 0 && value.every(text)
  if (
    !FINDING_TARGETS.includes(String(payload.target_skill)) ||
    // The key is what makes the same finding countable across deliveries, so it must be stable and
    // machine-shaped rather than a sentence that will be paraphrased next time.
    !/^[a-z][a-z0-9-]{3,63}$/.test(String(payload.proposal_key)) ||
    !text(payload.defect) ||
    !text(payload.consequence) ||
    !texts(payload.evidence) ||
    !['FIXED', 'DOCUMENTED', 'PROPOSED', 'RECORDED_NOT_AMENDED', 'ACCEPTED_DEVIATION'].includes(
      String(payload.disposition)
    )
  )
    throw new Error(
      'FINDING_PROPOSAL_INVALID: pass target_skill, proposal_key, defect, consequence, evidence[], disposition'
    )
}

/** Record a Coordinator-owned control event without pretending it is role evidence. */
export function recordEvent(
  sdd: string,
  role: string,
  expectedState: string,
  expectedRevision: string,
  type: string,
  payload: unknown,
  token = process.env[TOKEN_ENV]
): Readonly<{ protocol: 'record/v1'; eventId: string; type: string }> {
  if (role !== 'coordinator') throw new Error('RECORD_COORDINATOR_ONLY')
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(type)) throw new Error('EVENT_TYPE_INVALID')
  if (RESERVED.has(type)) throw new Error('DEDICATED_EVENT_COMMAND_REQUIRED')
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('EVENT_PAYLOAD_MUST_BE_OBJECT')
  // Validate before consumers inspect payload properties or serialization changes them.
  canonicalJson(payload)
  const control = loadControl(sdd)
  const { eventBytes, state } = control
  assertMutablePhase(state.phase)
  // Content checks that hold regardless of freshness run before the expectation check.
  if (type === 'coordinator_dependency_decision')
    assertRecordedDependencyDecision(state, control.events(), payload as Record<string, unknown>)
  if (type === 'execution_substrate_receipt')
    assertExecutionSubstrate(state, payload as Record<string, unknown>)
  assertExpected(state, expectedState, expectedRevision)
  assertCoordinatorToken(state, token)
  if (type === 'design_resolution') {
    if (
      leaseSlots(state as Record<string, unknown>).length > 0 ||
      state.preparation != null ||
      !['CONTRACT_DRAFT', 'CONTRACT_AMENDED', 'COORDINATOR_TRIAGE'].includes(String(state.phase))
    )
      throw new Error('DESIGN_RESOLUTION_STATE_INVALID')
    assertDesignResolution(state, payload as Record<string, unknown>, control.events(), token)
    // A disproved Architect claim justifies CHALLENGE; convergence needs confirmed evidence.
    const review = assertDecisionEvidenceReview(
      (payload as Record<string, unknown>).evidence_review
    )
    const expected =
      (payload as Record<string, unknown>).decision === 'CHALLENGE' ? 'DISPROVED' : 'CONFIRMED'
    if (review.result !== expected) throw new Error('DESIGN_RESOLUTION_EVIDENCE_RESULT_INVALID')
  }
  if (type === 'terminal_blocker') {
    if (state.pending_user_decision != null)
      throw new Error('USER_DECISION_CANNOT_TRANSITION_TO_BLOCKED')
    assertTerminalBlocker(payload as Record<string, unknown>)
    if (
      assertDecisionEvidenceReview((payload as Record<string, unknown>).evidence_review).result !==
      'CONFIRMED'
    )
      throw new Error('TERMINAL_BLOCKER_EVIDENCE_NOT_CONFIRMED')
  }
  if (type === 'finding_proposal') assertFindingProposal(payload as Record<string, unknown>)
  if (type === 'finding_decision') assertFindingDecision(payload as Record<string, unknown>)
  if (type === 'convergence_review')
    assertAttemptConvergencePayload(state, payload as Record<string, unknown>)
  if (type === 'contract_admission') {
    // One work graph: planned packets are expanded from the contract before validation and
    // signing, so every consumer reads exactly the plan's requirement, package and budget data.
    if ((payload as Record<string, unknown>).decision === 'ADMIT')
      payload = expandPlannedPackets(
        readContractDocument(sdd) as Record<string, unknown> | null,
        payload as Record<string, unknown>
      )
    validateAdmissionEvidence(sdd, state, payload as Record<string, unknown>, eventBytes, token)
  }
  // Bind design decisions at their authenticated producer. Callers may not
  // provide a different epoch/revision through the payload to reuse old advice.
  if (type === 'design_resolution' || type === 'contract_admission') {
    assertCurrentSource(state, sdd)
    if (
      !Number.isSafeInteger(state.authority_epoch) ||
      Number(state.authority_epoch) < 1 ||
      typeof state.contract_revision !== 'string' ||
      !state.contract_revision.trim() ||
      typeof state.sdd_fingerprint !== 'string' ||
      !state.sdd_fingerprint.trim()
    )
      throw new Error(
        type === 'contract_admission'
          ? 'ADMISSION_BINDING_REQUIRED'
          : 'DESIGN_RESOLUTION_BINDING_REQUIRED'
      )
  }
  const revision = nextControlRevision(state.revision)
  const eventId = `EVT-${randomUUID()}`
  const correlation = commandCorrelation()
  const body = {
    event_id: eventId,
    state: state.phase,
    authority_epoch: state.authority_epoch,
    contract_revision: state.contract_revision,
    role: 'coordinator',
    type,
    payload,
    ...(type === 'design_resolution' || type === 'contract_admission'
      ? {
          authority_epoch: state.authority_epoch,
          contract_revision: state.contract_revision,
          sdd_fingerprint: state.sdd_fingerprint
        }
      : {}),
    ...(correlation ? { context: correlation } : {})
  }
  const event = signCoordinatorEvent(state, body, token, { proof: true })
  const nextState = {
    ...(type === 'pipeline_repair'
      ? stagePipelineRepair(state, payload as Record<string, unknown>)
      : state),
    ...(type === 'contract_admission'
      ? admissionEffects(payload as Record<string, unknown>, eventId)
      : {}),
    ...(type === 'execution_substrate_receipt'
      ? { execution_substrate_required: null, last_execution_substrate_receipt: eventId }
      : {}),
    updated_at: new Date().toISOString(),
    revision
  }
  commitControl(control, nextState, event, token)
  return { protocol: 'record/v1', eventId, type }
}
