type Item = Record<string, unknown>
type Index = Readonly<{
  length: number
  byId: Map<unknown, Item[]>
  byType: Map<unknown, number[]>
}>

const indexes = new WeakMap<readonly Item[], Index>()

/**
 * Lookup tables over one event array, built once per array and reused by every rule of a command.
 * An array whose length changed since indexing (a caller appended to it) is indexed again.
 */
function indexFor(events: readonly Item[]): Index {
  const cached = indexes.get(events)
  if (cached && cached.length === events.length) return cached
  const byId = new Map<unknown, Item[]>()
  const byType = new Map<unknown, number[]>()
  events.forEach((event, position) => {
    const ids = byId.get(event.event_id)
    if (ids) ids.push(event)
    else byId.set(event.event_id, [event])
    const types = byType.get(event.type)
    if (types) types.push(position)
    else byType.set(event.type, [position])
  })
  const index = { length: events.length, byId, byType }
  indexes.set(events, index)
  return index
}

/** Every event with this ID, in log order; more than one means a duplicated ID. */
export function eventsWithId(events: readonly Item[], id: unknown): Item[] {
  return [...(indexFor(events).byId.get(id) ?? [])]
}

/** Every event of this type, in log order. */
export function eventsOfType(events: readonly Item[], type: string): Item[] {
  return (indexFor(events).byType.get(type) ?? []).map((position) => events[position]!)
}

/** Position of the last event of this type, or -1. */
export function lastIndexOfType(events: readonly Item[], type: string): number {
  return indexFor(events).byType.get(type)?.at(-1) ?? -1
}
