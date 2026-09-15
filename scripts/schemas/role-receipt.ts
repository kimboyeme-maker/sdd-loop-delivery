type Item = Record<string, unknown>
const object = (value: unknown): Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {}
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const nonempty = (value: unknown): value is string[] => texts(value) && value.length > 0
const empty = (value: unknown): boolean => Array.isArray(value) && value.length === 0
const RESULTS = ['PASS', 'FAIL', 'NOT_RUN', 'INCONCLUSIVE', 'INCONCLUSIVE_ENVIRONMENT']

/** Packet claims describe scope; signed admission supplies their authority. */
function packets(payload: Item): void {
  if (!nonempty(payload.execution_packet_ids)) throw new Error('EXECUTION_PACKET_CLAIM_REQUIRED')
}

/** A clean review still needs explicit evidence, not just an empty conflict list. */
function ownership(payload: Item, clean: boolean): void {
  const review = object(payload.semantic_ownership_review)
  if (!nonempty(review.semantic_ids) || !nonempty(review.evidence))
    throw new Error('SEMANTIC_OWNERSHIP_REVIEW_REQUIRED')
  if (!texts(review.unresolved_conflicts))
    throw new Error('SEMANTIC_OWNERSHIP_REVIEW_CONFLICTS_INVALID')
  if (clean && review.unresolved_conflicts.length)
    throw new Error('SEMANTIC_OWNERSHIP_REVIEW_NOT_CLEAN')
}

/** Validate bounded candidate integrity claims; handoff separately binds their scope to admission. */
export function assertCandidateReceipt(value: unknown): void {
  const receipt = object(value)
  if (!Object.keys(receipt).length) throw new Error('OPERATOR_CANDIDATE_RECEIPT_REQUIRED')
  const oracle = object(receipt.oracle_sensitivity)
  if (
    !['PASS', 'NOT_APPLICABLE'].includes(String(oracle.status)) ||
    !texts(oracle.acceptance_ids) ||
    !nonempty(oracle.evidence)
  )
    throw new Error('OPERATOR_ORACLE_SENSITIVITY_RECEIPT_INVALID')
  const environment = object(receipt.environment_integrity)
  if (
    environment.status !== 'PASS' ||
    !text(environment.before_fingerprint) ||
    !text(environment.after_fingerprint) ||
    !empty(environment.unexpected_drift) ||
    !nonempty(environment.evidence)
  )
    throw new Error('OPERATOR_ENVIRONMENT_INTEGRITY_RECEIPT_INVALID')
  const scope = object(receipt.modification_scope)
  if (
    scope.status !== 'PASS' ||
    !texts(scope.changed_packages) ||
    !texts(scope.changed_paths) ||
    !!scope.changed_packages.length !== !!scope.changed_paths.length ||
    !empty(scope.unauthorized_changes) ||
    !nonempty(scope.evidence)
  )
    throw new Error('OPERATOR_MODIFICATION_SCOPE_RECEIPT_INVALID')
}

/** Validate migrated role payload fields before any signed event is appended.
 * Structural validity does not prove implementation, oracle execution, or host facts.
 * Source, candidate, lease and admission bindings remain in their shared consumers.
 */
