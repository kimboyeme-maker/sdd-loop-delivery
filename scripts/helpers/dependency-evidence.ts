import { eventsWithId } from '../utils/event-index'
import { verifyCoordinatorProof } from '../resource/coordinator-evidence'
import { createHmac } from 'node:crypto'
import { assertRoleEvidence } from './role-evidence'
import {
  assertDependencyPlan,
  assertDependencyReview,
  assertDependencyDecision,
  dependencyPlanFingerprint
} from '../schemas/dependency-operation'
type Item = Record<string, unknown>

/** Resolve the exact operation from current signed admission or a direct Operator proposal. */
export function assertDependencyReviewPlan(
  state: Item,
  events: readonly Item[],
  review: Item,
  token: string | undefined
): void {
  assertDependencyReview(review)
  const plans = new Map<unknown, Item>()
  const admission = events.findLast((event) => {
    const { signature, ...body } = event
    return (
      event.type === 'contract_admission' &&
      event.role === 'coordinator' &&
      event.contract_revision === state.contract_revision &&
      event.authority_epoch === state.authority_epoch &&
      (event.payload as Item)?.decision === 'ADMIT' &&
      (event.coordinator_proof !== undefined
        ? verifyCoordinatorProof(state, event)
        : !!token &&
          signature === createHmac('sha256', token).update(JSON.stringify(body)).digest('hex'))
    )
  })
  const planned = (admission?.payload as Item | undefined)?.dependency_operation_plans
  if (Array.isArray(planned)) for (const plan of planned as Item[]) plans.set(plan.id, plan)
  for (const event of events) {
    if (
      event.role !== 'operator' ||
      event.type !== 'dependency_operation_proposal' ||
      event.contract_revision !== state.contract_revision
    )
      continue
    assertRoleEvidence(state, event, 'operator')
    const plan = event.payload as Item
    plans.set(plan.id, plan)
  }
  const plan = plans.get(review.plan_id)
  if (!plan || dependencyPlanFingerprint(plan) !== review.plan_fingerprint)
    throw new Error('DEPENDENCY_SAFETY_REVIEW_PLAN_BINDING_INVALID')
  assertDependencyPlan(plan)
}

/** Coordinator decisions reference a direct Architect review, never a copied summary. */
export function assertRecordedDependencyDecision(
  state: Item,
  events: readonly Item[],
  decision: Item,
  recording = true
): void {
  if (
    recording &&
    ![
      'CONTRACT_DRAFT',
      'CONTRACT_AMENDED',
      'OPERATOR_READBACK',
      'IMPLEMENTING',
      'COORDINATOR_TRIAGE'
    ].includes(String(state.phase))
  )
    throw new Error('COORDINATOR_DEPENDENCY_DECISION_STATE_INVALID')
  const matching = eventsWithId(events, decision.review_event_id)
  const review = matching[0]
  if (
    matching.length !== 1 ||
    !review ||
    review.role !== 'architect' ||
    review.type !== 'dependency_safety_review'
  )
    throw new Error('COORDINATOR_DEPENDENCY_REVIEW_REFERENCE_INVALID')
  assertRoleEvidence(state, review, 'architect')
  assertDependencyDecision(decision, review.payload as Item)
}
