import {
  ARTIFACT_INSTALL_MODES,
  ARTIFACT_KINDS,
  ARTIFACT_ROLES,
  AUTHORITY_BASIS_DELTA_KEYS,
  AUTHORITY_DELTA_KEYS,
  DECISION_EVIDENCE,
  FINDING_DECISIONS,
  TERMINAL_BLOCKER_REASONS,
  USER_AUTHORITY_BASES
} from '../../config/constants'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const texts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(text)
const oneOf = (values: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && values.includes(value)
const codeExample = (value: unknown): boolean => {
  const example = object(value)
  return !!example && text(example.language) && text(example.code)
}

/**
 * Require a complete user-facing brief for a real authority boundary.
 * A request that crosses no boundary is an ordinary technical choice Coordinator must make.
 */
export function assertAuthorizationRequest(payload: Item): void {
  const request = object(payload.authorization_request)
  const brief = [
    'question',
    'scenario',
    'cause',
    'impact',
    'destructive_or_breaking_effects',
    'reversibility',
    'recommendation',
    'authorization_reason',
    'no_action_effect'
  ]
  if (
    !request ||
    !oneOf(USER_AUTHORITY_BASES, request.authority_basis) ||
    !brief.every((field) => text(request[field]))
  )
    throw new Error('AUTHORIZATION_REQUEST_BRIEF_REQUIRED')
  const delta = object(request.authority_delta)
  if (
    !delta ||
    Object.keys(delta).length !== AUTHORITY_DELTA_KEYS.length ||
    AUTHORITY_DELTA_KEYS.some((key) => typeof delta[key] !== 'boolean') ||
    !texts(request.authority_boundary_evidence)
  )
    throw new Error('AUTHORIZATION_AUTHORITY_DELTA_REQUIRED')
  if (!AUTHORITY_DELTA_KEYS.some((key) => delta[key] === true))
    throw new Error('AUTHORIZATION_USER_BOUNDARY_NOT_CROSSED')
  const basis = request.authority_basis as keyof typeof AUTHORITY_BASIS_DELTA_KEYS
  if (!AUTHORITY_BASIS_DELTA_KEYS[basis].some((key) => delta[key] === true))
    throw new Error('AUTHORIZATION_BASIS_DELTA_MISMATCH')
  if (!codeExample(request.current_code_example))
    throw new Error('AUTHORIZATION_CURRENT_CODE_EXAMPLE_REQUIRED')
  if (!Array.isArray(request.options) || !request.options.length)
    throw new Error('AUTHORIZATION_OPTIONS_REQUIRED')
  const ids = new Set<string>()
  let recommended = 0
  for (const value of request.options) {
    const option = object(value)
    if (
      !option ||
      ![
        'id',
        'summary',
        'impact',
        'destructive_or_breaking_effects',
        'reversibility',
        'tradeoffs'
      ].every((field) => text(option[field])) ||
      typeof option.recommended !== 'boolean'
    )
      throw new Error('AUTHORIZATION_OPTION_INVALID')
    if (ids.has(option.id as string)) throw new Error('AUTHORIZATION_OPTION_ID_DUPLICATE')
    ids.add(option.id as string)
    if (!codeExample(option.code_example))
      throw new Error('AUTHORIZATION_OPTION_CODE_EXAMPLE_REQUIRED')
    if (option.recommended) recommended += 1
  }
  if (recommended !== 1) throw new Error('AUTHORIZATION_RECOMMENDATION_INVALID')
}

/**
 * Validate custody ownership before ADMIT. New tooling binds its future execution to admitted
 * acceptance; existing tooling keeps its executable preflight evidence.
 * An empty inventory must carry evidence that no such artifact exists.
 */
export function assertArtifactCustody(payload: Item): void {
  const custody = object(payload.artifact_custody)
  if (!custody) throw new Error('ARTIFACT_CUSTODY_REQUIRED')
  if (!Array.isArray(custody.items)) throw new Error('ARTIFACT_CUSTODY_ITEMS_REQUIRED')
  if (!custody.items.length) {
    if (!texts(custody.absence_evidence))
      throw new Error('ARTIFACT_CUSTODY_ABSENCE_EVIDENCE_REQUIRED')
    return
  }
  const ids = new Set<string>(),
    paths = new Set<string>()
  for (const value of custody.items) {
    const item = object(value)
    if (
      !item ||
      !['id', 'path', 'protection_policy', 'install_mode'].every((field) => text(item[field])) ||
      !oneOf(ARTIFACT_KINDS, item.kind) ||
      !['generator_role', 'signer_role', 'installer_role', 'verifier_role'].every((field) =>
        oneOf(ARTIFACT_ROLES, item[field])
      ) ||
      // Only an independent Architect can verify a custody result.
      item.verifier_role !== 'architect' ||
      !oneOf(['NO_SECRET', 'SAME_ROLE_ONLY', 'FINAL_ARTIFACT_HANDOFF'], item.secret_flow)
    )
      throw new Error('ARTIFACT_CUSTODY_ITEM_INVALID')
    if (ids.has(item.id as string) || paths.has(item.path as string))
      throw new Error('ARTIFACT_CUSTODY_DUPLICATE')
    ids.add(item.id as string)
    paths.add(item.path as string)
    const installer = String(item.installer_role),
      signer = String(item.signer_role)
    if (ARTIFACT_INSTALL_MODES[installer] !== item.install_mode)
      throw new Error('ARTIFACT_CUSTODY_INSTALL_MODE_INVALID')
    // Approved protected artifacts keep signing and installation with one custodian.
    if (item.kind === 'APPROVED_PROTECTED' && signer !== 'none' && installer !== signer)
      throw new Error('ARTIFACT_CUSTODY_PROTECTED_INSTALLER_INVALID')
    // Crossing roles may transfer only the finished artifact, never signing secrets.
    if (signer !== 'none' && signer !== installer && item.secret_flow !== 'FINAL_ARTIFACT_HANDOFF')
      throw new Error('ARTIFACT_CUSTODY_SECRET_FLOW_INVALID')
    const check = object(item.execution_check)
    if (item.implementation_timing === 'IMPLEMENTATION_REQUIRED') {
      if (
        !check ||
        !text(check.method) ||
        !texts(item.acceptance_ids) ||
        !Array.isArray(payload.acceptance_ids) ||
        item.acceptance_ids.some((id) => !(payload.acceptance_ids as unknown[]).includes(id))
      )
        throw new Error('ARTIFACT_CUSTODY_ACCEPTANCE_REQUIRED')
      if (check.outcome !== undefined && check.outcome !== 'NOT_RUN')
        throw new Error('ARTIFACT_CUSTODY_PLANNED_RESULT_INVALID')
      continue
    }
    if (item.implementation_timing !== undefined && item.implementation_timing !== 'DESIGN_PROVEN')
      throw new Error('ARTIFACT_CUSTODY_TIMING_INVALID')
    if (!check || check.outcome !== 'PASS' || !text(check.method) || !texts(check.evidence))
      throw new Error('ARTIFACT_CUSTODY_EXECUTABILITY_REQUIRED')
  }
}

/** Terminal BLOCKED needs an enumerated non-user cause, evidence and a recovery condition. */
export function assertTerminalBlocker(payload: Item): void {
  // Budget observations cannot become terminal evidence by adding prose or a signature.
  if (['ROUND_BUDGET_EXHAUSTED', 'CONVERGENCE_LIMIT_EXHAUSTED'].includes(String(payload.reason)))
    throw new Error('BUDGET_EXHAUSTION_REQUIRES_USER_DECISION')
  if (
    !oneOf(TERMINAL_BLOCKER_REASONS, payload.reason) ||
    !text(payload.summary) ||
    !texts(payload.evidence) ||
    !text(payload.recovery_condition)
  )
    throw new Error('TERMINAL_BLOCKER_INVALID')
}

/**
 * Require the cheapest decision-flipping check for an Architect claim that changes a decision.
 * This is not a second QA pass: inspection methods must name why no rerun is needed.
 */
export function assertDecisionEvidenceReview(value: unknown): Item {
  const review = object(value)
  if (
    !review ||
    !texts(review.architect_claim_ids) ||
    !oneOf(DECISION_EVIDENCE.claimTypes, review.claim_type) ||
    !oneOf(DECISION_EVIDENCE.impacts, review.decision_impact) ||
    !oneOf(DECISION_EVIDENCE.methods, review.method) ||
    !text(review.decision_flip_condition) ||
    !oneOf(DECISION_EVIDENCE.results, review.result) ||
    !texts(review.evidence)
  )
    throw new Error('DECISION_EVIDENCE_REVIEW_INVALID')
  const inspection = oneOf(DECISION_EVIDENCE.inspectionMethods, review.method)
  if (inspection && !oneOf(DECISION_EVIDENCE.noRerunReasons, review.no_rerun_reason))
    throw new Error('DECISION_EVIDENCE_NO_RERUN_REASON_REQUIRED')
  if (!inspection && review.no_rerun_reason !== undefined && review.no_rerun_reason !== null)
    throw new Error('DECISION_EVIDENCE_NO_RERUN_REASON_FORBIDDEN')
  const method = String(review.method)
  const allowed: Readonly<Record<string, readonly string[]>> = {
    STATIC_FACT: DECISION_EVIDENCE.inspectionMethods,
    BEHAVIOR: ['TARGETED_REPRODUCTION', 'CANONICAL_ORACLE'],
    ROOT_CAUSE: ['COUNTERFACTUAL'],
    PROPOSED_ROUTE: ['COUNTERFACTUAL', 'CANONICAL_ORACLE']
  }
  const methods = allowed[String(review.claim_type)]
  if (methods && !methods.includes(method))
    throw new Error(`DECISION_EVIDENCE_${String(review.claim_type)}_METHOD_INVALID`)
  if (
    review.claim_type === 'ACCEPTANCE_VERDICT' &&
    method !== 'CANONICAL_ORACLE' &&
    !(inspection && review.no_rerun_reason === 'CANONICAL_ORACLE_ALREADY_INDEPENDENT')
  )
    throw new Error('DECISION_EVIDENCE_ACCEPTANCE_METHOD_INVALID')
  if (
    oneOf(DECISION_EVIDENCE.materialImpacts, review.decision_impact) &&
    review.result === 'INCONCLUSIVE'
  )
    throw new Error('DECISION_EVIDENCE_MATERIAL_RESULT_INCONCLUSIVE')
  return review
}

/** One Coordinator disposition per Finding; attempt accounting has its own dedicated command. */
export function assertFindingDecision(payload: Item): void {
  if (payload.action === 'attempt_completed') throw new Error('DEDICATED_EVENT_COMMAND_REQUIRED')
  if (
    !texts(payload.finding_ids) ||
    new Set(payload.finding_ids as string[]).size !== (payload.finding_ids as string[]).length ||
    !oneOf(FINDING_DECISIONS, payload.decision) ||
    !texts(payload.evidence)
  )
    throw new Error('FINDING_DECISION_INVALID')
  assertDecisionEvidenceReview(payload.evidence_review)
}
