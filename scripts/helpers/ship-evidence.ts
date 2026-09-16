import { eventsWithId, lastIndexOfType } from '../utils/event-index'
import { verifyCoordinatorProof } from '../resource/coordinator-evidence'
import { assertVerificationReviewer } from './verification-reviewer'
import { assertExecutionBindings } from './execution-bindings'
import { currentAdmission } from './admission-authority'
import { assertRoleReceipt } from '../schemas/role-receipt'
import { assertContractDeferral } from './contract-deferral'
import { createHmac } from 'node:crypto'
import { assertRoleEvidence } from './role-evidence'
import { assertWorktreeCandidate } from './worktree-candidate'
import { assertShip, type ShipRequirement } from '../domain/policies/ship'
import { assertOracleSensitivity } from '../domain/policies/oracle-insensitivity'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('SHIP_EVIDENCE_INVALID')
  return value as Record<string, unknown>
}

/** Final transition guard. Signed role results must cover the latest candidate, effective requirements, and each linked acceptance. */
export function assertShipEvidence(
  state: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
  coordinatorToken: string,
  sdd: string
): void {
  if (state.pending_user_decision != null) throw new Error('SHIP_USER_DECISION_PENDING')
  if (state.pending_pipeline_repair != null || state.pending_execution_failure != null)
    throw new Error('SHIP_RECOVERY_PENDING')
  const ids = events.map((event) => event.event_id).filter((id) => id !== undefined)
  if (new Set(ids).size !== ids.length) throw new Error('SHIP_EVENT_IDS_AMBIGUOUS')
  const implementationIndex = lastIndexOfType(events, 'implementation')
  const verificationIndex = lastIndexOfType(events, 'verification')
  if (implementationIndex < 0 || verificationIndex <= implementationIndex)
    throw new Error('SHIP_FINAL_VERIFICATION_REQUIRED')
  const implementation = events[implementationIndex]!
  // Sharded final verification ships on every shard verdict together; otherwise on the latest.
  const shardVerdictIds = Object.values(
    state.final_shard_verdicts == null ? {} : record(state.final_shard_verdicts)
  ).filter((id): id is string => typeof id === 'string')
  const verificationEvents = shardVerdictIds.length
    ? shardVerdictIds.map((id) => {
        const matches = eventsWithId(events, id)
        if (matches.length !== 1 || events.indexOf(matches[0]!) <= implementationIndex)
          throw new Error('SHIP_FINAL_VERIFICATION_REQUIRED')
        return matches[0]!
      })
    : [events[verificationIndex]!]
  assertRoleEvidence(state, implementation, 'operator')
  // A claim the contract says cannot hold yet must not already measure green.
  assertOracleSensitivity(record(state.contract), events)
  const candidate = record(record(implementation.payload).candidate)
  for (const verification of verificationEvents) {
    assertVerificationReviewer(state, events, verification)
    const result = record(verification.payload)
    for (const field of [
      'candidate_id',
      'environment_fingerprint',
      'manifest_sha256',
      'worktree_fingerprint'
    ]) {
      if (
        typeof candidate[field] !== 'string' ||
        !(candidate[field] as string).trim() ||
        result[field] !== candidate[field]
      )
        throw new Error('SHIP_CANDIDATE_BINDING_MISMATCH')
    }
  }
  const implementationLease = record(
    record(state.issued_leases)[String(record(implementation.actor).lease_id)]
  )
  assertWorktreeCandidate(sdd, implementationLease, candidate)
  for (const verification of verificationEvents) {
    const result = record(verification.payload)
    const actor = record(verification.actor)
    const lease = record(record(state.issued_leases)[String(actor.lease_id)])
    assertRoleReceipt('verification', result)
    assertExecutionBindings(
      state,
      record(state.contract),
      lease,
      result,
      events,
      record(currentAdmission(state, events, coordinatorToken).payload)
    )
    if (
      lease.dispatch_phase !== 'FINAL_VERIFY' ||
      lease.verification_mode === 'design-counsel' ||
      result.result !== 'PASS'
    )
      throw new Error('SHIP_FINAL_VERIFICATION_REQUIRED')
    if (record(implementation.actor).agent_id === actor.agent_id)
      throw new Error('SHIP_REVIEWER_NOT_INDEPENDENT')
    if (
      events
        .slice(events.indexOf(verification) + 1)
        .some((event) =>
          [
            'timeout_decision',
            'pipeline_incident',
            'amend',
            'contract_amendment',
            'verification_revoked'
          ].includes(String(event.type))
        )
    )
      throw new Error('SHIP_EVIDENCE_INVALIDATED')
  }
  const union = (field: string): string[] => [
    ...new Set(
      verificationEvents.flatMap((event) => {
        const value = record(event.payload)[field]
        return Array.isArray(value) ? (value as string[]) : []
      })
    )
  ]
  const verdict: Record<string, unknown> =
    verificationEvents.length === 1
      ? record(verificationEvents[0]!.payload)
      : {
          ...record(verificationEvents[0]!.payload),
          requirement_ids: union('requirement_ids'),
          acceptance_ids: union('acceptance_ids')
        }
  const findings = state.findings === undefined ? {} : record(state.findings)
  if (Object.values(findings).some((value) => record(value).status !== 'resolved'))
    throw new Error('SHIP_FINDINGS_OPEN')
  const statuses = record(state.requirements)
  const kinds = record(state.requirement_kinds)
  // Runtime maps are projections, not authority to remove or downgrade contract obligations.
  if (state.contract === undefined) throw new Error('SHIP_CONTRACT_REQUIRED')
  {
    const contract = record(state.contract)
    if (!Array.isArray(contract.requirements) || !contract.requirements.length)
      throw new Error('SHIP_CONTRACT_REQUIREMENTS_INVALID')
    const contractIds = new Set<string>()
    for (const value of contract.requirements) {
      const requirement = record(value)
      const id = requirement.id
      if (
        typeof id !== 'string' ||
        !id.trim() ||
        contractIds.has(id) ||
        !['must-ship', 'should', 'non-goal'].includes(String(requirement.kind))
      )
        throw new Error('SHIP_CONTRACT_REQUIREMENTS_INVALID')
      contractIds.add(id)
      if (!Object.hasOwn(statuses, id) || kinds[id] !== requirement.kind)
        throw new Error('SHIP_REQUIREMENT_PROJECTION_MISMATCH')
    }
    if (
      Object.keys(statuses).some((id) => !contractIds.has(id)) ||
      Object.keys(kinds).some((id) => !contractIds.has(id))
    )
      throw new Error('SHIP_REQUIREMENT_PROJECTION_MISMATCH')
  }
  if (
    Object.entries(kinds).some(([id, kind]) => kind === 'must-ship' && !Object.hasOwn(statuses, id))
  )
    throw new Error('SHIP_REQUIREMENT_STATUS_MISSING')
  const requirements: ShipRequirement[] = Object.entries(statuses).map(([id, status]) => {
    if (typeof kinds[id] !== 'string' || typeof status !== 'string')
      throw new Error('SHIP_REQUIREMENT_METADATA_MISSING')
    const result: ShipRequirement = {
      id,
      kind: kinds[id] as string,
      status,
      candidateId: String(candidate.candidate_id)
    }
    if (status !== 'deferred') return result
    const decision = events.findLast(
      (event) => event.type === 'requirement_status' && record(event.payload).id === id
    )
    if (!decision) throw new Error('SHIP_DEFERRAL_EVIDENCE_REQUIRED')
    const { signature, ...body } = decision
    if (
      decision.role !== 'coordinator' ||
      decision.contract_revision !== state.contract_revision ||
      (decision.coordinator_proof !== undefined
        ? !verifyCoordinatorProof(state, decision)
        : !coordinatorToken ||
          signature !==
            createHmac('sha256', coordinatorToken).update(JSON.stringify(body)).digest('hex'))
    )
      throw new Error('SHIP_DEFERRAL_EVIDENCE_REQUIRED')
    const data = record(decision.payload),
      deferred = record(data.deferred)
    if (data.status !== 'deferred') throw new Error('SHIP_DEFERRAL_EVIDENCE_REQUIRED')
    assertContractDeferral(state.contract, id, deferred)
    return {
      ...result,
      deferred: {
        owner: deferred.owner as string,
        trigger: deferred.trigger as string,
        impact: deferred.impact as string,
        approvedBy: deferred.approved_by as string
      }
    }
  })
  assertShip(requirements, String(candidate.candidate_id))
  const evidence = record(state.requirement_evidence)
  for (const requirement of requirements) {
    if (requirement.kind !== 'must-ship' || requirement.status === 'deferred') continue
    const matches = eventsWithId(events, evidence[requirement.id])
    const event = matches[0]
    if (matches.length !== 1 || !event || event.type !== 'verification')
      throw new Error('SHIP_REQUIREMENT_EVIDENCE_REQUIRED')
    assertVerificationReviewer(state, events, event)
    const result = record(event.payload)
    if (
      result.result !== 'PASS' ||
      !Array.isArray(result.requirement_ids) ||
      !result.requirement_ids.includes(requirement.id)
    )
      throw new Error('SHIP_REQUIREMENT_EVIDENCE_REQUIRED')
  }
  if (
    !Array.isArray(verdict.requirement_ids) ||
    verdict.requirement_ids.some((id) => typeof id !== 'string') ||
    requirements.some(
      (req) =>
        req.kind === 'must-ship' &&
        req.status !== 'deferred' &&
        !(verdict.requirement_ids as unknown[]).includes(req.id)
    )
  )
    throw new Error('SHIP_FINAL_COVERAGE_INCOMPLETE')
  assertAcceptanceCoverage(record(state.contract), requirements, verdict)
  // New custody tooling must have independent final evidence, including items admitted in
  // earlier slices of this revision. A later narrow admission cannot silently drop them.
  for (const event of events) {
    if (event.type !== 'contract_admission' || event.contract_revision !== state.contract_revision)
      continue
    const admission = record(event.payload)
    if (admission.decision !== 'ADMIT' || !admission.artifact_custody) continue
    for (const value of record(admission.artifact_custody).items as unknown[]) {
      const item = record(value)
      if (item.implementation_timing !== 'IMPLEMENTATION_REQUIRED') continue
      const contractRequirements = record(state.contract).requirements as Record<string, unknown>[]
      const deferred = (id: unknown): boolean => {
        const owners = contractRequirements.filter(
          (req) => Array.isArray(req.acceptance) && req.acceptance.includes(id)
        )
        // Deferral authority and metadata were checked above; no owners is not an exemption.
        return owners.length > 0 && owners.every((req) => statuses[String(req.id)] === 'deferred')
      }
      if (
        !Array.isArray(item.acceptance_ids) ||
        !item.acceptance_ids.length ||
        item.acceptance_ids.some(
          (id) => !(verdict.acceptance_ids as unknown[]).includes(id) && !deferred(id)
        )
      )
        throw new Error('SHIP_ARTIFACT_CUSTODY_UNVERIFIED')
    }
  }
}

