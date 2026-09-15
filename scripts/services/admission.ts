import { parseEvents } from '../resource/store/event-log'
import { assertDesignConvergence } from '../domain/policies/delivery-graph'
import { leaseSlots } from '../helpers/lease-slots'
import { readFileSync } from 'node:fs'
import { requireAttemptConvergence } from '../helpers/attempt-convergence'
import { assertDependencyPlan } from '../schemas/dependency-operation'
import { assertConvergenceReview } from '../helpers/convergence-review'
import { readContractDocument } from '../services/contract-document'
import { assertCurrentSource } from '../helpers/source-binding'
import { logicFingerprint } from '../helpers/logic-fingerprint'
import { assertExecutionFailureReview } from '../helpers/execution-failure-review'
import { assertAdmissionScope } from '../domain/policies/admission-scope'
import { assertDecisionClosure } from '../domain/policies/decision-closure'
import { assertFalsifierEvidence } from '../domain/policies/falsifier-evidence'
import { assertAdmissionRoute } from '../domain/policies/admission-route'
import {
  assertAdmissionResponsibility,
  assertAdmissionAuthority
} from '../domain/policies/admission-responsibility'
import { assertSemanticOwnership } from '../domain/policies/semantic-ownership'
import {
  externalPrerequisites,
  assertPrerequisiteEvidence
} from '../helpers/admission-prerequisites'
import { currentCandidate } from '../helpers/candidate-evidence'
import { assertVerificationScope } from '../domain/policies/verification-scope'
import { assertClaimCoverage, assertClaimDispositions } from '../domain/policies/claim-coverage'
import { assertMigrationAdmission } from '../domain/policies/migration-admission'
import { assertAcceptanceExecution } from '../domain/policies/acceptance-execution'
import { assertLineageDispositions } from '../helpers/lineage-dispositions'
import {
  assertArtifactCustody,
  assertAuthorizationRequest
} from '../domain/policies/authority-decisions'
import { canonicalJson } from '../resource/wire/canonical-json'
import { assertDesignSupersession } from '../helpers/design-challenge'
import { collectLineageObligations } from './lineage-obligations'
import { sha256 } from '../utils/digest'
import { roleRuntime, runtimeMatches } from '../config/host'

/**
 * Validate admission evidence against the same source bytes and prior events.
 * Caller authenticates Coordinator and commits atomically after this returns.
 * A successful return permits recording a source-bound ADMIT and atomically
 * clearing the reviewed execution failure. Host and independent role checks
 * remain separate, and a pending user decision cannot be silently consumed.
 */
