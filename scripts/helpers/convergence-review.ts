import type { Contract } from '../domain/contract'
import { decisionRequirementScope } from '../domain/policies/decision-closure'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(text)
}

/** Check exact path/step coverage; ordering of independent trace records is irrelevant. */
function assertLogicTraces(
  contract: Contract,
  review: Record<string, unknown>,
  fingerprint?: string,
  requirementIds?: readonly string[]
): void {
  if (contract.implementation_logic === undefined) return
  const logic = object(contract.implementation_logic)
  if (!logic || !Array.isArray(logic.paths) || !logic.paths.length)
    throw new Error('IMPLEMENTATION_LOGIC_INVALID')
  const paths = new Map<string, Set<string>>()
  for (const entry of logic.paths) {
    const path = object(entry)
    if (
      requirementIds &&
      texts(path?.requirement_ids) &&
      !path.requirement_ids.some((id) => requirementIds.includes(String(id)))
    )
      continue
    if (
      !path ||
      !text(path.id) ||
      paths.has(path.id) ||
      !Array.isArray(path.steps) ||
      !path.steps.length
    )
      throw new Error('IMPLEMENTATION_LOGIC_INVALID')
    const steps = new Set<string>()
    for (const item of path.steps) {
      const step = object(item)
      if (!step || !text(step.id) || steps.has(step.id))
        throw new Error('IMPLEMENTATION_LOGIC_INVALID')
      steps.add(step.id)
    }
    paths.set(path.id, steps)
  }
  const checked = object(review.logic_review)
  if (!fingerprint || checked?.design_fingerprint !== fingerprint)
    throw new Error('INDEPENDENT_LOGIC_REVIEW_BINDING_REQUIRED')
  if (!checked || !Array.isArray(checked.traces) || checked.traces.length !== paths.size)
    throw new Error('INDEPENDENT_LOGIC_REVIEW_COVERAGE_INVALID')
  const seen = new Set<string>()
  for (const entry of checked.traces) {
    const trace = object(entry)
    if (!trace || !text(trace.path_id) || !paths.has(trace.path_id) || seen.has(trace.path_id))
      throw new Error('INDEPENDENT_LOGIC_REVIEW_PATH_INVALID')
    const expected = paths.get(trace.path_id)!
    if (
      !texts(trace.step_ids) ||
      new Set(trace.step_ids).size !== trace.step_ids.length ||
      trace.step_ids.length !== expected.size ||
      trace.step_ids.some((id) => !expected.has(id)) ||
      trace.result !== 'PASS' ||
      !['counterexample', 'method', 'observed_result'].every((field) => text(trace[field])) ||
      !texts(trace.evidence)
    )
      throw new Error('INDEPENDENT_LOGIC_REVIEW_NOT_CLOSED')
    seen.add(trace.path_id)
  }
}

/**
 * Validate the Coordinator's explicit convergence attestation against the current
 * contract. This is one admission prerequisite, not a semantic proof or authority
 * to clear an execution failure. Missing observations are never inferred as PASS.
 */
export function assertConvergenceReview(
  contract: Contract,
  payload: Record<string, unknown>,
  fingerprint?: string
): void {
  const review = object(payload.sdd_convergence_review)
  if (
    !review ||
    review.independent_result !== 'PASS' ||
    !texts(review.evidence) ||
    !texts(review.reviewed_acceptance_ids) ||
    new Set(review.reviewed_acceptance_ids).size !== review.reviewed_acceptance_ids.length
  )
    throw new Error('SDD_CONVERGENCE_REVIEW_REQUIRED')
  if (review.sdd_revision !== contract.revision)
    throw new Error('SDD_CONVERGENCE_REVIEW_REVISION_MISMATCH')
  const incremental = object(payload.must_ship_decision_closure)?.scope === 'CURRENT_ADMISSION'
  const required = incremental ? [...decisionRequirementScope(contract, payload)] : undefined
  for (const field of [
    'unresolved_information_questions',
    'pending_authority_confirmations',
    'route_critical_unknowns',
    'blocking_findings',
    'material_findings'
  ]) {
    if (
      (field === 'route_critical_unknowns' || field === 'unresolved_information_questions') &&
      review[field] === undefined
    )
      continue
    if (!Array.isArray(review[field]) || review[field].length !== 0)
      throw new Error('SDD_CONVERGENCE_REVIEW_NOT_CLEAN')
  }
  const acceptance = new Set<string>()
  for (const requirement of contract.requirements) {
    if (requirement.kind !== 'must-ship') continue
    if (required && !required.includes(requirement.id)) continue
    const ids = requirement.acceptance
    if (!texts(ids) || new Set(ids).size !== ids.length)
      throw new Error('SDD_MUST_SHIP_ACCEPTANCE_REQUIRED')
    for (const id of ids) acceptance.add(id)
  }
  if (
    acceptance.size !== review.reviewed_acceptance_ids.length ||
    review.reviewed_acceptance_ids.some((id) => !acceptance.has(id))
  )
    throw new Error('SDD_CONVERGENCE_REVIEW_ACCEPTANCE_SCOPE_INVALID')
  const topology = object(review.acceptance_topology)
  if (
    !topology ||
    !['method', 'failure_condition', 'observed_result'].every((field) => text(topology[field])) ||
    !texts(topology.evidence)
  )
    throw new Error('SDD_ACCEPTANCE_TOPOLOGY_REVIEW_REQUIRED')
  assertLogicTraces(contract, review, fingerprint, required)
}
