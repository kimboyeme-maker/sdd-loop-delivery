import { shardLeases } from '../helpers/lease-slots'
import { processView } from '../services/process-view'
import { programExecutionView } from '../services/program-execution'
import { currentEpochAuthentication } from '../services/event-authentication'
import { runtimeCandidates } from '../services/runtime-candidates'
import { progressView } from '../services/progress-view'
import { contextView } from '../services/context-view'
export { contextView } from '../services/context-view'
import { publicLease } from '../helpers/public-lease'
import { assertProductRoleHistory } from '../helpers/product-role'
import { assertDesignIndependence } from '../helpers/design-independence'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readSnapshot } from '../resource/state'
import { operatorGoalBinding } from '../helpers/operator-goal'
import { COMMANDS } from '../commands/registry'
import { MINIMUM_BUN, PROTOCOL, RUNTIME, TYPESCRIPT } from '../config/constants'
import { roleTable } from '../config/roles'
import { hostCapabilities } from '../config/host'
import { TEST_PRESETS } from '../config/test-presets'
import { checkEventLog, parseEvents } from '../resource/store/event-log'
import { COMMAND_OPTIONS } from '../commands/options'
import { assertActiveLease } from '../domain/policies/active-lease'
import { SDD_DOCUMENT_ID_PATTERN, SDD_DEFAULT_ID_PREFIXES } from '../config/constants'

/** Publish the same role, document and CLI configuration consumed by execution. */
export function configuration(): object {
  return {
    skill: 'sdd-loop-delivery',
    protocol: PROTOCOL,
    runtime: RUNTIME,
    minimumBun: MINIMUM_BUN,
    typescript: TYPESCRIPT,
    roles: roleTable(),
    host: hostCapabilities(),
    document: {
      policy: 'sdd-document/v1',
      id_pattern: SDD_DOCUMENT_ID_PATTERN,
      default_prefixes: SDD_DEFAULT_ID_PREFIXES,
      description_column: 'description'
    },
    commands: COMMANDS,
    commandOptions: COMMAND_OPTIONS
  }
}

/** Advertise registered operations and their effects; availability is not proof of semantic parity. */
export function capabilities(): object {
  return {
    protocol: PROTOCOL,
    readOnly: COMMANDS.filter(({ mutation }) => !mutation).map(({ name }) => name),
    mutationRequires: ['lease', 'epoch', 'role', 'scope', 'signature'],
    commandOptions: COMMAND_OPTIONS,
    // Static policy declarations for design-time compatibility; none is a live host receipt.
    features: {
      document_policy: 'sdd-document/v1',
      document_presentation: 'sdd-presentation/v1',
      preparation: 'readonly-grant/v1',
      // Overlap features: preparation from CONTRACT_ADMITTED, prepared baseline/packet checks
      // (information only) and the parallel-safe delivery plan.
      preparation_window: 'contract-admitted/v1',
      prepared_checks: ['baseline_check', 'packet_check'],
      packet_modification_packages: true,
      delivery_plan: 'delivery-plan/v1',
      experience_contract: 'experience-contract/v1',
      delivery_platforms: 'delivery-platforms/v1',
      architecture_contract: 'core-adapters/v1',
      retrospective: 'retrospective/v1',
      runtime_plan: 'runtime-plan/v1',
      // Prepared Architects measure through test-run; results inform verification and are not reused.
      prepared_test_run: 'preparation-grant/v1',
      parallel_final_verification: 'shard-leases/v1',
      token_ledger: 'token-ledger/v1',
      test_presets: Object.keys(TEST_PRESETS),
      error_catalog: 'references/error-codes.md',
      planned_packet_expansion: 'single-work-graph/v1',
      control_kernel: 'coordinator-command-kernel/v1',
      coordinator_brief: 'coordinator-brief/v1',
      controller_measured_tests: 'test-run/v1',
      credit_ledger: 'credit-ledger/v1',
      program_structure: 'sdd-program/v1',
      program_workflow: 'sdd-workflow/v1',
      program_host_execution: 'host-agent-mediated',
      program_test_budget: 'nonrefundable-timeout-reservations/v1',
      bootstrap_helper: 'three-process/v1',
      direct_role_authorship: 'agent-record',
      pipeline_incidents_isolated_from_product_counters: true,
      execution_failure_forces_readmission: true,
      execution_failure_counts_observational_only: true,
      automatic_same_root_terminal_block: false,
      operator_candidate_receipt: 'candidate-integrity-v1',
      operator_worktree: 'operator-worktree/v1',
      operator_assignment_goal: 'operator-assignment-goal/v1',
      // Host operations come from the active host profile (agents/hosts); never host literals here.
      host: hostCapabilities(),
      decision_relevant_evidence_review: 'decision-evidence-v1',
      authorization_effect_delta: 'v1',
      artifact_custody: 'executable-custody-v1',
      terminal_blocker_evidence: 'enumerated-cause-v1',
      user_decision_resolution: 'request-hash-v1',
      process_view: 'working-agents-v1',
      worktree_owner_discovery: ['package.json', 'go.mod', 'Cargo.toml', 'go.work'],
      epoch_public_key_signatures: 'ed25519-role-v1',
      cross_engine_state: 'rejected-before-write'
    }
  }
}

