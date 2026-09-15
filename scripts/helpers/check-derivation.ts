import { eventsWithId } from '../utils/event-index'
type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/**
 * Fill a reported check from the facts the controller already holds, so a role names only what it
 * observed (`acceptance_ids`) and the run that observed it (`test_run_event_id`):
 * - method, oracle and environment come from the contract when every named acceptance agrees,
 *   and packages are the union of their declared packages;
 * - outcome and duration_seconds come from the cited controller-measured run.
 * A supplied value is kept; a measured value that contradicts the run is rejected here, and every
 * other supplied value still meets the existing binding checks.
 */
export function deriveCheck(contract: Item, events: readonly Item[], value: unknown): unknown {
  const check = object(value)
  const acceptanceIds = strings(check?.acceptance_ids)
  if (!check || !acceptanceIds.length) return value
  const derived: Item = {}
  const definitions = acceptanceIds
    .map((id) =>
      (Array.isArray(contract.acceptance) ? contract.acceptance : [])
        .map(object)
        .find((item) => item?.id === id)
    )
    .filter((item): item is Item => !!item)
  if (definitions.length === acceptanceIds.length) {
    for (const field of ['method', 'oracle', 'environment']) {
      const values = new Set(definitions.map((item) => item[field]))
      if (values.size === 1 && typeof definitions[0]![field] === 'string')
        derived[field] = definitions[0]![field]
    }
    derived.packages = [...new Set(definitions.flatMap((item) => strings(item.packages)))].sort()
  }
  if (typeof check.test_run_event_id === 'string') {
    const runs = eventsWithId(events, check.test_run_event_id)
    const measured =
      runs.length === 1 && runs[0]!.type === 'test_run' ? object(runs[0]!.payload) : undefined
    if (measured) {
      for (const field of ['outcome', 'duration_seconds'])
        if (Object.hasOwn(check, field) && check[field] !== measured[field])
          throw new Error('VERIFICATION_CHECK_MEASUREMENT_MISMATCH')
      derived.outcome = measured.outcome
      derived.duration_seconds = measured.duration_seconds
    }
  }
  return { ...derived, ...check }
}

/** Derive every check of a role payload that carries `checks`. */
export function deriveChecks(contract: Item, events: readonly Item[], checks: unknown): unknown {
  return Array.isArray(checks)
    ? checks.map((check) => deriveCheck(contract, events, check))
    : checks
}
