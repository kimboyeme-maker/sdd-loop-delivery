import { parseEvents } from '../resource/store/event-log'
import { findLease } from '../helpers/lease-slots'
import { roleCapabilityToken } from '../resource/role-capability'
import { verifyCoordinatorProof } from '../resource/coordinator-evidence'
import { createHash, createHmac } from 'node:crypto'
import { readSnapshot } from '../resource/state'
import { assertCurrentSource } from '../helpers/source-binding'
import { assertActiveLease } from '../domain/policies/active-lease'
import { currentAdmission } from '../helpers/admission-authority'
import { assertRoleEvidence } from '../helpers/role-evidence'
import { assertDependencyPlan, dependencyPlanFingerprint } from '../schemas/dependency-operation'
import { assertRecordedDependencyDecision } from '../helpers/dependency-evidence'
import { requireGuidanceAck } from '../helpers/guidance-ack'
import { assertStartedEvidence } from '../helpers/started-evidence'
import { normalizeOwner, type OwnerMapping } from '../domain/policies/scope'
type Item = Record<string, unknown>
export type ActionRequest = {
  sdd: string
  expectedState: string
  expectedRevision: string
  agent: string
  agentId: string
  leaseId: string
  actionKind: string
  affectedPackages: string[]
  commandClass: string
  dependencyEffect: string
  planId?: string | undefined
}

/** Authorize a described action without executing it or claiming host interception.
 * Trusted adapters must supply the real action effects; the controller cannot
 * infer command mutability from a path or enforce direct shell activity itself.
 */