/** Project current signed evidence for reporting without changing state or implying product acceptance. */
export function status(sdd: string, compact = false): object {
  const snapshot = readSnapshot(sdd)
  const eventLog = checkEventLog(`${sdd}.events.jsonl`, snapshot.eventText)
  const contract = readFileSync(sdd, 'utf8')
  const state = snapshot.state as Record<string, unknown>
  // Derive progress and event diagnostics from the same captured history.
  const eventBytes = Buffer.from(snapshot.eventText)
  const events: Record<string, unknown>[] = eventLog.valid ? parseEvents(eventBytes) : []
  const full = {
    sdd,
    contractBytes: Buffer.byteLength(contract),
    stateHash: snapshot.stateHash,
    eventsHash: snapshot.eventsHash,
    eventCount: snapshot.eventCount,
    eventLog,
    protocol: snapshot.state.protocol ?? 'unknown',
    phase: snapshot.state.phase ?? snapshot.state.stage ?? 'unknown',
    activeLease: publicLease(snapshot.state.active_lease),
    preparation: publicPreparation(state.preparation),
    authorityEpoch: snapshot.state.authority_epoch ?? null,
    progress_view: progressView(sdd, state, events),
    process_view: processView(state),
    program_context: programExecutionView(sdd, state)
  }
  if (!compact) return full
  const requirements = state.requirements
  const counts =
    requirements && typeof requirements === 'object' && !Array.isArray(requirements)
      ? Object.values(requirements as Record<string, unknown>).reduce<Record<string, number>>(
          (result, value) => {
            const key = String(value)
            result[key] = (result[key] ?? 0) + 1
            return result
          },
          {}
        )
      : {}
  return {
    protocol: full.protocol,
    phase: full.phase,
    process_view: full.process_view,
    authorityEpoch: full.authorityEpoch,
    eventCount: full.eventCount,
    contractBytes: full.contractBytes,
    completedAttempts: state.completed_attempts ?? null,
    requirement_counts: counts,
    open_finding_ids: Object.entries(
      state.findings && typeof state.findings === 'object' ? state.findings : {}
    )
      .filter(
        ([, value]) =>
          value && typeof value === 'object' && (value as Record<string, unknown>).status === 'open'
      )
      .map(([id]) => id)
      .sort(),
    progress_view: full.progress_view,
    preparation: full.preparation
  }
}

/** Show preparation progress without exposing frozen source text or capability material. */
function publicPreparation(value: unknown): object | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const grant = value as Record<string, unknown>
  const snapshot = grant.context_snapshot as Record<string, unknown> | undefined
  return {
    prepared_id: grant.prepared_id,
    agent_id: grant.agent_id,
    stage: grant.ready_event_id ? 'ready' : 'reading',
    issued_at: grant.issued_at,
    ready_event_id: grant.ready_event_id ?? null,
    source_bytes: typeof snapshot?.text === 'string' ? Buffer.byteLength(snapshot.text) : null
  }
}

/** Report one native state/event snapshot before resume; hashes do not authenticate role evidence. */
export function audit(sdd: string): object {
  let snapshot
  try {
    snapshot = readSnapshot(sdd)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EVENT_LOG_'))
      return {
        protocol: 'audit/v1',
        sdd,
        snapshotConsistent: false,
        eventLogBinding: error.message,
        note: 'Committed event history does not match controller state; do not dispatch or ship.'
      }
    if (
      !(error instanceof Error) ||
      !['CONTROL_TRANSACTION_PENDING', 'CONTROL_TRANSACTION_IN_PROGRESS'].includes(error.message)
    )
      throw error
    return {
      protocol: 'audit/v1',
      sdd,
      pendingTransaction: existsSync(`${sdd}.transaction.json`),
      lockPresent: existsSync(`${sdd}.loop.lock`),
      snapshotConsistent: false,
      phase: 'unknown',
      activeLease: null,
      authorityEpoch: null,
      note: 'Recovery required before interpreting state; lock presence does not prove a live process.'
    }
  }
  const eventLog = checkEventLog(`${sdd}.events.jsonl`, snapshot.eventText)
  const journal = `${sdd}.transaction.json`
  const loopLock = `${sdd}.loop.lock`
  return {
    protocol: 'audit/v1',
    sdd,
    stateHash: snapshot.stateHash,
    eventsHash: snapshot.eventsHash,
    eventCount: snapshot.eventCount,
    eventLog,
    pendingTransaction: existsSync(journal),
    lockPresent: existsSync(loopLock),
    phase: snapshot.state.phase ?? snapshot.state.stage ?? 'unknown',
    activeLease: publicLease(snapshot.state.active_lease),
    authorityEpoch: snapshot.state.authority_epoch ?? null,
    // Run with the Coordinator credential; AUTHENTIC_CURRENT_EPOCH is required before dispatch or SHIP.
    authentication: currentEpochAuthentication(
      snapshot.state as Record<string, unknown>,
      parseEvents(snapshot.eventText),
      process.env.SDD_LOOP_COORDINATOR_TOKEN
    ),
    note: 'Snapshot, committed history binding and current-epoch signatures only; not product acceptance. Audit does not recover, mutate, or infer host process state.'
  }
}

