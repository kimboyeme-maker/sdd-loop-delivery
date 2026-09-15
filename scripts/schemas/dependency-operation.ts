import { createHash } from 'node:crypto'
import { canonicalJson } from '../resource/wire/canonical-json'
type Item = Record<string, unknown>
const object = (value: unknown): Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {}
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const list = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const nonempty = (value: unknown): value is string[] => list(value) && value.length > 0

/** Fingerprint the exact approved operation, not merely its command label. */
export function dependencyPlanFingerprint(plan: Item): string {
  return createHash('sha256').update(canonicalJson(plan)).digest('hex')
}

/** Validate effect, expected writes and recovery before a dependency operation is reviewed. */
export function assertDependencyPlan(plan: Item): void {
  for (const field of ['id', 'command_class'])
    if (!text(plan[field]))
      throw new Error(`DEPENDENCY_OPERATION_PLAN_${field.toUpperCase()}_REQUIRED`)
  if (
    ![
      'READ_ONLY',
      'REPRODUCIBLE_MATERIALIZATION',
      'WORKSPACE_RESOLUTION_MUTATION',
      'DEPENDENCY_CONTRACT_MUTATION',
      'EXTERNAL_PACKAGE_ACTION'
    ].includes(String(plan.dependency_effect))
  )
    throw new Error('DEPENDENCY_OPERATION_EFFECT_INVALID')
  for (const field of [
    'exact_commands',
    'expected_writes',
    'affected_packages',
    'lifecycle_scripts',
    'postconditions',
    'stability_checks',
    'stop_conditions'
  ])
    if (!list(plan[field]))
      throw new Error(`DEPENDENCY_OPERATION_PLAN_${field.toUpperCase()}_INVALID`)
  if (!nonempty(plan.exact_commands) || !nonempty(plan.affected_packages))
    throw new Error('DEPENDENCY_OPERATION_PLAN_SCOPE_REQUIRED')
  const baseline = object(plan.baseline),
    recovery = object(plan.recovery)
  for (const field of [
    'manifest_fingerprint',
    'lockfile_fingerprint',
    'workspace_link_fingerprint',
    'critical_resolution_fingerprint',
    'dirty_worktree_fingerprint'
  ])
    if (!text(baseline[field]))
      throw new Error(`DEPENDENCY_OPERATION_BASELINE_${field.toUpperCase()}_REQUIRED`)
  for (const field of ['interrupt_oom_partial_failure', 'inputs_available', 'restore_method'])
    if (!text(recovery[field]))
      throw new Error(`DEPENDENCY_OPERATION_RECOVERY_${field.toUpperCase()}_REQUIRED`)
  if (recovery.dirty_worktree_policy !== 'PRESERVE_USER_DIRTY_WORK')
    throw new Error('DEPENDENCY_OPERATION_DIRTY_WORK_POLICY_INVALID')
  if (
    plan.dependency_effect === 'EXTERNAL_PACKAGE_ACTION' &&
    !nonempty(plan.external_authority_evidence)
  )
    throw new Error('DEPENDENCY_OPERATION_EXTERNAL_AUTHORITY_REQUIRED')
}

/** A dependency review advises on the referenced plan; it grants no execution authority. */
export function assertDependencyReview(review: Item): void {
  if (!['ADVISE_PASS', 'CHALLENGE'].includes(String(review.result)))
    throw new Error('DEPENDENCY_SAFETY_REVIEW_RESULT_INVALID')
  for (const field of ['plan_id', 'plan_fingerprint'])
    if (!text(review[field]))
      throw new Error(`DEPENDENCY_SAFETY_REVIEW_${field.toUpperCase()}_REQUIRED`)
  for (const field of ['risks', 'alternatives', 'counterexamples', 'challenges'])
    if (!Array.isArray(review[field]))
      throw new Error(`DEPENDENCY_SAFETY_REVIEW_${field.toUpperCase()}_REQUIRED`)
  if (review.result === 'CHALLENGE' && !(review.challenges as unknown[]).length)
    throw new Error('DEPENDENCY_SAFETY_REVIEW_CHALLENGE_REQUIRED')
  for (const entry of review.challenges as unknown[]) {
    const item = object(entry)
    if (!text(item.id) || !text(item.claim) || !nonempty(item.evidence))
      throw new Error('DEPENDENCY_SAFETY_REVIEW_CHALLENGE_INVALID')
  }
  if (
    review.replacement_route_proposed !== undefined &&
    typeof review.replacement_route_proposed !== 'boolean'
  )
    throw new Error('DEPENDENCY_SAFETY_REVIEW_REPLACEMENT_ROUTE_INVALID')
}

/** Require challenge-by-challenge closure before accepting the Coordinator decision. */
export function assertDependencyDecision(decision: Item, review: Item): void {
  if (!['APPROVE', 'REVISE', 'REJECT'].includes(String(decision.decision)))
    throw new Error('COORDINATOR_DEPENDENCY_DECISION_INVALID')
  for (const field of ['plan_id', 'plan_fingerprint', 'review_event_id'])
    if (!text(decision[field]))
      throw new Error(`COORDINATOR_DEPENDENCY_${field.toUpperCase()}_REQUIRED`)
  if (!nonempty(decision.evidence)) throw new Error('COORDINATOR_DEPENDENCY_EVIDENCE_REQUIRED')
  if (!Array.isArray(decision.challenge_closures))
    throw new Error('COORDINATOR_DEPENDENCY_CHALLENGE_CLOSURES_REQUIRED')
  for (const entry of decision.challenge_closures) {
    const item = object(entry)
    if (!text(item.challenge_id) || !nonempty(item.evidence))
      throw new Error('COORDINATOR_DEPENDENCY_CHALLENGE_CLOSURE_INVALID')
  }
  if (
    decision.replacement_route_adopted !== undefined &&
    typeof decision.replacement_route_adopted !== 'boolean'
  )
    throw new Error('COORDINATOR_DEPENDENCY_REPLACEMENT_ROUTE_INVALID')
  assertDependencyReview(review)
  if (decision.plan_id !== review.plan_id || decision.plan_fingerprint !== review.plan_fingerprint)
    throw new Error('COORDINATOR_DEPENDENCY_REVIEW_BINDING_INVALID')
  const required = new Set((review.challenges as Item[]).map((item) => item.id))
  const closed = new Set((decision.challenge_closures as Item[]).map((item) => item.challenge_id))
  if (
    review.result === 'CHALLENGE' &&
    (required.size !== closed.size || [...required].some((id) => !closed.has(id)))
  )
    throw new Error('COORDINATOR_DEPENDENCY_CHALLENGE_CLOSURE_INVALID')
  if (decision.replacement_route_adopted && !review.replacement_route_proposed)
    throw new Error('COORDINATOR_DEPENDENCY_REPLACEMENT_ROUTE_UNPROPOSED')
}