export function preActionGate(
  request: ActionRequest,
  agentToken?: string,
  coordinatorToken = process.env.SDD_LOOP_COORDINATOR_TOKEN
): Item {
  const { state, eventText } = readSnapshot(request.sdd)
  assertCurrentSource(state, request.sdd)
  if (state.phase !== request.expectedState) throw new Error('EXPECTED_STATE_MISMATCH')
  if (state.contract_revision !== request.expectedRevision)
    throw new Error('EXPECTED_REVISION_MISMATCH')
  if (['SHIP', 'BLOCKED', 'CANCELLED', 'PAUSED'].includes(String(state.phase)))
    throw new Error('PRE_ACTION_STATE_FORBIDDEN')
  const lease = findLease(state as Item, request.leaseId) ?? null
  if (
    !lease ||
    lease.agent_id !== request.agentId ||
    lease.lease_id !== request.leaseId ||
    lease.role !== request.agent
  )
    throw new Error('AGENT_LEASE_MISMATCH')
  const credential = agentToken ?? roleCapabilityToken(lease)
  if (createHash('sha256').update(credential).digest('hex') !== lease.agent_token_hash)
    throw new Error('AGENT_TOKEN_INVALID')
  assertActiveLease(state, lease)
  if (!lease.started_event_id) throw new Error('PRE_ACTION_AGENT_NOT_STARTED')
  const events = parseEvents(eventText)
  assertStartedEvidence(state, lease, events)
  if (!['read', 'write', 'delegate', 'unknown'].includes(request.actionKind))
    throw new Error('ACTION_KIND_INVALID')
  if (
    ![
      'NONE',
      'READ_ONLY',
      'REPRODUCIBLE_MATERIALIZATION',
      'WORKSPACE_RESOLUTION_MUTATION',
      'DEPENDENCY_CONTRACT_MUTATION',
      'EXTERNAL_PACKAGE_ACTION'
    ].includes(request.dependencyEffect)
  )
    throw new Error('DEPENDENCY_EFFECT_INVALID')
  const affected = [...new Set(request.affectedPackages)].sort()
  if (affected.some((item) => typeof item !== 'string' || !item.trim()))
    throw new Error('AFFECTED_PACKAGE_INVALID')
  const result = (decision: string, reason: string): Item => ({
    protocol: 'pre-action/v1',
    decision,
    reason,
    contract_revision: state.contract_revision,
    role: lease.role,
    agent_id: lease.agent_id,
    lease_id: lease.lease_id,
    packet_id: lease.packet_id ?? null,
    action_kind: request.actionKind,
    affected_packages: affected,
    command_class: request.commandClass,
    dependency_effect: request.dependencyEffect,
    plan_id: request.planId ?? null
  })
  const deny = (reason: string): never => {
    throw new Error(`PRE_ACTION_DENIED: ${JSON.stringify(result('DENY', reason))}`)
  }
  if (request.actionKind === 'read' && ['NONE', 'READ_ONLY'].includes(request.dependencyEffect))
    return result('ALLOW', 'READ_ONLY')
  if (request.dependencyEffect === 'READ_ONLY') deny('READ_ONLY_EFFECT_REQUIRES_READ_ACTION')
  if (lease.repair_probe_root) deny('PIPELINE_PROBE_FORBIDS_MUTATION')
  if (request.actionKind === 'delegate') deny('ROLE_DELEGATION_FORBIDDEN')
  if (request.actionKind === 'unknown') deny('MUTABILITY_UNPROVEN')
  if (lease.role === 'architect') deny('ARCHITECT_REPOSITORY_WRITE_FORBIDDEN')
  if (!affected.length) deny('WRITE_TARGET_UNPROVEN')
  const allowed = lease.scope
  if (!Array.isArray(allowed) || !allowed.length) deny('LEASE_MODIFICATION_SCOPE_UNAVAILABLE')
  const mappings =
    (lease.worktree_baseline as { owners?: OwnerMapping[] } | undefined)?.owners ?? []
  const authorized = (allowed as string[]).map((item) => normalizeOwner(item, mappings))
  if (affected.some((item) => !authorized.includes(normalizeOwner(item, mappings))))
    deny('PACKAGE_OUTSIDE_MODIFICATION_AUTHORITY')
  requireGuidanceAck(state, events, lease, coordinatorToken)
  const admission = currentAdmission(state, events, coordinatorToken).payload as Item
  if (request.dependencyEffect !== 'NONE') {
    const plans = new Map<unknown, Item>()
    if (Array.isArray(admission.dependency_operation_plans))
      for (const plan of admission.dependency_operation_plans as Item[]) plans.set(plan.id, plan)
    for (const event of events) {
      if (
        event.type !== 'dependency_operation_proposal' ||
        event.role !== 'operator' ||
        event.contract_revision !== state.contract_revision
      )
        continue
      assertRoleEvidence(state, event, 'operator')
      const plan = event.payload as Item
      plans.set(plan.id, plan)
    }
    const plan = plans.get(request.planId)
    if (!plan) deny('DEPENDENCY_OPERATION_PLAN_REQUIRED')
    assertDependencyPlan(plan!)
    if (
      plan!.dependency_effect !== request.dependencyEffect ||
      plan!.command_class !== request.commandClass ||
      affected.some((name) => !(plan!.affected_packages as string[]).includes(name))
    )
      deny('DEPENDENCY_OPERATION_ENVELOPE_MISMATCH')
    if (
      [
        'WORKSPACE_RESOLUTION_MUTATION',
        'DEPENDENCY_CONTRACT_MUTATION',
        'EXTERNAL_PACKAGE_ACTION'
      ].includes(request.dependencyEffect)
    ) {
      const fingerprint = dependencyPlanFingerprint(plan!)
      const decision = events.findLast((event) => {
        const payload = event.payload as Item | undefined
        return (
          event.type === 'coordinator_dependency_decision' &&
          event.role === 'coordinator' &&
          event.contract_revision === state.contract_revision &&
          event.authority_epoch === state.authority_epoch &&
          payload?.plan_id === request.planId &&
          payload?.plan_fingerprint === fingerprint
        )
      })
      if (!decision) deny('DEPENDENCY_SAFETY_CLOSURE_REQUIRED')
      const { signature, ...body } = decision!
      if (
        decision!.coordinator_proof !== undefined
          ? !verifyCoordinatorProof(state, decision!)
          : !coordinatorToken ||
            signature !==
              createHmac('sha256', coordinatorToken).update(JSON.stringify(body)).digest('hex')
      )
        deny('DEPENDENCY_SAFETY_CLOSURE_REQUIRED')
      // A newer review can reopen the plan; an older approval cannot silently supersede it.
      const review = events.findLast(
        (event) =>
          event.type === 'dependency_safety_review' &&
          event.role === 'architect' &&
          event.contract_revision === state.contract_revision &&
          (event.payload as Item | undefined)?.plan_id === request.planId &&
          (event.payload as Item | undefined)?.plan_fingerprint === fingerprint
      )
      if (
        !review ||
        (decision!.payload as Item).review_event_id !== review.event_id ||
        events.indexOf(decision!) <= events.indexOf(review)
      )
        deny('DEPENDENCY_SAFETY_CLOSURE_REQUIRED')
      assertRecordedDependencyDecision(state, events, decision!.payload as Item, false)
      if ((decision!.payload as Item).decision !== 'APPROVE')
        deny('DEPENDENCY_OPERATION_NOT_APPROVED')
    }
  }
  return result('ALLOW', 'WITHIN_MODIFICATION_AUTHORITY')
}