export function assertRoleReceipt(type: string, payload: Item): void {
  if (type === 'implementation_escalation') {
    for (const field of [
      'invalidated_assumptions',
      'observed_evidence',
      'causal_expansion',
      'safe_checkpoint'
    ])
      if (!nonempty(payload[field]))
        throw new Error(`IMPLEMENTATION_ESCALATION_${field.toUpperCase()}_REQUIRED`)
    packets(payload)
  }
  if (type === 'contract_readback') {
    if (!['ACCEPT', 'CHALLENGE', 'BLOCKED'].includes(String(payload.assessment)))
      throw new Error('READBACK_ASSESSMENT_INVALID')
    if (!['SUPPORTED', 'CHALLENGED', 'BLOCKED'].includes(String(payload.route_assessment)))
      throw new Error('READBACK_ROUTE_ASSESSMENT_INVALID')
    for (const field of ['independent_checks', 'unresolved_unknowns'])
      if (!Array.isArray(payload[field]))
        throw new Error(`READBACK_${field.toUpperCase()}_REQUIRED`)
    if (payload.assessment === 'ACCEPT') {
      if (
        payload.route_assessment !== 'SUPPORTED' ||
        !nonempty(payload.independent_checks) ||
        !empty(payload.unresolved_unknowns)
      )
        throw new Error('READBACK_ACCEPT_REQUIRES_SUPPORTED_ROUTE')
      ownership(payload, true)
      packets(payload)
    }
  }
  if (type === 'implementation') {
    packets(payload)
    if (!texts(payload.changed_packages))
      throw new Error('IMPLEMENTATION_CHANGED_PACKAGES_REQUIRED')
  }
  if (type === 'self_check') {
    if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(String(payload.result)))
      throw new Error('SELF_CHECK_RESULT_INVALID')
    if (!['READY_FOR_ARCHITECT', 'NOT_READY', 'BLOCKED'].includes(String(payload.handoff_status)))
      throw new Error('SELF_CHECK_HANDOFF_INVALID')
    // Test evidence is cited by controller-measured test_run event IDs, never self-reported timings.
    if (
      payload.test_run_event_ids !== undefined &&
      (!Array.isArray(payload.test_run_event_ids) ||
        payload.test_run_event_ids.some((id) => typeof id !== 'string' || !id) ||
        new Set(payload.test_run_event_ids).size !== payload.test_run_event_ids.length)
    )
      throw new Error('SELF_CHECK_TEST_RUNS_INVALID')
    if (payload.handoff_status === 'READY_FOR_ARCHITECT') {
      if (payload.result !== 'PASS') throw new Error('READY_FOR_ARCHITECT_REQUIRES_PASS')
      ownership(payload, true)
      packets(payload)
      assertCandidateReceipt(payload.candidate_receipt)
      // Whether runs are required depends on the admitted packet budget, checked at recording.
      if (!Array.isArray(payload.test_run_event_ids))
        throw new Error('SELF_CHECK_TEST_RUNS_REQUIRED')
    }
  }
  if (type === 'finding') {
    if (
      !text(payload.id) ||
      !text(payload.summary) ||
      !['P0', 'P1', 'P2', 'P3'].includes(String(payload.priority)) ||
      !['affected_packages', 'requirement_ids', 'acceptance_ids'].every((field) =>
        nonempty(payload[field])
      )
    )
      throw new Error('FINDING_PAYLOAD_INVALID')
  }
  if (type === 'verification') {
    if (!RESULTS.includes(String(payload.result))) throw new Error('VERIFICATION_RESULT_INVALID')
    for (const field of ['requirement_ids', 'acceptance_ids'])
      if (!nonempty(payload[field])) throw new Error(`VERIFICATION_${field.toUpperCase()}_REQUIRED`)
    if (!Array.isArray(payload.checks) || !payload.checks.length)
      throw new Error('VERIFICATION_CHECKS_REQUIRED')
    if (!texts(payload.changed_packages)) throw new Error('VERIFICATION_CHANGED_PACKAGES_INVALID')
    for (const value of payload.checks) {
      const check = object(value)
      if (
        !['method', 'environment', 'oracle', 'outcome'].every((field) => text(check[field])) ||
        !nonempty(check.acceptance_ids) ||
        !nonempty(check.packages)
      )
        throw new Error('VERIFICATION_CHECK_SCHEMA_INVALID')
      if (check.acceptance_ids.some((id) => !(payload.acceptance_ids as string[]).includes(id)))
        throw new Error('VERIFICATION_CHECK_ACCEPTANCE_SCOPE_INVALID')
      if (payload.result === 'PASS' && check.outcome !== 'PASS')
        throw new Error('VERIFICATION_PASS_CONTAINS_NON_PASS_CHECK')
    }
    if (payload.result === 'INCONCLUSIVE_ENVIRONMENT') {
      const environment = object(payload.environment_fingerprint)
      for (const field of [
        'source_fingerprint',
        'lockfile_fingerprint',
        'tool_runtime_version',
        'workspace_link_fingerprint',
        'resolver_mode'
      ])
        if (!text(environment[field]))
          throw new Error(`ENVIRONMENT_FINGERPRINT_${field.toUpperCase()}_REQUIRED`)
      if (!nonempty(payload.environment_drift_evidence))
        throw new Error('VERIFICATION_ENVIRONMENT_DRIFT_EVIDENCE_REQUIRED')
    }
    ownership(payload, payload.result === 'PASS')
    packets(payload)
  }
  if (type === 'checkpoint') {
    if (!['SAFE_TO_RESUME', 'UNSAFE_PARTIAL'].includes(String(payload.status)))
      throw new Error('CHECKPOINT_STATUS_INVALID')
    for (const field of ['completed_actions', 'remaining_actions', 'active_commands'])
      if (!texts(payload[field])) throw new Error(`CHECKPOINT_${field.toUpperCase()}_INVALID`)
    if (!nonempty(payload.remaining_actions))
      throw new Error('CHECKPOINT_REMAINING_ACTIONS_REQUIRED')
    const repository = object(payload.repository_state)
    if (
      !text(repository.head) ||
      typeof repository.worktree_fingerprint !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(repository.worktree_fingerprint) ||
      !texts(repository.changed_paths) ||
      !texts(repository.untracked_paths)
    )
      throw new Error('CHECKPOINT_REPOSITORY_STATE_INVALID')
    const check = object(payload.last_check),
      resume = object(payload.resume)
    if (
      !['method', 'outcome', 'evidence'].every((field) => text(check[field])) ||
      !RESULTS.includes(String(check.outcome))
    )
      throw new Error('CHECKPOINT_LAST_CHECK_INVALID')
    if (
      !text(resume.next_action) ||
      !nonempty(resume.preconditions) ||
      !nonempty(resume.stop_conditions)
    )
      throw new Error('CHECKPOINT_RESUME_INSTRUCTIONS_INVALID')
    if (payload.status === 'SAFE_TO_RESUME' && (payload.active_commands as string[]).length)
      throw new Error('SAFE_CHECKPOINT_HAS_ACTIVE_COMMANDS')
  }
}
