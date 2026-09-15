import { eventsWithId } from '../utils/event-index'
import { parseEvents } from '../resource/store/event-log'
import { leaseDeadlines, shardLeases } from '../helpers/lease-slots'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { COORDINATOR_BRIEF_RECENT_EVENTS } from '../config/constants'
import { assertShipEvidence } from '../helpers/ship-evidence'
import { admittedPacketIds, operatorTestUsage } from '../helpers/test-budget-usage'
import { readContractDocument } from './contract-document'
import { phaseTransitions, type Phase } from '../domain/policies/phase'
import { currentAdmission } from '../helpers/admission-authority'
import { creditLedger } from '../helpers/credit-ledger'
import { publicLease } from '../helpers/public-lease'
import { readSnapshot, sidecarPaths } from '../resource/state'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** The signed role result a phase gate would consume now: recorded in this phase and revision. */
function gateEvent(state: Item, events: readonly Item[], type: string): Item | undefined {
  const id = object(state.last_role_events)?.[type]
  const event = eventsWithId(events, id)[0]
  return event && event.state === state.phase && event.contract_revision === state.contract_revision
    ? event
    : undefined
}

/**
 * FINAL_VERIFY has three legitimate next steps. The SHIP gate itself decides whether shipping is
 * possible; otherwise a failing verdict goes to triage, a missing planned shard or verdict is
 * dispatched, and passing verdicts still need their requirement statuses recorded.
 */
/** SHIP gate codes that recording requirement status with a current PASS verdict resolves. */
const REQUIREMENT_STATUS_CODES = new Set([
  'SHIP_REQUIREMENTS_UNVERIFIED',
  'SHIP_REQUIREMENT_EVIDENCE_REQUIRED',
  'SHIP_REQUIREMENT_STATUS_MISSING'
])