/** Expose pending recovery without interpreting an uncommitted state as execution context. */
export function resumeView(sdd: string): object {
  const facts = audit(sdd) as Record<string, unknown>
  const recovering = facts.pendingTransaction === true || facts.lockPresent === true
  return {
    protocol: 'resume-view/v1',
    audit: facts,
    context: recovering ? null : contextView(sdd),
    next: recovering
      ? 'Coordinator must resolve the pending transaction or confirm stale lock recovery before reading execution context.'
      : 'Coordinator must verify lease and runtime identity before dispatch.'
  }
}

/** Report native lease checks without treating host liveness as authority. */
export function runtimeView(sdd: string): object {
  const snapshot = readSnapshot(sdd)
  const lease = snapshot.state.active_lease
  const reasons: string[] = []
  const leaseRecord =
    lease && typeof lease === 'object' && !Array.isArray(lease)
      ? (lease as Record<string, unknown>)
      : null
  // Concurrent final-verification shard leases are reported beside the primary slot.
  const shardLeaseIds = Object.keys(shardLeases(snapshot.state as Record<string, unknown>))
  if (!leaseRecord) {
    if (!shardLeaseIds.length) reasons.push('NO_ACTIVE_LEASE')
  } else {
    const agentId = leaseRecord.agent_id
    if (typeof agentId !== 'string' || !agentId.trim()) reasons.push('LEASE_AGENT_ID_UNRECORDED')
    if (!['operator', 'architect'].includes(String(leaseRecord.role)))
      reasons.push('LEASE_ROLE_UNRECORDED')
    if (typeof leaseRecord.lease_id !== 'string' || !leaseRecord.lease_id.trim())
      reasons.push('LEASE_ID_UNRECORDED')
    try {
      assertActiveLease(snapshot.state, leaseRecord)
      const events = parseEvents(snapshot.eventText)
      if (
        typeof agentId === 'string' &&
        (leaseRecord.role === 'operator' || leaseRecord.role === 'architect')
      ) {
        assertProductRoleHistory(snapshot.state, events, agentId, leaseRecord.role)
        if (
          leaseRecord.role === 'architect' &&
          leaseRecord.verification_mode !== 'design-counsel' &&
          !leaseRecord.repair_probe_root
        )
          assertDesignIndependence(snapshot.state, events, agentId)
      }
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : 'LEASE_UNVERIFIABLE')
    }
  }
  const eligible = reasons.length === 0
  return {
    shard_lease_ids: shardLeaseIds,
    protocol: 'runtime-view/v1',
    candidates: runtimeCandidates(snapshot.state, parseEvents(snapshot.eventText)),
    sdd,
    eligible,
    exclusion: eligible ? null : reasons.length === 1 ? reasons[0] : reasons,
    reasons,
    hostIdentityVerified: false,
    operator_goal: leaseRecord ? operatorGoalBinding(snapshot.state, leaseRecord) : null,
    lease: publicLease(lease),
    authorityEpoch: snapshot.state.authority_epoch ?? null,
    note: 'Runtime eligibility is derived from controller state; host identity and liveness are not inferred.'
  }
}

export function contextRead(sdd: string, offset: number, limit: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('CONTEXT_OFFSET_INVALID')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 262_144)
    throw new Error('CONTEXT_LIMIT_INVALID')
  const source = readFileSync(sdd)
  if (offset > source.byteLength) throw new Error('CONTEXT_OFFSET_OUT_OF_RANGE')
  let start = offset
  while (start > 0 && (source[start]! & 0xc0) === 0x80) start -= 1
  let end = Math.min(offset + limit, source.byteLength)
  while (end < source.byteLength && (source[end]! & 0xc0) === 0x80) end += 1
  const chunk = source.subarray(start, end)
  return {
    sdd,
    protocol: 'context-read/v1',
    offset,
    actualOffset: start,
    limit,
    end,
    totalBytes: source.byteLength,
    complete: end === source.byteLength,
    sha256: createHash('sha256').update(chunk).digest('hex'),
    text: chunk.toString('utf8'),
    nextOffset: end === source.byteLength ? null : end
  }
}
