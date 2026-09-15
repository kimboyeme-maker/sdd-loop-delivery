import { eventsOfType } from '../utils/event-index'
type Item = Record<string, unknown>
const object = (value: unknown): Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {}

/** What the host lifecycle of a retired runtime needs next, from its recorded facts. */
export type CloseDecision =
  | 'NONE'
  | 'CLOSE'
  | 'CLOSE_UNAVAILABLE'
  | 'RETRY_BLOCKED'
  | 'RELEASE_UNCONFIRMED'
  | 'DONE'

/** Host facts a close depends on; a retry is justified only when one of these changed. */
function closeFacts(record: Item | undefined): string | null {
  if (!record) return null
  const host = object(record.host)
  return JSON.stringify([
    host.close_available ?? null,
    host.controllable ?? null,
    host.status ?? null
  ])
}

/**
 * One decision from a runtime's records (in order). A CLOSED result with released capacity is done;
 * without released capacity it is reported, never re-closed. A FAILED, UNKNOWN or UNAVAILABLE close
 * is retried only when a later observation changed the facts a close depends on (close
 * availability, control, host status); another observation with the same facts is not a change.
 * A close is never suggested while the latest observation says this session cannot close.
 */
export function closeDecision(records: readonly Item[]): CloseDecision {
  const retiredAt = records.findLastIndex((record) => record.action === 'retire')
  if (retiredAt < 0) return 'NONE'
  const observe = (list: readonly Item[]) => list.findLast((record) => record.action === 'observe')
  const latestObservation = observe(records)
  const sessionCannotClose = object(latestObservation?.host).close_available === false
  const after = records.slice(retiredAt + 1)
  const closeAt = after.findLastIndex((record) => record.action === 'close_result')
  if (closeAt < 0) return sessionCannotClose ? 'CLOSE_UNAVAILABLE' : 'CLOSE'
  const close = after[closeAt]!
  if (close.result === 'CLOSED')
    return close.capacity_released === true ? 'DONE' : 'RELEASE_UNCONFIRMED'
  const absoluteCloseAt = retiredAt + 1 + closeAt
  const before = closeFacts(observe(records.slice(0, absoluteCloseAt)))
  const later = observe(records.slice(absoluteCloseAt + 1))
  if (!later || closeFacts(later) === before) return 'RETRY_BLOCKED'
  return sessionCannotClose ? 'CLOSE_UNAVAILABLE' : 'CLOSE'
}

/** Whether a new runtime may be proposed after the host's recorded capacity outcomes. */
export type SpawnDecision = 'ALLOWED' | 'LIMIT_UNCHANGED'

/**
 * After a spawn returned LIMIT, another spawn is proposed only once capacity demonstrably changed:
 * a later close released capacity, a later spawn succeeded, or a later capacity observation with
 * free slots that no spawn attempt has consumed yet and that differs from any observation recorded
 * before the LIMIT. Each new observation therefore permits one attempt; repeating the same
 * evidence permits none.
 */
export function spawnDecision(events: readonly Item[]): SpawnDecision {
  const records = eventsOfType(events, 'runtime_record').map((event) => object(event.payload))
  const limitAt = records.findLastIndex(
    (record) => record.action === 'spawn_result' && record.result === 'LIMIT'
  )
  if (limitAt < 0) return 'ALLOWED'
  const key = (record: Item) => {
    const capacity = object(record.capacity)
    return JSON.stringify([capacity.observed_at, capacity.available_slots, capacity.source])
  }
  const known = new Set(
    records
      .slice(0, limitAt)
      .filter((record) => record.action === 'capacity')
      .map(key)
  )
  const after = records.slice(limitAt + 1)
  if (
    after.some(
      (record) =>
        (record.action === 'close_result' && record.capacity_released === true) ||
        (record.action === 'spawn_result' && record.result === 'CREATED')
    )
  )
    return 'ALLOWED'
  const freshAt = after.findLastIndex(
    (record) =>
      record.action === 'capacity' &&
      Number(object(record.capacity).available_slots) > 0 &&
      !known.has(key(record))
  )
  if (freshAt < 0) return 'LIMIT_UNCHANGED'
  return after.slice(freshAt + 1).some((record) => record.action === 'spawn_result')
    ? 'LIMIT_UNCHANGED'
    : 'ALLOWED'
}
