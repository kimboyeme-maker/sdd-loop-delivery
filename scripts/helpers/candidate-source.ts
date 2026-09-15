import { existsSync, realpathSync } from 'node:fs'
import { assertRoleEvidence } from './role-evidence'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined

/** The latest Operator implementation of this revision: the candidate every run observes. */
function latestImplementation(state: Item, events: readonly Item[]): Item | undefined {
  return events.findLast(
    (item) =>
      item.type === 'implementation' &&
      item.role === 'operator' &&
      item.contract_revision === state.contract_revision
  )
}

/** Event ID of the current candidate, or null before any implementation. */
export function currentCandidateEventId(state: Item, events: readonly Item[]): string | null {
  const event = latestImplementation(state, events)
  return typeof event?.event_id === 'string' ? event.event_id : null
}

/**
 * Real path of the product worktree that holds the current candidate, traced through the
 * authenticated implementation event to the Operator lease that produced it. Round-scoped state
 * (the frozen baseline) may retire; the candidate's source does not.
 */
export function candidateProductRoot(state: Item, events: readonly Item[]): string | null {
  const event = latestImplementation(state, events)
  if (!event) return null
  assertRoleEvidence(state, event, 'operator')
  const lease = object(object(state.issued_leases)?.[String(object(event.actor)?.lease_id)])
  const root = lease?.worktree_root
  if (typeof root !== 'string' || !existsSync(root)) throw new Error('CANDIDATE_SOURCE_UNRESOLVED')
  return realpathSync(root)
}