/** Run the real SHIP gate and keep its rejection code and message instead of guessing. */
function shipGate(sdd: string, state: Item, events: readonly Item[], token: string | undefined) {
  try {
    assertShipEvidence(state, events, token ?? '', sdd)
    return { ready: true, code: null, message: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SHIP_GATE_REJECTED'
    return { ready: false, code: message.split(':')[0]!.trim(), message }
  }
}

function finalVerifyObligation(
  sdd: string,
  state: Item,
  events: readonly Item[],
  token: string | undefined
): string {
  const gate = shipGate(sdd, state, events, token)
  if (gate.ready) return 'TRANSITION_SHIP'
  const shardVerdicts = object(state.final_shard_verdicts) ?? {}
  const ids = Object.keys(shardVerdicts).length
    ? Object.values(shardVerdicts)
    : [gateEvent(state, events, 'verification')?.event_id].filter(Boolean)
  const verdicts = events.filter((event) => ids.includes(event.event_id))
  if (verdicts.some((event) => object(event.payload)?.result !== 'PASS'))
    return 'TRANSITION_COORDINATOR_TRIAGE'
  if (Object.keys(shardVerdicts).length) {
    let plan: Item | undefined
    try {
      plan = object((readContractDocument(sdd) as unknown as Item | undefined)?.delivery_plan)
    } catch {
      plan = undefined
    }
    const missing = (
      Array.isArray(plan?.final_verification_shards) ? plan.final_verification_shards : []
    )
      .map((shard) => String(object(shard)?.id))
      .find((id) => !Object.hasOwn(shardVerdicts, id))
    if (missing) return `DISPATCH_FINAL_VERIFICATION_SHARD:${missing}`
  }
  if (!verdicts.length) return 'DISPATCH_FINAL_VERIFICATION'
  // Only a missing or stale requirement status is fixed by recording it; anything else is the
  // gate's own reason, reported as is.
  return REQUIREMENT_STATUS_CODES.has(String(gate.code))
    ? 'RECORD_REQUIREMENT_STATUS_THEN_SHIP'
    : `RESOLVE_SHIP_GATE:${gate.code}`
}

/**
 * Next Coordinator obligations derived from persisted control facts and the same gates the
 * commands enforce, in priority order. They orient the next decision; the Coordinator still reads
 * the evidence that decision needs. The brief never embeds payloads, verdict text or diffs.
 */
function obligations(
  sdd: string,
  state: Item,
  events: readonly Item[],
  token: string | undefined,
  admitted: boolean,
  packets: readonly Item[]
): string[] {
  const phase = String(state.phase ?? '')
  const out: string[] = []
  if (['SHIP', 'BLOCKED', 'CANCELLED'].includes(phase)) return ['REPORT_TERMINAL_OUTCOME']
  if (phase === 'PAUSED') return ['WAIT_USER_RESUME_OR_CANCEL']
  if (
    Number(state.round_completed_attempts ?? 0) >= 6 &&
    [
      'CONTRACT_DRAFT',
      'CONTRACT_AMENDED',
      'CONTRACT_ADMITTED',
      'OPERATOR_READBACK',
      'READBACK_APPROVED',
      'IMPLEMENTING',
      'OPERATOR_SELF_CHECK'
    ].includes(phase) &&
    !state.active_lease &&
    !state.pending_pipeline_repair
  )
    return ['WAIT_BUDGET_DECISION']
  if (state.pending_user_decision) out.push('WAIT_USER_DECISION')
  if (state.pending_execution_failure) out.push('READMIT_AFTER_EXECUTION_FAILURE')
  if (state.pending_pipeline_repair) out.push('RUN_PIPELINE_REPAIR_PROBE')
  if (state.execution_substrate_required) out.push('RECORD_EXECUTION_SUBSTRATE_RECEIPT')
  const ledger = creditLedger(state)
  // Only an enforced ledger blocks grants; an observed one reports overruns in budgets.credit.
  if (ledger && ledger.mode === 'enforce' && ledger.spent >= ledger.budget)
    out.push('REQUEST_CREDIT_EXTENSION')
  const deadlines = leaseDeadlines(state)
  if (deadlines.length) {
    // An expired or unverifiable deadline goes to the existing timeout handling, never to waiting.
    for (const deadline of deadlines)
      if (deadline.seconds_remaining === null)
        out.push(`LEASE_DEADLINE_UNVERIFIABLE:${deadline.lease_id}`)
      else if (deadline.seconds_remaining <= 0)
        out.push(`HANDLE_EXPIRED_LEASE:${deadline.lease_id}`)
    if (deadlines.some((deadline) => (deadline.seconds_remaining ?? 0) > 0))
      out.push('SUPERVISE_ACTIVE_LEASE')
    return out
  }
  const pending = packets.filter((packet) => packet.implemented !== true).map((p) => p.id)
  const byPhase: Record<string, string> = {
    DISCOVER: 'COMPLETE_DISCOVERY_THEN_ARCHITECT',
    ARCHITECT: 'CONVERGE_DESIGN_THEN_CONTRACT_DRAFT',
    CONTRACT_DRAFT: admitted ? 'TRANSITION_CONTRACT_ADMITTED' : 'RECORD_CONTRACT_ADMISSION',
    CONTRACT_AMENDED: admitted ? 'TRANSITION_OPERATOR_READBACK' : 'RECORD_CONTRACT_ADMISSION',
    CONTRACT_ADMITTED: 'PREPARE_ARCHITECT_AND_OPEN_READBACK',
    OPERATOR_READBACK:
      object(gateEvent(state, events, 'contract_readback')?.payload)?.assessment === 'ACCEPT'
        ? 'TRANSITION_READBACK_APPROVED'
        : gateEvent(state, events, 'contract_readback')
          ? 'DECIDE_READBACK_CHALLENGE'
          : 'DISPATCH_OPERATOR_READBACK',
    READBACK_APPROVED: 'TRANSITION_IMPLEMENTING',
    IMPLEMENTING: pending.length
      ? `DISPATCH_NEXT_PACKET:${pending[0]}`
      : 'TRANSITION_OPERATOR_SELF_CHECK',
    OPERATOR_SELF_CHECK:
      object(gateEvent(state, events, 'self_check')?.payload)?.handoff_status ===
      'READY_FOR_ARCHITECT'
        ? 'TRANSITION_ARCHITECT_VERIFY'
        : 'OBTAIN_READY_SELF_CHECK',
    ARCHITECT_VERIFY: gateEvent(state, events, 'verification')
      ? 'TRANSITION_COORDINATOR_TRIAGE'
      : 'DISPATCH_ARCHITECT_VERIFICATION',
    COORDINATOR_TRIAGE: 'TRIAGE_VERDICT_AND_RECORD_ATTEMPT',
    ROUND_CLOSED: 'OPEN_NEXT_ROUND_OR_FINAL_CANDIDATE',
    FINAL_CANDIDATE: 'TRANSITION_FINAL_VERIFY',
    FINAL_VERIFY: phase === 'FINAL_VERIFY' ? finalVerifyObligation(sdd, state, events, token) : ''
  }
  if (byPhase[phase]) out.push(byPhase[phase])
  return out
}

/**
 * Compact, deterministic Coordinator working memory. The Coordinator re-anchors on this after
 * every material step and after any context compaction instead of carrying event history,
 * role transcripts or diffs in its own context. It is a projection of signed state: when a
 * decision needs evidence, read that event by ID; never rebuild state from memory.
 */
export function coordinatorBrief(
  sdd: string,
  token = process.env.SDD_LOOP_COORDINATOR_TOKEN
): Item {
  const snapshot = readSnapshot(sdd)
  const state = snapshot.state as Item
  const events = parseEvents(snapshot.eventText)
  let admission: Item | undefined
  let admissionEventId: unknown = null
  try {
    const event = currentAdmission(state, events, token)
    admission = event.payload as Item
    admissionEventId = event.event_id
  } catch {
    /* Unadmitted, stale or unauthenticated admissions are reported as absent. */
  }
  const candidates = object(state.packet_candidates) ?? {}
  // Single-lease rounds implement packets without per-packet fingerprints; the signed
  // implementation claim after the current admission still marks the packet implemented.
  const admissionIndex = events.findIndex((event) => event.event_id === admissionEventId)
  const implementedPackets = new Set(
    events
      .slice(Math.max(0, admissionIndex))
      .filter((event) => admissionIndex >= 0 && event.type === 'implementation')
      .flatMap((event) => strings(object(event.payload)?.execution_packet_ids))
  )
  const checks = new Map<string, number>()
  for (const event of events)
    if (event.type === 'packet_check') {
      const id = String(object(event.payload)?.packet_id)
      checks.set(id, (checks.get(id) ?? 0) + 1)
    }
  const packets = (Array.isArray(admission?.execution_packets) ? admission.execution_packets : [])
    .map(object)
    .filter((packet): packet is Item => !!packet)
    .map((packet) => ({
      id: packet.id,
      depends_on: strings(packet.depends_on_packet_ids),
      modification_packages: strings(packet.modification_packages),
      test_budget: packet.test_budget ?? null,
      implemented:
        Object.hasOwn(candidates, String(packet.id)) || implementedPackets.has(String(packet.id)),
      packet_checks: checks.get(String(packet.id)) ?? 0
    }))
  const lease = object(state.active_lease)
  const issued = lease ? Date.parse(String(lease.issued_at)) : NaN
  const requirements = object(state.requirements) ?? {}
  const findings = Object.values(object(state.findings) ?? {})
    .map(object)
    .filter((finding): finding is Item => finding?.status === 'open')
    .map((finding) => ({ id: finding.id, priority: finding.priority }))
  const testUsage = operatorTestUsage(
    state,
    events,
    admission ?? {},
    admittedPacketIds(admission ?? {})
  )
  const preparation = object(state.preparation)
  const brief: Item = {
    protocol: 'coordinator-brief/v1',
    phase: state.phase,
    contract_revision: state.contract_revision ?? null,
    authority_epoch: state.authority_epoch ?? null,
    control_revision: state.revision ?? null,
    legal_next_phases: phaseTransitions()[state.phase as Phase] ?? [],
    obligations: obligations(sdd, state, events, token, !!admission, packets),
    lease_deadlines: leaseDeadlines(state),
    // The SHIP gate's verdict and exact rejection while final verification is under way.
    ship_gate: state.phase === 'FINAL_VERIFY' ? shipGate(sdd, state, events, token) : null,
    admission: admission
      ? {
          event_id: admissionEventId,
          requirement_ids: strings(admission.requirement_ids),
          acceptance_ids: strings(admission.acceptance_ids),
          packets
        }
      : null,
    active_lease: lease
      ? {
          ...(publicLease(lease) as Item),
          minutes_remaining: Number.isFinite(issued)
            ? Math.floor(
                (issued + Number(lease.hard_deadline_minutes) * 60000 - Date.now()) / 60000
              )
            : null
        }
      : null,
    shard_leases: Object.values(shardLeases(state)).map((item) => publicLease(item)),
    final_shard_verdicts: state.final_shard_verdicts ?? null,
    preparation: preparation
      ? {
          prepared_id: preparation.prepared_id,
          agent_id: preparation.agent_id,
          ready: typeof preparation.ready_event_id === 'string'
        }
      : null,
    requirements: {
      verified: Object.entries(requirements)
        .filter(([, status]) => status === 'verified')
        .map(([id]) => id),
      open: Object.entries(requirements)
        .filter(([, status]) => !['verified', 'deferred'].includes(String(status)))
        .map(([id]) => id)
    },
    open_findings: findings,
    pending: {
      user_decision: object(state.pending_user_decision)?.question ?? null,
      execution_failure: object(state.pending_execution_failure)?.root_cause_key ?? null,
      pipeline_repair: object(state.pending_pipeline_repair)?.root_cause_key ?? null,
      operator_recovery: !!state.operator_recovery,
      transaction_journal: existsSync(sidecarPaths(sdd).journal)
    },
    budgets: {
      round: { logical: state.logical_round ?? null, max: state.max_rounds ?? null },
      attempts: { round_completed: state.round_completed_attempts ?? 0, max: 6 },
      consecutive: {
        architect_rejections: state.consecutive_architect_rejections ?? 0,
        stagnant_attempts: state.consecutive_stagnant_attempts ?? 0
      },
      test_seconds: {
        round_spent: testUsage.round_spent_seconds,
        round_limit: testUsage.round_limit_seconds
      },
      credit: creditLedger(state)
        ? {
            ...creditLedger(state),
            over_budget: creditLedger(state)!.spent > creditLedger(state)!.budget
          }
        : null
    },
    recent_events: events.slice(-COORDINATOR_BRIEF_RECENT_EVENTS).map((event) => ({
      event_id: event.event_id,
      type: event.type,
      role: event.role
    })),
    event_count: snapshot.eventCount
  }
  // The fingerprint changes exactly when signed state or history changes: a stale brief is detectable.
  brief.brief_fingerprint = createHash('sha256')
    .update(`${snapshot.stateHash}:${snapshot.eventsHash}`)
    .digest('hex')
  return brief
}

/**
 * Read exactly one event by ID, without signature material. The brief names evidence IDs;
 * this is how the Coordinator inspects one of them without loading the event history.
 */
export function coordinatorEvent(sdd: string, eventId: string): Item {
  const matches = parseEvents(readSnapshot(sdd).eventText).filter(
    (event) => event.event_id === eventId
  )
  if (matches.length !== 1) throw new Error('COORDINATOR_EVENT_NOT_FOUND')
  const { signature: _signature, coordinator_proof: _proof, ...event } = matches[0]!
  return { protocol: 'coordinator-event/v1', event }
}
