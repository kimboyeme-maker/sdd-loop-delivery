import { eventsWithId } from '../utils/event-index'
import { assertRoleEvidence } from './role-evidence'

/** A lease marker points to a signed start receipt; it cannot replace that receipt. */
export function assertStartedEvidence(
  state: Record<string, unknown>,
  lease: Record<string, unknown>,
  events: readonly Record<string, unknown>[]
): void {
  const matches = eventsWithId(events, lease.started_event_id)
  const event = matches[0]
  if (
    matches.length !== 1 ||
    !event ||
    event.type !== 'agent_started' ||
    (event.actor as Record<string, unknown> | undefined)?.lease_id !== lease.lease_id
  )
    throw new Error('AGENT_START_EVIDENCE_INVALID')
  assertRoleEvidence(state, event, String(lease.role))
}
