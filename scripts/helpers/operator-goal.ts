import { createHash } from 'node:crypto'
import { canonicalJson } from '../resource/wire/canonical-json'
import { assertRoleEvidence } from './role-evidence'
type Item = Record<string, unknown>
const protocol = 'operator-assignment-goal/v1'

/** Describe the role-owned Goal for this phase; the controller does not create or pause host Goals. */
export function operatorGoalBinding(state: Item, lease: Item): Item | null {
  if (lease.role !== 'operator' || lease.operator_goal !== 'required' || lease.repair_probe_root)
    return null
  const completion = (
    {
      OPERATOR_READBACK: 'contract_readback',
      IMPLEMENTING: 'implementation',
      OPERATOR_SELF_CHECK: 'self_check'
    } as Record<string, string>
  )[String(state.phase)]
  if (!completion) return null
  const core = {
    protocol,
    lease_id: lease.lease_id,
    authority_epoch: lease.authority_epoch,
    contract_revision: lease.contract_revision,
    state: state.phase,
    work_item: lease.work_item,
    completion_event: completion,
    objective: `Complete Operator phase ${state.phase} for ${lease.work_item} under lease ${lease.lease_id}; continue across turns until the controller accepts direct ${completion} evidence, then mark this Goal complete.`,
    stop_conditions: [
      'The lease is revoked or expired.',
      'A controller authority gate requires Coordinator action.',
      'The user stops or pauses the task.',
      'A real host, tool, permission, or design blocker is evidenced.'
    ]
  }
  return { ...core, fingerprint: createHash('sha256').update(canonicalJson(core)).digest('hex') }
}

/** Require a direct role acknowledgment, distinct from accepted implementation evidence. */
export function requireOperatorGoalAck(
  state: Item,
  events: readonly Item[],
  lease: Item,
  payload: Item,
  eventType: string
): void {
  const binding = operatorGoalBinding(state, lease)
  if (!binding) {
    if (payload.goal_ack != null) throw new Error('OPERATOR_GOAL_ACK_UNEXPECTED')
    return
  }
  if (eventType !== 'agent_started' && eventType !== binding.completion_event) return
  const expected = { protocol, fingerprint: binding.fingerprint, created: true }
  const matches = (value: unknown) =>
    value != null && canonicalJson(value) === canonicalJson(expected)
  if (matches(payload.goal_ack)) return
  if (eventType !== 'agent_started')
    for (const event of [...events].reverse()) {
      if (
        (event.actor as Item | undefined)?.lease_id !== lease.lease_id ||
        !matches((event.payload as Item | undefined)?.goal_ack)
      )
        continue
      assertRoleEvidence(state, event, 'operator')
      return
    }
  throw new Error('OPERATOR_GOAL_ACK_REQUIRED')
}
