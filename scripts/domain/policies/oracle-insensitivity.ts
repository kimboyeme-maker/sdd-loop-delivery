import { argvMatchesMethod } from './method-binding'

type Item = Record<string, unknown>
const record = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined

/**
 * An acceptance whose oracle sensitivity says the behaviour does not exist yet cannot already be
 * observable. If a signed run of that acceptance passed before this delivery produced anything at
 * all, the run observed something other than the claim — most often nothing at all, because a filtered command
 * that matches no case still exits 0. The evidence for this is already in the journal; nothing here
 * needs to know what any test runner's flags mean.
 *
 * Absence proves nothing either way: a delivery that never ran its acceptance early is not accused,
 * and neither is an early run of a *different* command. Only a run of the method the contract now
 * declares says anything about the oracle it now declares — the same distinction the role-evidence
 * gates draw between what was genuine then and what is current. Replacing an insensitive method is
 * therefore a real repair rather than a loophole: it takes a recorded, authorized amendment, and the
 * replacement has to survive this rule on its own runs.
 */
export function assertOracleSensitivity(contract: Item, events: readonly Item[]): void {
  // The anchor is this delivery's FIRST implementation receipt, not its latest. A later round's
  // runs legitimately precede their own receipt while the product change is already in the tree,
  // so measuring against the latest receipt would accuse every re-verification.
  const implementationIndex = events.findIndex((event) => event.type === 'implementation')
  if (implementationIndex < 0) return
  const required = new Map<string, string>()
  for (const value of Array.isArray(contract.acceptance) ? contract.acceptance : []) {
    const item = record(value)
    const sensitivity = record(item?.oracle_sensitivity)
    if (
      sensitivity?.applicability === 'REQUIRED' &&
      sensitivity.implementation_timing === 'IMPLEMENTATION_REQUIRED' &&
      typeof item?.id === 'string' &&
      typeof item.method === 'string'
    )
      required.set(item.id, item.method)
  }
  if (!required.size) return
  for (const [index, event] of events.entries()) {
    if (index >= implementationIndex || event.type !== 'test_run') continue
    const payload = record(event.payload)
    if (payload?.outcome !== 'PASS') continue
    const argv = (payload.argv as string[] | undefined) ?? []
    for (const id of (payload.acceptance_ids as unknown[]) ?? []) {
      const method = required.get(String(id))
      if (method !== undefined && argvMatchesMethod(argv, method))
        throw new Error(
          `ACCEPTANCE_ORACLE_INSENSITIVE: ${String(id)} passed before its implementation (${String(event.event_id)})`
        )
    }
  }
}
