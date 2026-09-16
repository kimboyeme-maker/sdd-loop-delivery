import type { Contract } from '../contract'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0
const list = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(text) &&
  new Set(value).size === value.length
const equal = (left: Set<string>, right: readonly string[]): boolean =>
  left.size === new Set(right).size && right.every((id) => left.has(id))

/** Bind each planned verification surface to its exact normative method and scope. */
/**
 * The acceptance shape the contract itself must carry: identity, links, and the fields a case needs
 * to be runnable at all. Admission used to be the first place this ran, which meant an author saw a
 * green `validate` and only learned at admission that a case was unrunnable. `validate` calls it too.
 */
export function assertAcceptanceShape(contract: Contract): Map<string, Record<string, unknown>> {
  if (!Array.isArray(contract.acceptance)) throw new Error('CONTRACT_ACCEPTANCE_REQUIRED')
  const reverseLinks = new Map<string, Set<string>>()
  for (const requirement of contract.requirements)
    for (const acceptance of requirement.acceptance ?? []) {
      const linked = reverseLinks.get(acceptance) ?? new Set<string>()
      linked.add(requirement.id)
      reverseLinks.set(acceptance, linked)
    }
  const byId = new Map<string, Record<string, unknown>>()
  for (const value of contract.acceptance) {
    const item = record(value)
    if (
      !item ||
      !text(item.id) ||
      byId.has(item.id) ||
      !text(item.method) ||
      !text(item.oracle) ||
      !text(item.environment) ||
      !list(item.requirement_ids) ||
      !list(item.packages)
    )
      throw new Error('CONTRACT_ACCEPTANCE_INVALID')
    // Both directions describe the same normative edge. Matching aggregate
    // counts cannot excuse an acceptance silently attached to another requirement.
    if (!equal(reverseLinks.get(item.id) ?? new Set<string>(), item.requirement_ids))
      throw new Error('CONTRACT_ACCEPTANCE_REQUIREMENT_LINK_MISMATCH')
    byId.set(item.id, item)
  }
  if ([...reverseLinks.keys()].some((id) => !byId.has(id)))
    throw new Error('CONTRACT_ACCEPTANCE_REQUIREMENT_LINK_MISMATCH')
  return byId
}

