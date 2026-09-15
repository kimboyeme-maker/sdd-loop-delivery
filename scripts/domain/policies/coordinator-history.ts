import { isRuntimeIdentity } from '../../helpers/runtime-identity'

/** Preserve exact Coordinator identities; malformed history cannot become an empty list.
 * Optional absence supports a native task before its first identity is recorded.
 * This validates recorded data, not completeness or host provenance of that history.
 */
export function coordinatorHistory(state: Record<string, unknown>, nextId?: string): string[] {
  const history = state.coordinator_agent_ids
  if (history !== undefined && (!Array.isArray(history) || !history.every(isRuntimeIdentity)))
    throw new Error('COORDINATOR_HISTORY_INVALID')
  const current = state.coordinator_agent_id
  if (current != null && !isRuntimeIdentity(current)) throw new Error('COORDINATOR_HISTORY_INVALID')
  if (nextId !== undefined && !isRuntimeIdentity(nextId))
    throw new Error('COORDINATOR_HISTORY_INVALID')
  return [
    ...new Set([
      ...((history as string[] | undefined) ?? []),
      ...(current == null ? [] : [current as string]),
      ...(nextId === undefined ? [] : [nextId])
    ])
  ]
}
