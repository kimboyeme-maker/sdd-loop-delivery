import { pointAt } from '../resource/store/event-window'
import type { EventLogPoint } from '../resource/store/event-log-binding'
import { lastIndexOfType } from '../utils/event-index'

type Item = Record<string, unknown>

/** Keys whose values name events: `*_event_id`, `*_event_ids` and a lease's `guidance_id`. */
const REFERENCE_KEY = /(^|_)event_ids?$|^guidance_id$/

/** Every event a live grant (active lease, shard leases, preparation) refers to. */
export function liveEventReferences(state: Item): string[] {
  const found = new Set<string>()
  const visit = (value: unknown, key = ''): void => {
    if (typeof value === 'string') {
      if (REFERENCE_KEY.test(key)) found.add(value)
    } else if (Array.isArray(value)) for (const item of value) visit(item, key)
    else if (value && typeof value === 'object')
      for (const [name, item] of Object.entries(value)) visit(item, name)
  }
  visit({
    active_lease: state.active_lease,
    shard_leases: state.shard_leases,
    preparation: state.preparation
  })
  return [...found]
}

/**
 * The checkpoint recorded when a round closes: the earliest event any round-scoped rule can still
 * need, which is the current admission, the latest implementation and the first event of every live
 * grant. Everything from there on stays readable as one contiguous window, so "the latest X" and
 * "anything after X" read the same in the window as in the whole log.
 */
export function roundCheckpoint(
  nextState: Item,
  events: readonly Item[],
  bytes: Uint8Array
): EventLogPoint {
  const positions = new Map<unknown, number>()
  events.forEach((event, position) => {
    if (!positions.has(event.event_id)) positions.set(event.event_id, position)
  })
  const anchors = [
    lastIndexOfType(events, 'contract_admission'),
    lastIndexOfType(events, 'implementation'),
    ...liveEventReferences(nextState).map((id) => positions.get(id) ?? 0)
  ].filter((position) => position >= 0)
  return pointAt(bytes, Math.min(events.length, ...anchors))
}

/**
 * Events for rules that only consult the current round, the current admission and candidate, and
 * live grants: the checkpoint window when it holds every event the live grants refer to, otherwise
 * the whole history. Rules about history as a whole (independence, role history, runtime lifecycle,
 * lineage, SHIP) must keep reading the whole history: absence in a window proves nothing.
 */
export function roundScopedEvents(
  state: Item,
  window: () => Item[] | null,
  full: () => Item[]
): Item[] {
  const scoped = window()
  if (!scoped) return full()
  const ids = new Set(scoped.map((event) => event.event_id))
  return liveEventReferences(state).every((id) => ids.has(id)) ? scoped : full()
}
