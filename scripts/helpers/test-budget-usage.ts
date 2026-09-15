import { TEST_RETRY_BUDGET_MULTIPLIER } from '../config/constants'

type Item = Record<string, unknown>
const object = (value: unknown): Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {}

/** Declared test seconds of the named admitted packets (one pass, without retries). */
export function packetBudgetSeconds(admission: Item, packetIds: readonly string[]): number {
  return (Array.isArray(admission.execution_packets) ? admission.execution_packets : [])
    .map(object)
    .filter((packet) => packetIds.includes(String(packet.id)))
    .reduce((sum, packet) => sum + Number(object(packet.test_budget).minutes ?? 0) * 60, 0)
}

/** Every admitted packet ID; a lease without a packet works on all of them. */
export function admittedPacketIds(admission: Item): string[] {
  return (Array.isArray(admission.execution_packets) ? admission.execution_packets : [])
    .map(object)
    .map((packet) => String(packet.id))
}

export type TestUsage = Readonly<{
  packet_budget_seconds: number
  packet_limit_seconds: number
  packet_spent_seconds: number
  round_limit_seconds: number
  round_spent_seconds: number
  remaining_seconds: number
}>

/**
 * Operator test time measured by the controller in the current round, for the named packets and
 * for the whole round, each against its own limit (budget × retry multiplier). Derived from signed
 * `test_run` events, so the execution entry, the handoff and the brief read one computation.
 */
export function operatorTestUsage(
  state: Item,
  events: readonly Item[],
  admission: Item,
  packetIds: readonly string[]
): TestUsage {
  const roundStart = events.findLastIndex(
    (event) => event.type === 'state_transition' && object(event.payload).to === 'ROUND_CLOSED'
  )
  const leases = object(state.issued_leases)
  let packetSpent = 0
  let roundSpent = 0
  for (const event of events.slice(roundStart + 1)) {
    if (event.type !== 'test_run' || event.role !== 'operator') continue
    const seconds = Number(object(event.payload).duration_seconds ?? 0)
    roundSpent += seconds
    const packet = object(leases[String(object(event.actor).lease_id)]).packet_id
    // A run under a lease without a packet served every packet it could observe.
    if (typeof packet !== 'string' || packetIds.includes(packet)) packetSpent += seconds
  }
  const packetBudget = packetBudgetSeconds(admission, packetIds)
  const roundBudget = packetBudgetSeconds(admission, admittedPacketIds(admission))
  const packetLimit = packetBudget * TEST_RETRY_BUDGET_MULTIPLIER
  const roundLimit = roundBudget * TEST_RETRY_BUDGET_MULTIPLIER
  return {
    packet_budget_seconds: packetBudget,
    packet_limit_seconds: packetLimit,
    packet_spent_seconds: packetSpent,
    round_limit_seconds: roundLimit,
    round_spent_seconds: roundSpent,
    remaining_seconds: Math.max(0, Math.min(packetLimit - packetSpent, roundLimit - roundSpent))
  }
}
