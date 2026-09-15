import { leaseSlots } from '../helpers/lease-slots'
type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined

/** Terminal controller phases; the Coordinator only reports after reaching one. */
const TERMINAL = new Set(['SHIP', 'BLOCKED', 'CANCELLED'])

/** Map a controller phase to one compact user-facing Coordinator activity. */
function coordinatorWork(phase: string): string {
  if (phase === 'DISCOVER') return 'inventory and decision discovery'
  if (phase === 'ARCHITECT') return 'architecture and decision closure'
  if (['CONTRACT_DRAFT', 'CONTRACT_ADMITTED', 'CONTRACT_AMENDED'].includes(phase))
    return 'packet admission'
  if (['COORDINATOR_TRIAGE', 'ROUND_CLOSED'].includes(phase)) return 'finding triage and replanning'
  if (['FINAL_CANDIDATE', 'FINAL_VERIFY'].includes(phase)) return 'final gate'
  if (TERMINAL.has(phase)) return 'terminal reporting'
  return 'orchestration and supervision'
}

/**
 * Public Working row and pipeline health for Supervisor progress panels.
 * It lists only agents that hold a recorded grant, never intended dispatches,
 * and exposes no capability hashes, locators or private context.
 */
export function processView(state: Item): Item {
  const phase = String(state.phase ?? '')
  const pipeline = object(state.pending_pipeline_repair)
  const budgetWait =
    !pipeline &&
    leaseSlots(state).length === 0 &&
    Number(state.round_completed_attempts ?? 0) >= 6 &&
    [
      'CONTRACT_DRAFT',
      'CONTRACT_AMENDED',
      'CONTRACT_ADMITTED',
      'OPERATOR_READBACK',
      'READBACK_APPROVED',
      'IMPLEMENTING',
      'OPERATOR_SELF_CHECK'
    ].includes(phase)
  const status = TERMINAL.has(phase)
    ? 'TERMINAL'
    : phase === 'PAUSED'
      ? 'PAUSED'
      : object(state.pending_user_decision) || budgetWait
        ? 'WAITING_USER'
        : pipeline
          ? 'PIPELINE_REPAIR'
          : 'WORKING'
  const working: Item[] = [
    {
      role: 'coordinator',
      agent_id: state.coordinator_agent_id ?? null,
      status,
      work: pipeline
        ? `pipeline repair: ${String(pipeline.root_cause_key ?? 'unknown')}`
        : coordinatorWork(phase)
    }
  ]
  for (const lease of leaseSlots(state)) {
    const probe = lease.repair_probe_root
    working.push({
      role: lease.role,
      agent_id: lease.agent_id,
      status: lease.started_event_id ? 'WORKING' : 'DISPATCHED',
      work: probe ? `pipeline repair probe: ${String(probe)}` : (lease.work_item ?? null),
      lease_id: lease.lease_id,
      packet_id: lease.packet_id ?? null,
      started_event_id: lease.started_event_id ?? null,
      issued_at: lease.issued_at ?? null
    })
  }
  const preparation = object(state.preparation)
  if (preparation)
    working.push({
      role: 'architect',
      agent_id: preparation.agent_id,
      status: preparation.ready_event_id ? 'CONTEXT_READY' : 'PREPARING_CONTEXT',
      work: preparation.work_item ?? 'read-only verification preparation',
      prepared_id: preparation.prepared_id,
      issued_at: preparation.issued_at ?? null
    })
  return {
    controller_phase: phase,
    loop_status: TERMINAL.has(phase) ? phase : status,
    wait_reason:
      phase === 'PAUSED'
        ? 'USER_PAUSE'
        : state.pending_user_decision
          ? 'USER_DECISION'
          : budgetWait
            ? 'BUDGET_DECISION'
            : pipeline
              ? 'PIPELINE_REPAIR'
              : 'NONE',
    working_agents: working,
    // Last Coordinator host observation and any pending preserve-and-inspect obligation.
    operator_reconcile: object(state.last_operator_reconcile) ?? null,
    operator_recovery: object(state.operator_recovery) ?? null,
    pending_user_decision: object(state.pending_user_decision)
      ? {
          authority_basis: object(state.pending_user_decision)!.authority_basis ?? null,
          question: object(state.pending_user_decision)!.question ?? null
        }
      : null,
    pipeline: pipeline
      ? {
          status: object(state.active_lease) ? 'PROBING' : 'REPAIR_REQUIRED',
          root_cause_key: pipeline.root_cause_key ?? null,
          probe_failures: pipeline.probe_failures ?? 0
        }
      : { status: 'HEALTHY' }
  }
}
