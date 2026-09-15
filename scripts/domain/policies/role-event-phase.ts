import type { Phase } from './phase'

/** One source for product role events and their legal lifecycle stages.
 * Capability authentication for a dedicated pipeline probe is checked separately:
 * it must not grant permission to submit product evidence in the preserved stage.
 */
export const ROLE_EVENT_PHASES: Readonly<
  Record<'operator' | 'architect', Readonly<Record<string, readonly Phase[]>>>
> = {
  operator: {
    context_refresh: [
      'OPERATOR_READBACK',
      'READBACK_APPROVED',
      'IMPLEMENTING',
      'OPERATOR_SELF_CHECK'
    ],
    capability_probe: ['OPERATOR_READBACK', 'IMPLEMENTING', 'OPERATOR_SELF_CHECK'],
    agent_started: ['OPERATOR_READBACK', 'IMPLEMENTING', 'OPERATOR_SELF_CHECK'],
    contract_readback: ['OPERATOR_READBACK'],
    plan_challenge: ['OPERATOR_READBACK'],
    implementation_escalation: ['IMPLEMENTING'],
    implementation: ['IMPLEMENTING'],
    self_check: ['OPERATOR_SELF_CHECK'],
    checkpoint: ['OPERATOR_READBACK', 'IMPLEMENTING', 'OPERATOR_SELF_CHECK'],
    dependency_operation_proposal: ['OPERATOR_READBACK', 'IMPLEMENTING'],
    test_run: ['IMPLEMENTING', 'OPERATOR_SELF_CHECK']
  },
  architect: {
    capability_probe: [
      'CONTRACT_DRAFT',
      'CONTRACT_AMENDED',
      'COORDINATOR_TRIAGE',
      'ARCHITECT_VERIFY',
      'FINAL_VERIFY'
    ],
    agent_started: [
      'CONTRACT_DRAFT',
      'CONTRACT_AMENDED',
      'COORDINATOR_TRIAGE',
      'ARCHITECT_VERIFY',
      'FINAL_VERIFY'
    ],
    design_proposal: ['CONTRACT_DRAFT', 'CONTRACT_AMENDED', 'COORDINATOR_TRIAGE'],
    dependency_safety_review: [
      'CONTRACT_DRAFT',
      'CONTRACT_AMENDED',
      'OPERATOR_READBACK',
      'IMPLEMENTING',
      'COORDINATOR_TRIAGE'
    ],
    verification: ['ARCHITECT_VERIFY', 'FINAL_VERIFY'],
    test_run: ['ARCHITECT_VERIFY', 'FINAL_VERIFY'],
    finding: ['ARCHITECT_VERIFY', 'FINAL_VERIFY'],
    checkpoint: ['ARCHITECT_VERIFY', 'FINAL_VERIFY']
  }
}

/** Reject mismatched roles or phases before the caller persists any receipt. */
export function assertRoleEventPhase(
  role: string,
  type: string,
  phase: unknown,
  verificationMode?: unknown
): void {
  if (role !== 'operator' && role !== 'architect') throw new Error('AGENT_ROLE_INVALID')
  // Dependency counsel needs authentication in these stages, not product verification authority.
  if (
    role === 'architect' &&
    verificationMode === 'design-counsel' &&
    ['capability_probe', 'agent_started'].includes(type) &&
    ['OPERATOR_READBACK', 'IMPLEMENTING'].includes(String(phase))
  )
    return
  const phases = ROLE_EVENT_PHASES[role][type]
  if (!phases) throw new Error('AGENT_EVENT_ROLE_FORBIDDEN')
  if (!phases.includes(phase as Phase))
    throw new Error(`AGENT_EVENT_STATE_INVALID: ${role}/${type} in ${String(phase)}`)
}
