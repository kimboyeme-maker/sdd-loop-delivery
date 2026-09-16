import { eventsWithId } from '../utils/event-index'
import { leaseSlots, shardLeases } from '../helpers/lease-slots'
import { nextControlRevision } from '../domain/policies/control-revision'
import { assertDesignIndependence } from '../helpers/design-independence'
import { assertRuntimeGuidance } from '../helpers/runtime-guidance'
import { assertProgramExecution } from '../services/program-execution'
import rolePolicy from '../../agents/roles.json'
import { operatorRuntime, runtimeMatches } from '../config/host'
import { preparedContext } from '../helpers/prepared-context'
import { ROLE_EVENT_PHASES } from '../domain/policies/role-event-phase'
import {
  packetPrerequisites,
  assertPacketPrerequisiteEvidence
} from '../helpers/packet-prerequisites'
import { currentCandidate } from '../helpers/candidate-evidence'
import { assertOperatorHandoff } from '../services/operator-handoff'
import { requireAttemptConvergence } from '../helpers/attempt-convergence'
import { isRuntimeIdentity } from '../helpers/runtime-identity'
import { correlateEvent } from '../context/command-context'
import { assertCurrentSource } from '../helpers/source-binding'
import { assertProductRoleHistory } from '../helpers/product-role'
import { createHmac, randomUUID } from 'node:crypto'
import { mintRoleCapability } from '../resource/role-capability'
import {
  assertDispatchMetadata,
  hasPriorNoProgress,
  resumeCheckpointRecovery
} from '../helpers/dispatch-metadata'
import { assertScopeObserved, productSnapshot } from '../helpers/worktree-candidate'
import { chargeCredit, creditLedger, creditWeight } from '../helpers/credit-ledger'
import { hostProfile } from '../config/host'
import { ESCALATED_OPERATOR_MIN_FAILURES, TOKENS_PER_CREDIT_UNIT } from '../config/constants'
import { readFileSync } from 'node:fs'
import {
  COORDINATOR_TOKEN_ENV,
  assertCoordinatorToken,
  assertExpected,
  commitControl,
  loadControl,
  signCoordinatorEvent
} from '../services/control-kernel'
import { isAbsolute } from 'node:path'
import {
  currentAdmission,
  admissionDispatchScope,
  finalVerificationScope
} from '../helpers/admission-authority'
import { readContractDocument } from '../services/contract-document'

const TOKEN_ENV = COORDINATOR_TOKEN_ENV
type Role = 'operator' | 'architect'
export type DispatchOptions = Readonly<{
  packet?: string
  contextFingerprint?: string
  guidanceId?: string
  preparedId?: string
  operatorGoal?: 'required' | 'unavailable'
  /** Planned final-verification shard this Architect verifies beside other shard leases. */
  verificationShard?: string
  goalUnavailableReason?: string
  operatorProfile?: string
  verificationMode?: string
  worktreeRoot?: string
  generatedPaths?: readonly string[]
  repairProbeRoot?: string
  resumeCheckpoint?: string
  correctionFindingId?: string
  freshReason?: string
}>

