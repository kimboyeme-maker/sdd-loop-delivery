type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(text) &&
  new Set(value).size === value.length

/** Outcomes a prepared Architect may observe. */
const OUTCOMES = ['PASS', 'FAIL', 'INCONCLUSIVE']

/**
 * A prepared check (baseline or packet) copies the contract's exact method, oracle, environment
 * and packages for acceptance the caller allows, and records its own outcome and evidence. It is
 * preparation information: it finds failures early but never stands in for a verification check,
 * because it is neither controller-measured nor bound to the complete execution inputs.
 */
export function assertPreparedChecks(
  contract: Item,
  allowedAcceptance: readonly string[],
  checks: unknown
): void {
  if (!Array.isArray(checks) || !checks.length) throw new Error('PREPARED_CHECKS_REQUIRED')
  const definitions = new Map(
    (Array.isArray(contract.acceptance) ? contract.acceptance : [])
      .map(object)
      .filter((item): item is Item => !!item && text(item.id))
      .map((item) => [String(item.id), item])
  )
  for (const value of checks) {
    const check = object(value)
    if (
      !check ||
      !ids(check.acceptance_ids) ||
      !OUTCOMES.includes(String(check.outcome)) ||
      !ids(check.evidence) ||
      !ids(check.packages) ||
      Object.hasOwn(check, 'execution') ||
      Object.hasOwn(check, 'origin_event_id')
    )
      throw new Error('PREPARED_CHECK_INVALID')
    if (check.acceptance_ids.some((id) => !allowedAcceptance.includes(id)))
      throw new Error('PREPARED_CHECK_SCOPE_INVALID')
    const packages = new Set<string>()
    for (const id of check.acceptance_ids) {
      const definition = definitions.get(id)
      if (
        !definition ||
        ['method', 'oracle', 'environment'].some(
          (field) => !text(definition[field]) || check[field] !== definition[field]
        )
      )
        throw new Error(`PREPARED_CHECK_CONTRACT_BINDING_MISMATCH: ${id}`)
      for (const name of ids(definition.packages) ? definition.packages : []) packages.add(name)
    }
    if (
      packages.size !== check.packages.length ||
      check.packages.some((name) => !packages.has(name))
    )
      throw new Error('PREPARED_CHECK_PACKAGES_MISMATCH')
  }
}
