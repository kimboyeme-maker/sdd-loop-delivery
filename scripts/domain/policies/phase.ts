/** Product lifecycle stages; runtime idleness and pipeline incidents are not stages. */
export type Phase =
  | 'DISCOVER'
  | 'ARCHITECT'
  | 'CONTRACT_DRAFT'
  | 'CONTRACT_ADMITTED'
  | 'OPERATOR_READBACK'
  | 'READBACK_APPROVED'
  | 'IMPLEMENTING'
  | 'OPERATOR_SELF_CHECK'
  | 'ARCHITECT_VERIFY'
  | 'COORDINATOR_TRIAGE'
  | 'CONTRACT_AMENDED'
  | 'ROUND_CLOSED'
  | 'FINAL_CANDIDATE'
  | 'FINAL_VERIFY'
  | 'SHIP'
  | 'BLOCKED'

const TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  DISCOVER: ['ARCHITECT', 'BLOCKED'],
  ARCHITECT: ['CONTRACT_DRAFT', 'BLOCKED'],
  CONTRACT_DRAFT: ['CONTRACT_ADMITTED', 'BLOCKED'],
  CONTRACT_ADMITTED: ['OPERATOR_READBACK', 'BLOCKED'],
  OPERATOR_READBACK: ['READBACK_APPROVED', 'CONTRACT_AMENDED', 'BLOCKED'],
  READBACK_APPROVED: ['IMPLEMENTING', 'BLOCKED'],
  IMPLEMENTING: ['OPERATOR_SELF_CHECK', 'CONTRACT_AMENDED', 'BLOCKED'],
  OPERATOR_SELF_CHECK: ['ARCHITECT_VERIFY', 'IMPLEMENTING', 'BLOCKED'],
  ARCHITECT_VERIFY: ['COORDINATOR_TRIAGE', 'BLOCKED'],
  COORDINATOR_TRIAGE: ['CONTRACT_AMENDED', 'ROUND_CLOSED', 'FINAL_CANDIDATE', 'BLOCKED'],
  CONTRACT_AMENDED: ['OPERATOR_READBACK', 'BLOCKED'],
  ROUND_CLOSED: ['CONTRACT_DRAFT', 'FINAL_CANDIDATE', 'BLOCKED'],
  FINAL_CANDIDATE: ['FINAL_VERIFY', 'BLOCKED'],
  FINAL_VERIFY: ['SHIP', 'COORDINATOR_TRIAGE', 'BLOCKED'],
  SHIP: [],
  BLOCKED: []
}

/** Clear only evidence belonging to the stage being entered; keep audit history. */
export const ROLE_EVIDENCE_ON_ENTRY: Partial<Record<Phase, readonly string[]>> = {
  OPERATOR_READBACK: ['contract_readback'],
  IMPLEMENTING: ['implementation'],
  OPERATOR_SELF_CHECK: ['self_check'],
  ARCHITECT_VERIFY: ['verification'],
  FINAL_VERIFY: ['verification']
}

/** Controller phases after which no evidence, status or grant may change. */
export const TERMINAL_PHASES: readonly string[] = ['SHIP', 'BLOCKED', 'CANCELLED']

/** One mutation guard for every writer: terminal loops are immutable and a paused loop
 * accepts only user-control resume/cancel and authority recovery.
 */
export function assertMutablePhase(phase: unknown): void {
  if (TERMINAL_PHASES.includes(String(phase))) throw new Error('TERMINAL_STATE_IMMUTABLE')
  if (phase === 'PAUSED')
    throw new Error('LOOP_PAUSED: only user-control resume or cancel is allowed')
}

export function assertPhaseTransition(from: Phase, to: Phase): void {
  if (!TRANSITIONS[from]?.includes(to)) throw new Error('PHASE_TRANSITION_DENIED')
}

export function phaseTransitions(): Readonly<Record<Phase, readonly Phase[]>> {
  return TRANSITIONS
}

/** Host resource facts a finished or paused delivery still accepts: retiring, closing, observing. */
export const WIND_DOWN_ACTIONS: readonly string[] = ['retire', 'close_result', 'observe']

/**
 * Runtime records follow the mutable-phase rule, except resource wind-down after SHIP, BLOCKED,
 * CANCELLED or PAUSED: closing host runtimes may finish after the product is done. Product state,
 * authority and acceptance evidence remain immutable; no other runtime action is accepted then.
 */
export function assertRuntimeRecordPhase(phase: unknown, action: unknown): void {
  if (
    (TERMINAL_PHASES.includes(String(phase)) || phase === 'PAUSED') &&
    WIND_DOWN_ACTIONS.includes(String(action))
  )
    return
  assertMutablePhase(phase)
}