export function assertVerificationScope(
  contract: Contract,
  payload: Record<string, unknown>
): void {
  const scope = record(payload.verification_scope)
  if (
    !scope ||
    scope.mode !== 'CAUSAL_CLOSURE' ||
    scope.external_failure_policy !== 'NON_BLOCKING_UNLESS_CAUSAL_OR_ORACLE_MASKING' ||
    !Array.isArray(scope.surfaces) ||
    !scope.surfaces.length
  )
    throw new Error('CONTRACT_ADMISSION_VERIFICATION_SCOPE_INVALID')
  const byId = assertAcceptanceShape(contract)
  const surfaceIds = new Set<string>(),
    coveredRequirements = new Set<string>(),
    coveredAcceptance = new Set<string>()
  for (const value of scope.surfaces) {
    const surface = record(value)
    if (
      !surface ||
      !text(surface.id) ||
      surfaceIds.has(surface.id) ||
      ![surface.target, surface.causal_basis, surface.method].every(text) ||
      !list(surface.requirement_ids) ||
      !list(surface.acceptance_ids) ||
      !list(surface.packages)
    )
      throw new Error('CONTRACT_ADMISSION_VERIFICATION_SURFACE_INVALID')
    surfaceIds.add(surface.id)
    const requirements = new Set<string>(),
      packages = new Set<string>()
    for (const id of surface.acceptance_ids) {
      const item = byId.get(id)
      if (!item) throw new Error('CONTRACT_ADMISSION_VERIFICATION_ACCEPTANCE_SCOPE_INVALID')
      if (item.method !== surface.method)
        throw new Error('CONTRACT_ADMISSION_VERIFICATION_METHOD_MISMATCH')
      for (const requirement of item.requirement_ids as string[]) requirements.add(requirement)
      for (const owner of item.packages as string[]) packages.add(owner)
      coveredAcceptance.add(id)
    }
    if (!equal(requirements, surface.requirement_ids))
      throw new Error('CONTRACT_ADMISSION_VERIFICATION_REQUIREMENT_SCOPE_INVALID')
    if (!equal(packages, surface.packages))
      throw new Error('CONTRACT_ADMISSION_VERIFICATION_PACKAGE_SCOPE_INVALID')
    for (const id of requirements) coveredRequirements.add(id)
  }
  if (!list(payload.requirement_ids) || !equal(coveredRequirements, payload.requirement_ids))
    throw new Error('CONTRACT_ADMISSION_VERIFICATION_REQUIREMENT_SCOPE_INVALID')
  if (!list(payload.acceptance_ids) || !equal(coveredAcceptance, payload.acceptance_ids))
    throw new Error('CONTRACT_ADMISSION_VERIFICATION_ACCEPTANCE_SCOPE_INVALID')
  const early = record(payload.early_falsifier_result)
  if (
    !early ||
    !list(early.acceptance_ids) ||
    !list(early.evidence_fact_ids) ||
    !text(early.method)
  )
    throw new Error('EARLY_FALSIFIER_SCOPE_INVALID')
  const earlyAcceptance = early.acceptance_ids
  const targetIds = early.target_assumption_ids
  const migration =
    Array.isArray(targetIds) &&
    Array.isArray(payload.assumptions_checked) &&
    payload.assumptions_checked.some(
      (item) =>
        record(item)?.category === 'MIGRATION_READER_CLOSURE' &&
        targetIds.includes(record(item)?.id)
    )
  if (
    !migration &&
    !scope.surfaces.some((value) => {
      const surface = record(value)!
      return (
        surface.method === early.method &&
        Array.isArray(surface.acceptance_ids) &&
        earlyAcceptance.every((id) => (surface.acceptance_ids as unknown[]).includes(id))
      )
    })
  )
    throw new Error('EARLY_FALSIFIER_METHOD_NOT_ACCEPTANCE_ORACLE')
  const expectedPackages = new Set<string>()
  const expectedClaims = new Set<string>()
  for (const id of earlyAcceptance) {
    const item = byId.get(id)
    if (!item) throw new Error('EARLY_FALSIFIER_SCOPE_INVALID')
    const claim = record(item.claim)
    if (!claim || !text(claim.id)) throw new Error('CONTRACT_ACCEPTANCE_CLAIM_REQUIRED')
    expectedClaims.add(claim.id)
    for (const owner of item.packages as string[]) expectedPackages.add(owner)
  }
  const facts = record(payload.fact_closure)?.facts
  if (!Array.isArray(facts)) throw new Error('EARLY_FALSIFIER_FACT_SCOPE_INVALID')
  const observedPackages = new Set<string>()
  const observedClaims = new Set<string>()
  for (const id of early.evidence_fact_ids) {
    const matches = facts.filter((item) => record(item)?.id === id)
    const fact = record(matches[0])
    if (matches.length !== 1 || !fact || !list(fact.packages))
      throw new Error('EARLY_FALSIFIER_FACT_SCOPE_INVALID')
    if (!list(fact.claim_ids)) throw new Error('EARLY_FALSIFIER_CLAIM_BINDING_INVALID')
    for (const claim of fact.claim_ids) observedClaims.add(claim)
    for (const owner of fact.packages) observedPackages.add(owner)
  }
  if ([...expectedPackages].some((owner) => !observedPackages.has(owner)))
    throw new Error('EARLY_FALSIFIER_FACT_SCOPE_INVALID')
  if ([...expectedClaims].some((claim) => !observedClaims.has(claim)))
    throw new Error('EARLY_FALSIFIER_CLAIM_BINDING_INVALID')
  const gate = record(scope.workspace_wide_gate)
  if (
    !gate ||
    !['NOT_APPLICABLE', 'REJECTED_OVERBROAD', 'REQUIRED'].includes(String(gate.disposition)) ||
    !Array.isArray(gate.evidence) ||
    !gate.evidence.every(text) ||
    (gate.disposition !== 'NOT_APPLICABLE' && !gate.evidence.length)
  )
    throw new Error('CONTRACT_ADMISSION_WORKSPACE_GATE_INVALID')
}
