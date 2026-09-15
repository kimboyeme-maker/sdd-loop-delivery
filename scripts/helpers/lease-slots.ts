type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined

/**
 * Lease slots. `active_lease` is the single writer or verifier slot; `shard_leases` holds extra
 * concurrent Architect leases that verify disjoint final-verification shards. Only read-only
 * FINAL_VERIFY shard leases may coexist, so every writer path still sees one lease.
 */
export function shardLeases(state: Item): Record<string, Item> {
  return (object(state.shard_leases) ?? {}) as Record<string, Item>
}

/** Every live lease, primary first. */
export function leaseSlots(state: Item): Item[] {
  const primary = object(state.active_lease)
  return [...(primary ? [primary] : []), ...Object.values(shardLeases(state))]
}

/** The live lease with this ID, from either slot. */
export function findLease(state: Item, leaseId: string): Item | undefined {
  return leaseSlots(state).find((lease) => lease.lease_id === leaseId)
}

/** The live lease held by this runtime; shard leases are held by distinct Architects. */
export function findLeaseByAgent(state: Item, agentId: string): Item | undefined {
  return leaseSlots(state).find((lease) => lease.agent_id === agentId)
}

/** State fields that store `lease` back into the slot it came from. */
export function storeLease(state: Item, lease: Item): Item {
  if (object(state.active_lease)?.lease_id === lease.lease_id) return { active_lease: lease }
  return { shard_leases: { ...shardLeases(state), [String(lease.lease_id)]: lease } }
}

/** State fields that release one lease; a released primary slot stays empty. */
export function releaseLease(state: Item, leaseId: string): Item {
  if (object(state.active_lease)?.lease_id === leaseId) return { active_lease: null }
  const rest = { ...shardLeases(state) }
  delete rest[leaseId]
  return { shard_leases: rest }
}

/** The acceptance a shard lease verifies, or undefined for an unsharded lease. */
export function shardAcceptance(lease: Item | undefined): string[] | undefined {
  return typeof lease?.verification_shard === 'string' && Array.isArray(lease.acceptance_ids)
    ? (lease.acceptance_ids as string[])
    : undefined
}

/**
 * Bootstrap progress of one lease. Concurrent shard leases bootstrap independently, so receipts
 * are kept per lease.
 */
export function bootstrapReceiptFor(state: Item, leaseId: unknown): Item | undefined {
  return object(object(state.bootstrap_receipts)?.[String(leaseId)])
}

/**
 * Seconds until each live lease's hard deadline, from its absolute issue time; null when the
 * deadline cannot be computed. Nearest first.
 */
export function leaseDeadlines(
  state: Item,
  now = Date.now()
): { lease_id: string; role: string; seconds_remaining: number | null }[] {
  return leaseSlots(state)
    .map((lease) => {
      const issued = Date.parse(String(lease.issued_at))
      const minutes = Number(lease.hard_deadline_minutes)
      return {
        lease_id: String(lease.lease_id),
        role: String(lease.role),
        seconds_remaining:
          Number.isFinite(issued) && Number.isFinite(minutes) && minutes > 0
            ? Math.floor((issued + minutes * 60_000 - now) / 1000)
            : null
      }
    })
    .sort((a, b) => (a.seconds_remaining ?? -Infinity) - (b.seconds_remaining ?? -Infinity))
}