/** Issue one bounded product lease after rechecking the live control-plane state. */
export function dispatch(
  sdd: string,
  role: string,
  expectedState: string,
  expectedRevision: string,
  agent: Role,
  agentId: string,
  softDeadline: number,
  hardDeadline: number,
  scope: readonly string[],
  workItem: string | undefined,
  token = process.env[TOKEN_ENV],
  options: DispatchOptions = {}
): Readonly<{
  protocol: 'dispatch/v1'
  eventId: string
  leaseId: string
  agentId: string
  capabilityFile: string
  goalTokenBudget?: number
}> {
  if (role !== 'coordinator') throw new Error('ROLE_DISPATCH_FORBIDDEN')
  if (agent !== 'operator' && agent !== 'architect') throw new Error('AGENT_ROLE_INVALID')
  const verificationMode = options.verificationMode ?? 'standard'
  if (
    !['standard', 'bounded-correction', 'fresh-independent', 'design-counsel'].includes(
      verificationMode
    )
  )
    throw new Error('VERIFICATION_MODE_INVALID')
  const counsel = verificationMode === 'design-counsel'
  if (counsel && agent !== 'architect') throw new Error('DESIGN_COUNSEL_ARCHITECT_ONLY')
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  // Host identities are opaque: canonical task paths and UUIDs are both valid.
  // Preserve the exact identifier for authorization/history; never normalize it.
  // eslint-disable-next-line no-control-regex -- Reject control bytes in host identifiers.
  if (!isRuntimeIdentity(agentId)) throw new Error('AGENT_ID_INVALID')
  if (
    !Number.isFinite(softDeadline) ||
    !Number.isFinite(hardDeadline) ||
    softDeadline <= 0 ||
    hardDeadline <= softDeadline
  )
    throw new Error('LEASE_DEADLINES_INVALID')
  if (scope.length === 0 || scope.some((item) => !item.trim()))
    throw new Error('DISPATCH_SCOPE_REQUIRED')
  if (scope.some((item) => isAbsolute(item) || item.split('/').includes('..')))
    throw new Error('DISPATCH_SCOPE_INVALID')
  if (!workItem?.trim()) throw new Error('DISPATCH_WORK_ITEM_REQUIRED')
  if (options.operatorGoal === 'unavailable' && !options.goalUnavailableReason?.trim())
    throw new Error('DISPATCH_GOAL_UNAVAILABLE_REASON_REQUIRED')
  // A required Goal and an unavailability excuse are contradictory, not additive.
  if (options.operatorGoal === 'required' && options.goalUnavailableReason !== undefined)
    throw new Error('OPERATOR_GOAL_REASON_FORBIDDEN_WHEN_REQUIRED')
  if (
    options.operatorGoal !== undefined &&
    !['required', 'unavailable'].includes(options.operatorGoal)
  )
    throw new Error('DISPATCH_OPERATOR_GOAL_INVALID')
  if (
    agent !== 'operator' &&
    (options.operatorGoal !== undefined || options.goalUnavailableReason !== undefined)
  )
    throw new Error('ARCHITECT_OPERATOR_GOAL_FORBIDDEN')
  for (const path of [...(options.generatedPaths ?? [])]) {
    if (!path.trim() || isAbsolute(path) || path.split('/').includes('..'))
      throw new Error('DISPATCH_OPTION_PATH_INVALID')
  }
  // Every normal Operator lease can reach implementation without being reissued.
  // Freeze its baseline before any product write, not at candidate submission.
  if (agent === 'operator' && !options.repairProbeRoot && !options.worktreeRoot?.trim())
    throw new Error(
      'DISPATCH_WORKTREE_ROOT_REQUIRED: supply --worktree-root before Operator execution'
    )
  if (options.worktreeRoot && !isAbsolute(options.worktreeRoot))
    throw new Error('DISPATCH_WORKTREE_ROOT_MUST_BE_ABSOLUTE')
  const control = loadControl(sdd)
  const { state } = control
  const sourceBytes = readFileSync(sdd)
  assertCurrentSource(state, sdd, sourceBytes)
  const current = String(state.phase ?? '')
  assertExpected(state, expectedState, expectedRevision)
  assertCoordinatorToken(state, token)
  const programContext = assertProgramExecution(
    sdd,
    state,
    options.packet,
    counsel || options.repairProbeRoot ? 'read' : 'dispatch',
    options.worktreeRoot
  )
  // Stop the next implementation before it runs, rather than rejecting its accounting later.
  // The sixth candidate may still receive its independent/final verification.
  if (
    agent === 'operator' &&
    !options.repairProbeRoot &&
    Number(state.round_completed_attempts ?? 0) >= 6
  )
    throw new Error(
      'ATTEMPT_BUDGET_EXHAUSTED: user decision required before further product dispatch'
    )
  if (
    options.verificationShard !== undefined &&
    (agent !== 'architect' || current !== 'FINAL_VERIFY')
  )
    throw new Error('VERIFICATION_SHARD_PHASE_INVALID')
  if (
    options.freshReason === 'parallel-final-verification-shard' &&
    options.verificationShard === undefined
  )
    throw new Error('FRESH_ARCHITECT_REASON_INVALID')
  const liveLeases = leaseSlots(state)
  // Only read-only final-verification shards run beside each other, one Architect per shard.
  if (
    liveLeases.length &&
    (options.verificationShard === undefined ||
      liveLeases.some(
        (lease) =>
          typeof lease.verification_shard !== 'string' ||
          lease.verification_shard === options.verificationShard ||
          lease.agent_id === agentId
      ))
  )
    throw new Error('ACTIVE_AGENT_LEASE_EXISTS')
  if (!options.repairProbeRoot && state.execution_substrate_required != null)
    throw new Error('EXECUTION_SUBSTRATE_RECEIPT_REQUIRED_BEFORE_REDISPATCH')
  const repair = state.pending_pipeline_repair as Record<string, unknown> | undefined
  if (repair && !options.repairProbeRoot) throw new Error('PIPELINE_REPAIR_PROBE_REQUIRED')
  if (
    options.repairProbeRoot &&
    (!repair ||
      repair.root_cause_key !== options.repairProbeRoot ||
      typeof repair.candidate_hash !== 'string' ||
      !repair.candidate_hash)
  )
    throw new Error('PIPELINE_REPAIR_PROBE_BINDING_INVALID')
  // A pending failed route is not implementable again merely because its lease
  // ended. A validated pipeline probe may repair orchestration without granting
  // product scope; product execution still awaits complete readmission.
  if (state.pending_execution_failure != null && !options.repairProbeRoot && !counsel)
    throw new Error('EXECUTION_FAILURE_READMISSION_REQUIRED')
  assertProductRoleHistory(state, control.events(), agentId, agent)

  if (
    agent === 'architect' &&
    options.verificationMode !== 'design-counsel' &&
    !options.repairProbeRoot
  )
    assertDesignIndependence(state, control.events(), agentId)
  const allowed: readonly string[] = options.repairProbeRoot
    ? ROLE_EVENT_PHASES[agent].capability_probe!
    : counsel
      ? [
          'CONTRACT_DRAFT',
          'CONTRACT_AMENDED',
          'OPERATOR_READBACK',
          'IMPLEMENTING',
          'COORDINATOR_TRIAGE'
        ]
      : agent === 'operator'
        ? ['OPERATOR_READBACK', 'IMPLEMENTING', 'OPERATOR_SELF_CHECK']
        : ['FINAL_VERIFY', 'ARCHITECT_VERIFY']
  if (!allowed.includes(current)) throw new Error('DISPATCH_STATE_INVALID')
  const history = control.events()
  assertDispatchMetadata(state, history, {
    agent,
    agentId,
    verificationMode,
    packet: options.packet,
    workItem,
    freshReason: options.freshReason,
    correctionFindingId: options.correctionFindingId,
    resumeCheckpoint: options.resumeCheckpoint,
    repairProbeRoot: options.repairProbeRoot
  })
  // One recovery binding: a signed resume checkpoint or a Coordinator replacement
  // observation. The successor must read it back before any product evidence.
  const recovery = options.resumeCheckpoint
    ? resumeCheckpointRecovery(state, history, agent, options.resumeCheckpoint)
    : agent === 'operator' && !options.repairProbeRoot && state.operator_recovery != null
      ? { source: 'replacement', ...(state.operator_recovery as Record<string, unknown>) }
      : undefined
  if (!options.repairProbeRoot && !counsel)
    requireAttemptConvergence(state, control.events(), token)
  const admission =
    options.repairProbeRoot || counsel
      ? undefined
      : currentAdmission(state, control.events(), token)
  let finalScope:
    | (ReturnType<typeof finalVerificationScope> & { verification_shard?: string })
    | undefined
  if (admission && agent === 'architect') assertOperatorHandoff(sdd, state, control.events(), token)
  if (admission && agent === 'architect' && current === 'FINAL_VERIFY') {
    if (options.packet !== undefined) throw new Error('FINAL_VERIFICATION_PACKET_FORBIDDEN')
    const contract = readContractDocument(sdd, sourceBytes.toString('utf8'))
    if (!contract || contract.revision !== state.contract_revision)
      throw new Error('FINAL_VERIFICATION_CONTRACT_REQUIRED')
    finalScope = finalVerificationScope(contract, scope)
    if (options.verificationShard !== undefined) {
      const plan = (contract as unknown as Record<string, unknown>).delivery_plan as
        | Record<string, unknown>
        | undefined
      const shard = (
        Array.isArray(plan?.final_verification_shards) ? plan.final_verification_shards : []
      ).find(
        (item) => (item as Record<string, unknown> | null)?.id === options.verificationShard
      ) as Record<string, unknown> | undefined
      if (!shard || !Array.isArray(shard.acceptance_ids))
        throw new Error('VERIFICATION_SHARD_UNKNOWN')
      const acceptance = (shard.acceptance_ids as string[]).filter((id) =>
        finalScope!.acceptance_ids.includes(id)
      )
      finalScope = {
        acceptance_ids: acceptance,
        requirement_ids: contract.requirements
          .filter(
            (item) =>
              item.kind === 'must-ship' &&
              ((item as unknown as { acceptance?: string[] }).acceptance ?? []).some((id) =>
                acceptance.includes(id)
              )
          )
          .map((item) => item.id),
        verification_shard: options.verificationShard
      }
    }
  } else if (admission) admissionDispatchScope(admission, agent, scope, options.packet)
  if (
    admission &&
    agent === 'operator' &&
    ['OPERATOR_READBACK', 'IMPLEMENTING'].includes(current)
  ) {
    const prerequisites = packetPrerequisites(admission, options.packet)
    if (prerequisites.length) {
      const events = control.events()
      const { candidate } = currentCandidate(sdd, state, events)
      assertPacketPrerequisiteEvidence(prerequisites, state, events, candidate)
    }
  }
  const leaseId = `LEASE-${randomUUID()}`
  let operatorProfile = options.operatorProfile ?? rolePolicy.roles.operator.default_profile
  if (agent !== 'operator' && options.operatorProfile !== undefined)
    throw new Error('ARCHITECT_OPERATOR_PROFILE_FORBIDDEN')
  // Once a runtime has been observed, every product or counsel assignment carries signed guidance.
  if (
    !options.repairProbeRoot &&
    !options.guidanceId &&
    (programContext !== null ||
      history.some(
        (event) =>
          event.type === 'runtime_record' &&
          (event.payload as Record<string, unknown> | undefined)?.action === 'observe' &&
          (event.payload as Record<string, unknown>).agent_id === agentId
      ))
  )
    throw new Error('RUNTIME_GUIDANCE_REQUIRED')
  if (options.guidanceId) {
    const events = control.events()
    const matches = eventsWithId(events, options.guidanceId)
    const guidanceEvent = matches[0]
    if (matches.length !== 1 || !guidanceEvent) throw new Error('GUIDANCE_BINDING_INVALID')
    const { signature, ...body } = guidanceEvent
    const guidance = guidanceEvent.payload as Record<string, unknown>
    if (
      guidanceEvent.type !== 'runtime_record' ||
      guidanceEvent.role !== 'coordinator' ||
      signature !== createHmac('sha256', token).update(JSON.stringify(body)).digest('hex') ||
      guidance?.action !== 'guidance' ||
      guidance.agent_id !== agentId ||
      guidance.agent_role !== agent ||
      guidance.authority_epoch !== state.authority_epoch ||
      guidance.work_item !== workItem ||
      (guidance.packet_id ?? null) !== (options.packet ?? null) ||
      guidance.lease_id != null
    )
      throw new Error('GUIDANCE_BINDING_INVALID')
    assertRuntimeGuidance(sdd, state, events, guidance, token)
    if (
      programContext &&
      JSON.stringify(guidance.program_context) !== JSON.stringify(programContext)
    )
      throw new Error('PROGRAM_GUIDANCE_STALE')
    if (agent === 'operator') {
      const selected = String(
        guidance.operator_profile ?? rolePolicy.roles.operator.default_profile
      )
      if (options.operatorProfile !== undefined && options.operatorProfile !== selected)
        throw new Error('OPERATOR_PROFILE_GUIDANCE_MISMATCH')
      operatorProfile = selected
    }
  }
  if (agent === 'operator') {
    const profiles = rolePolicy.roles.operator.profiles
    if (!Object.hasOwn(profiles, operatorProfile)) throw new Error('OPERATOR_PROFILE_INVALID')
    if (operatorProfile === 'bounded' && !options.guidanceId)
      throw new Error('BOUNDED_OPERATOR_PROFILE_BASIS_REQUIRED')
    // The strongest tier is a repair escalation backed by counters, not a preference.
    if (
      operatorProfile === 'escalated' &&
      Number(state.consecutive_architect_rejections ?? 0) < ESCALATED_OPERATOR_MIN_FAILURES &&
      Number(state.consecutive_stagnant_attempts ?? 0) < ESCALATED_OPERATOR_MIN_FAILURES
    )
      throw new Error('ESCALATED_OPERATOR_PROFILE_NOT_JUSTIFIED')
    const events = control.events()
    const observed = events.findLast(
      (event) =>
        event.type === 'runtime_record' &&
        (event.payload as Record<string, unknown>)?.action === 'observe' &&
        (event.payload as Record<string, unknown>)?.agent_id === agentId
    )
    if (!observed && operatorProfile !== rolePolicy.roles.operator.default_profile)
      throw new Error('OPERATOR_PROFILE_HOST_OBSERVATION_REQUIRED')
    if (observed) {
      const host = (observed.payload as Record<string, unknown>).host as Record<string, unknown>
      if (!runtimeMatches(operatorRuntime(operatorProfile), host))
        throw new Error('OPERATOR_PROFILE_RUNTIME_MISMATCH')
    }
    if (operatorProfile === 'bounded') {
      if (options.operatorGoal !== 'required')
        throw new Error('BOUNDED_OPERATOR_PROFILE_REQUIRES_GOAL')
      if (hasPriorNoProgress(state, history, options.packet, workItem))
        throw new Error('BOUNDED_OPERATOR_PROFILE_PRIOR_DEVIATION')
    }
  }
  const preparation =
    agent === 'architect' && !counsel && !options.repairProbeRoot
      ? preparedContext(
          sdd,
          state,
          control.events(),
          agentId,
          options.preparedId,
          admission?.event_id
        )
      : null
  // A prepared Architect keeps the credential it already holds; otherwise mint a new one.
  const capability: Record<string, unknown> = preparation
    ? {
        capability_file: preparation.capability_file,
        agent_token_hash: preparation.agent_token_hash,
        event_public_key: preparation.event_public_key
      }
    : (() => {
        const minted = mintRoleCapability(leaseId)
        return {
          capability_file: minted.path,
          agent_token_hash: minted.hash,
          event_public_key: minted.publicKey
        }
      })()
  // One Operator baseline per admitted round: replacements and later packets reuse it, so
  // predecessor changes stay in every candidate delta. ROUND_CLOSED retires it.
  const retained = state.operator_worktree_baseline as Record<string, unknown> | null | undefined
  let operatorBaseline: unknown
  if (agent === 'operator' && options.worktreeRoot && !options.repairProbeRoot) {
    if (retained) {
      if (retained.root !== options.worktreeRoot)
        throw new Error('WORKTREE_ROOT_CANNOT_CHANGE_WITH_EXISTING_BASELINE')
      const generated = options.generatedPaths ?? []
      if (!((retained.generated_paths as string[]) ?? []).every((path) => generated.includes(path)))
        throw new Error('WORKTREE_GENERATED_SCOPE_CANNOT_SHRINK')
      operatorBaseline = retained.snapshot
    } else {
      const frozen = productSnapshot(sdd, options.worktreeRoot, options.generatedPaths)
      // Only the round's first Operator lease freezes a baseline, so this is the last point
      // at which an unobservable scope root can still be fixed by widening --generated-path.
      assertScopeObserved(scope, options.worktreeRoot, frozen.owners, options.generatedPaths)
      operatorBaseline = frozen
    }
  }
  const eventId = `EVT-${randomUUID()}`
  const lease = {
    role: agent,
    ...(preparation ?? {}),
    agent_id: agentId,
    lease_id: leaseId,
    dispatch_event_id: eventId,
    dispatch_phase: current,
    ...(admission ? { admission_event_id: admission.event_id } : {}),
    ...(finalScope ?? {}),
    ...capability,
    authority_epoch: state.authority_epoch ?? 1,
    contract_revision: state.contract_revision,
    soft_deadline_minutes: softDeadline,
    hard_deadline_minutes: hardDeadline,
    scope: options.repairProbeRoot || counsel ? [] : [...scope],
    ...(counsel ? { observation_scope: [...scope] } : {}),
    work_item: workItem,
    issued_at: new Date().toISOString(),
    ...(options.packet ? { packet_id: options.packet } : {}),
    ...(options.contextFingerprint ? { context_fingerprint: options.contextFingerprint } : {}),
    ...(options.guidanceId ? { guidance_id: options.guidanceId } : {}),
    ...(options.operatorGoal ? { operator_goal: options.operatorGoal } : {}),
    ...(options.goalUnavailableReason
      ? { goal_unavailable_reason: options.goalUnavailableReason }
      : {}),
    ...(agent === 'operator' ? { operator_profile: operatorProfile } : {}),
    verification_mode: verificationMode,
    ...(options.worktreeRoot && !options.repairProbeRoot
      ? { worktree_root: options.worktreeRoot }
      : {}),
    // Control-plane probes carry no product mutation authority or baseline.
    ...(operatorBaseline ? { worktree_baseline: operatorBaseline } : {}),
    ...(options.generatedPaths?.length ? { generated_paths: [...options.generatedPaths] } : {}),
    ...(options.repairProbeRoot
      ? {
          repair_probe_root: options.repairProbeRoot,
          repair_candidate_hash: repair!.candidate_hash,
          lease_kind: 'PIPELINE_PROBE'
        }
      : {}),
    ...(recovery ? { recovery } : {}),
    ...(options.correctionFindingId ? { correction_finding_id: options.correctionFindingId } : {}),
    ...(options.freshReason ? { fresh_reason: options.freshReason } : {})
  }
  const body = correlateEvent({
    event_id: eventId,
    role: 'coordinator',
    type: 'dispatch',
    payload: lease
  })
  const event = signCoordinatorEvent(state, body, token)
  const issued =
    state.issued_leases &&
    typeof state.issued_leases === 'object' &&
    !Array.isArray(state.issued_leases)
      ? (state.issued_leases as Record<string, unknown>)
      : {}
  // Product calls, design counsel and pipeline probes have separate budgets.
  const invocationField = options.repairProbeRoot
    ? 'pipeline_repair_probe_invocations'
    : counsel
      ? 'design_counsel_invocations'
      : `${agent}_invocations`
  const invocationCount = state[invocationField] ?? 0
  if (
    !Number.isSafeInteger(invocationCount) ||
    Number(invocationCount) < 0 ||
    Number(invocationCount) >= Number.MAX_SAFE_INTEGER
  )
    throw new Error('INVOCATION_COUNTER_INVALID')
  // Every grant spends relative credit before it exists; an exhausted ledger waits for the user.
  const credit = chargeCredit(
    state,
    creditWeight(
      options.repairProbeRoot
        ? 'repair_probe'
        : counsel
          ? 'design_counsel'
          : agent === 'architect'
            ? 'architect'
            : operatorProfile === 'bounded'
              ? 'operator_bounded'
              : operatorProfile === 'escalated'
                ? 'operator_escalated'
                : 'operator_standard'
    )
  )
  const nextState = {
    ...state,
    [invocationField]: Number(invocationCount) + 1,
    ...(credit ? { credit_ledger: credit } : {}),
    agent_roles: {
      ...(state.agent_roles as Record<string, unknown> | undefined),
      [agentId]: agent
    },
    updated_at: new Date().toISOString(),
    ...(state.active_lease == null
      ? { active_lease: lease }
      : { shard_leases: { ...shardLeases(state), [leaseId]: lease } }),
    ...(operatorBaseline && !retained
      ? {
          operator_worktree_baseline: {
            root: options.worktreeRoot,
            generated_paths: [...(options.generatedPaths ?? [])],
            snapshot: operatorBaseline
          }
        }
      : {}),
    ...((state.preparation as Record<string, unknown> | null)?.agent_id === agentId
      ? { preparation: null }
      : {}),
    issued_leases: { ...issued, [leaseId]: lease },
    revision: nextControlRevision(state.revision)
  }
  commitControl(control, nextState, event, token)
  // A goal-enabled Operator on a host with structured Goal budgets gets the grant's token share.
  const units = credit ? credit.spent - (creditLedger(state)?.spent ?? 0) : null
  const calibrated = Number(
    (state.token_ledger as Record<string, unknown> | undefined)?.tokens_per_credit_unit
  )
  const goalTokenBudget =
    agent === 'operator' &&
    options.operatorGoal === 'required' &&
    units !== null &&
    hostProfile().operations.goal_set.available
      ? units * (calibrated > 0 ? calibrated : TOKENS_PER_CREDIT_UNIT)
      : null
  return {
    protocol: 'dispatch/v1',
    eventId,
    leaseId,
    agentId,
    capabilityFile: String(capability.capability_file),
    ...(goalTokenBudget === null ? {} : { goalTokenBudget })
  }
}
