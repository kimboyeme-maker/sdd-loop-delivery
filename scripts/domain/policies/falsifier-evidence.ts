import { ADMISSION_ASSUMPTION_CATEGORIES } from '../../config/constants'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function ids(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(text) &&
    new Set(value).size === value.length
  )
}

/** Bind the reported early experiment to named assumptions and observable passing facts. */
export function assertFalsifierEvidence(payload: Record<string, unknown>): void {
  // Legacy payloads may retain an empty list. Current work is described by scoped facts,
  // prerequisites and acceptance; omission never asserts that the whole product is known.
  if (
    payload.unknowns !== undefined &&
    (!Array.isArray(payload.unknowns) || payload.unknowns.length !== 0)
  )
    throw new Error('CONTRACT_ADMISSION_UNRESOLVED_ASSUMPTION')
  const result = object(payload.early_falsifier_result),
    closure = object(payload.fact_closure)
  if (
    !result ||
    result.outcome !== 'SURVIVED' ||
    !['method', 'failure_condition', 'observed_result'].every((field) => text(result[field])) ||
    ![
      'target_assumption_ids',
      'requirement_ids',
      'acceptance_ids',
      'evidence_fact_ids',
      'evidence'
    ].every((field) => ids(result[field]))
  )
    throw new Error('EARLY_FALSIFIER_RESULT_REQUIRED')
  if (!closure || !Array.isArray(closure.facts) || !closure.facts.length)
    throw new Error('ADMISSION_FACTS_REQUIRED')
  if (!['fresh', 'continuation'].includes(String(closure.lineage_mode)))
    throw new Error('ADMISSION_FACT_LINEAGE_MODE_INVALID')
  if (!ids(payload.requirement_ids) || !ids(payload.acceptance_ids))
    throw new Error('ADMISSION_FACT_CONTRACT_SCOPE_INVALID')
  const requirementScope = new Set(payload.requirement_ids)
  const acceptanceScope = new Set(payload.acceptance_ids)
  const facts = new Map<string, Record<string, unknown>>()
  for (const entry of closure.facts) {
    const fact = object(entry),
      source = object(fact?.source)
    if (
      !fact ||
      !text(fact.id) ||
      facts.has(fact.id) ||
      !text(fact.claim) ||
      !ids(fact.requirement_ids) ||
      !ids(fact.acceptance_ids) ||
      !['CONFIRMED_PASS', 'CONFIRMED_FAIL', 'UNKNOWN'].includes(String(fact.status)) ||
      !source ||
      !['COMMAND', 'SOURCE_INSPECTION', 'EVENT', 'ARTIFACT'].includes(String(source.kind)) ||
      !text(source.reference) ||
      !text(source.observed)
    )
      throw new Error('ADMISSION_FACT_INVALID')
    // Every fact belongs to this admission, including facts not used by the
    // early probe. Otherwise an unrelated fact can later masquerade as baseline
    // or inherited-resolution evidence. Failed facts may describe admitted
    // repair work; their existence alone does not mean the route is blocked.
    if (
      fact.requirement_ids.some((id) => !requirementScope.has(id)) ||
      fact.acceptance_ids.some((id) => !acceptanceScope.has(id))
    )
      throw new Error('ADMISSION_FACT_CONTRACT_SCOPE_INVALID')
    facts.set(fact.id, fact)
  }
  const list = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every(text) && new Set(value).size === value.length
  if (
    !list(closure.unresolved_fact_ids) ||
    closure.unresolved_fact_ids.some((id) => !facts.has(id))
  )
    throw new Error('ADMISSION_UNRESOLVED_FACTS_INVALID')
  if (payload.decision === 'ADMIT' && closure.unresolved_fact_ids.length)
    throw new Error('ADMISSION_FACTS_UNRESOLVED')
  if (!Array.isArray(closure.inherited_obligations))
    throw new Error('ADMISSION_INHERITED_OBLIGATIONS_REQUIRED')
  const obligations = new Set<string>()
  for (const entry of closure.inherited_obligations) {
    const obligation = object(entry)
    if (
      !obligation ||
      !text(obligation.obligation_id) ||
      obligations.has(obligation.obligation_id) ||
      ![
        'RESOLVED',
        'ADMITTED_REPAIR',
        'SCOPE_EXTERNAL',
        'USER_AUTHORIZED_CONTRACT_CHANGE'
      ].includes(String(obligation.disposition)) ||
      ![
        'fact_ids',
        'requirement_ids',
        'acceptance_ids',
        'decision_requirement_ids',
        'repair_packages'
      ].every((field) => list(obligation[field])) ||
      !ids(obligation.evidence)
    )
      throw new Error('ADMISSION_INHERITED_OBLIGATION_INVALID')
    if ((obligation.fact_ids as string[]).some((id) => !facts.has(id)))
      throw new Error('ADMISSION_INHERITED_FACT_REFERENCE_INVALID')
    obligations.add(obligation.obligation_id)
  }
  if (!Array.isArray(payload.assumptions_checked) || !payload.assumptions_checked.length)
    throw new Error('CONTRACT_ADMISSION_ASSUMPTION_BINDING_INVALID')
  const assumptions = new Map<string, Record<string, unknown>>()
  for (const entry of payload.assumptions_checked) {
    const assumption = object(entry)
    if (
      !assumption ||
      !text(assumption.claim) ||
      !text(assumption.evidence) ||
      !ADMISSION_ASSUMPTION_CATEGORIES.some((category) => category === assumption.category)
    )
      throw new Error('CONTRACT_ADMISSION_ASSUMPTION_INVALID')
    if (assumption.status !== 'PROVEN') throw new Error('CONTRACT_ADMISSION_UNRESOLVED_ASSUMPTION')
    if (
      !assumption ||
      !text(assumption.id) ||
      assumptions.has(assumption.id) ||
      !ids(assumption.evidence_fact_ids) ||
      assumption.evidence_fact_ids.some((id) => !facts.has(id))
    )
      throw new Error('CONTRACT_ADMISSION_ASSUMPTION_BINDING_INVALID')
    if (
      assumption.status === 'PROVEN' &&
      assumption.evidence_fact_ids.some((id) => facts.get(id)!.status !== 'CONFIRMED_PASS')
    )
      throw new Error('CONTRACT_ADMISSION_PROVEN_FACT_NOT_PASS')
    assumptions.set(assumption.id, assumption)
  }
  const targets = result.target_assumption_ids as string[]
  if (
    targets.some((id) => !assumptions.has(id)) ||
    !targets.some((id) =>
      ['ROUTE_FEASIBILITY', 'ACCEPTANCE_EXECUTABILITY', 'MIGRATION_READER_CLOSURE'].includes(
        String(assumptions.get(id)!.category)
      )
    )
  )
    throw new Error('EARLY_FALSIFIER_TARGET_INVALID')
  for (const field of ['requirement_ids', 'acceptance_ids']) {
    if (
      !ids(payload[field]) ||
      (result[field] as string[]).some((id) => !(payload[field] as string[]).includes(id))
    )
      throw new Error('EARLY_FALSIFIER_SCOPE_INVALID')
  }
  const targetFacts = new Set(
    targets.flatMap((id) => assumptions.get(id)!.evidence_fact_ids as string[])
  )
  if (
    (result.evidence_fact_ids as string[]).some(
      (id) => !targetFacts.has(id) || facts.get(id)!.status !== 'CONFIRMED_PASS'
    )
  )
    throw new Error('EARLY_FALSIFIER_FACT_BINDING_INVALID')
  // Executability is an observed command property. Source inspection can support
  // other assumptions, but cannot replace execution of the method being claimed.
  if (targets.some((id) => assumptions.get(id)!.category === 'ACCEPTANCE_EXECUTABILITY')) {
    for (const id of result.evidence_fact_ids as string[]) {
      const source = object(facts.get(id)!.source)
      if (source?.kind !== 'COMMAND' || source.reference !== result.method)
        throw new Error('EARLY_FALSIFIER_EXECUTABLE_EVIDENCE_REQUIRED')
    }
  }
  for (const field of ['requirement_ids', 'acceptance_ids']) {
    const required = result[field] as string[]
    const covered = new Set<string>()
    for (const id of result.evidence_fact_ids as string[]) {
      const scope = facts.get(id)![field] as string[]
      if (!scope.some((value) => required.includes(value)))
        throw new Error('EARLY_FALSIFIER_FACT_SCOPE_INVALID')
      scope.forEach((value) => covered.add(value))
    }
    if (required.some((id) => !covered.has(id)))
      throw new Error('EARLY_FALSIFIER_FACT_SCOPE_INVALID')
  }
}