/** Resolve acceptance obligations from the contract, never from a runtime status summary.
 * Deferred requirements are excluded only after the signed deferral gate has passed.
 */
function assertAcceptanceCoverage(
  contract: Record<string, unknown>,
  requirements: readonly ShipRequirement[],
  verdict: Record<string, unknown>
): void {
  const effective = requirements.filter(
    (req) => req.kind === 'must-ship' && req.status !== 'deferred'
  )
  if (!Array.isArray(contract.acceptance)) throw new Error('SHIP_ACCEPTANCE_CONTRACT_INVALID')
  const definitions = new Map<string, Record<string, unknown>>()
  for (const value of contract.acceptance) {
    const item = record(value)
    if (typeof item.id !== 'string' || !item.id.trim() || definitions.has(item.id))
      throw new Error('SHIP_ACCEPTANCE_CONTRACT_INVALID')
    definitions.set(item.id, item)
  }
  const required = new Set<string>()
  for (const req of effective) {
    const item = (contract.requirements as unknown[])
      .map(record)
      .find((value) => value.id === req.id)!
    if (!Array.isArray(item.acceptance) || !item.acceptance.length)
      throw new Error('SHIP_ACCEPTANCE_CONTRACT_INVALID')
    for (const id of item.acceptance) {
      const definition = typeof id === 'string' ? definitions.get(id) : undefined
      if (
        !definition ||
        !Array.isArray(definition.requirement_ids) ||
        !definition.requirement_ids.includes(req.id)
      )
        throw new Error('SHIP_ACCEPTANCE_CONTRACT_INVALID')
      required.add(id as string)
    }
  }
  if (
    !Array.isArray(verdict.acceptance_ids) ||
    verdict.acceptance_ids.some((id) => typeof id !== 'string' || !definitions.has(id)) ||
    new Set(verdict.acceptance_ids).size !== verdict.acceptance_ids.length ||
    [...required].some((id) => !(verdict.acceptance_ids as unknown[]).includes(id))
  )
    throw new Error('SHIP_FINAL_ACCEPTANCE_COVERAGE_INCOMPLETE')
}