export function validateAdmissionEvidence(
  sdd: string,
  state: Record<string, unknown>,
  payload: Record<string, unknown>,
  eventBytes: Buffer,
  token: string
): void {
  if (state.protocol !== 'control-plane/state-v2')
    throw new Error('ADMISSION_STATE_PROTOCOL_UNSUPPORTED')
  const current = state.phase
  if (
    (state.state !== undefined && state.phase !== undefined && state.state !== state.phase) ||
    !['CONTRACT_DRAFT', 'CONTRACT_AMENDED'].includes(String(current))
  )
    throw new Error('CONTRACT_ADMISSION_STATE_INVALID')
  const admission = payload
  if (!['ADMIT', 'USER_DECISION'].includes(String(admission.decision)))
    throw new Error('ADMISSION_DECISION_UNSUPPORTED')
  if (leaseSlots(state as Record<string, unknown>).length > 0)
    throw new Error('ADMISSION_ACTIVE_LEASE')
  assertCoordinatorRuntime(admission)
  if (admission.decision === 'USER_DECISION') {
    assertUserDecisionRequest(state, admission)
    return
  }
  if (admission.authorization_request !== undefined)
    throw new Error('AUTHORIZATION_REQUEST_DECISION_INVALID')
  assertUserDecisionResolution(state, admission)
  // Parse precisely the bytes whose binding was verified, not a second read.
  const sourceBytes = readFileSync(sdd)
  assertCurrentSource(state, sdd, sourceBytes)
  const source = sourceBytes.toString('utf8')
  const contract = readContractDocument(sdd, source)
  if (!contract || contract.revision !== state.contract_revision)
    throw new Error('ADMISSION_CONTRACT_BINDING_REQUIRED')
  // A contract that still records an unconverged design cannot be admitted, whatever the payload says.
  const convergence = object(contract.design_convergence)
  if (convergence && convergence.status !== 'CONVERGED') throw new Error('CONTRACT_NOT_CONVERGED')
  assertDesignConvergence(contract)
  assertConvergenceReview(contract, admission, logicFingerprint(source))
  assertAdmissionScope(contract, admission)
  const events = parseEvents(eventBytes)
  requireAttemptConvergence(state, events, token)
  if (admission.dependency_operation_plans !== undefined) {
    if (!Array.isArray(admission.dependency_operation_plans))
      throw new Error('DEPENDENCY_OPERATION_PLANS_INVALID')
    const ids = new Set<unknown>()
    for (const plan of admission.dependency_operation_plans) {
      assertDependencyPlan(plan)
      if (ids.has(plan.id)) throw new Error('DEPENDENCY_OPERATION_PLAN_DUPLICATE')
      ids.add(plan.id)
    }
  }
  const prerequisites = externalPrerequisites(contract, admission.requirement_ids as string[])
  if (prerequisites.length) {
    const { candidate } = currentCandidate(sdd, state, events)
    assertPrerequisiteEvidence(contract, prerequisites, state, events, candidate)
  }
  assertDecisionClosure(contract, admission)
  assertFalsifierEvidence(admission)
  assertAdmissionRoute(admission)
  assertAdmissionResponsibility(admission)
  assertAdmissionAuthority(contract, admission)
  assertVerificationScope(contract, admission)
  assertAcceptanceExecution(contract)
  assertClaimCoverage(contract, admission)
  assertClaimDispositions(contract, admission)
  assertMigrationAdmission(contract, admission)
  // Predecessor facts may change after init; admission must dispose the current obligations.
  if (
    typeof state.lineage_evidence_fingerprint === 'string' &&
    sha256(canonicalJson(collectLineageObligations(sdd, contract))) !==
      state.lineage_evidence_fingerprint
  )
    throw new Error('LINEAGE_EVIDENCE_DRIFT: amend before admission')
  assertLineageDispositions(contract, state, admission)
  assertSemanticOwnership(admission)
  assertArtifactCustody(admission)
  assertDesignSupersession(state, admission, events, token)
  assertExecutionFailureReview(state, admission, events, token)
}

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const texts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(text)

/** Canonical fingerprint of a user-facing request; an unchanged request is asked only once. */
export function authorizationRequestHash(request: unknown): string {
  return sha256(canonicalJson(request))
}

/** Every route decision records the host-evidenced Coordinator runtime from the role table. */
function assertCoordinatorRuntime(payload: Item): void {
  const runtime = object(payload.coordinator_runtime)
  if (!runtime || !runtimeMatches(roleRuntime('coordinator'), runtime) || !text(runtime.evidence))
    throw new Error('COORDINATOR_RUNTIME_INVALID')
}

/** A nonterminal user wait: complete brief, real authority delta, and no duplicate prompt. */
function assertUserDecisionRequest(state: Item, payload: Item): void {
  if (
    !texts(payload.requirement_ids) ||
    !texts(payload.acceptance_ids) ||
    !texts(payload.problem_evidence)
  )
    throw new Error('CONTRACT_ADMISSION_SCOPE_REQUIRED')
  assertAuthorizationRequest(payload)
  const pending = object(state.pending_user_decision)
  if (pending?.request_hash === authorizationRequestHash(payload.authorization_request))
    throw new Error('USER_DECISION_ALREADY_PENDING')
}

/**
 * A pending decision is consumed only by an ADMIT that names that exact request and the
 * user's recorded answer; an unrelated ADMIT cannot silently discard the wait.
 */
function assertUserDecisionResolution(state: Item, payload: Item): void {
  const pending = object(state.pending_user_decision)
  const resolution = object(payload.user_decision_resolution)
  if (!pending) {
    if (payload.user_decision_resolution !== undefined)
      throw new Error('ADMISSION_USER_DECISION_RESOLUTION_UNEXPECTED')
    return
  }
  if (
    !resolution ||
    !text(pending.request_hash) ||
    resolution.request_hash !== pending.request_hash ||
    !text(resolution.user_answer) ||
    !texts(resolution.evidence)
  )
    throw new Error('ADMISSION_USER_DECISION_RESOLUTION_REQUIRED')
}
