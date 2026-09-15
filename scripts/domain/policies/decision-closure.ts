import { DECISION_CLOSURE_DIMENSIONS } from '../../config/constants'
import type { Contract } from '../contract'

/** Current slice plus its declared upstream requirements; absent scope retains legacy closure. */
export function decisionRequirementScope(
  contract: Contract,
  payload: Record<string, unknown>
): Set<string> {
  const closure = payload.must_ship_decision_closure as Record<string, unknown> | undefined
  if (closure?.scope !== 'CURRENT_ADMISSION')
    return new Set(
      contract.requirements.filter((req) => req.kind === 'must-ship').map((req) => req.id)
    )
  if (!Array.isArray(payload.requirement_ids))
    throw new Error('ADMISSION_REQUIREMENT_SCOPE_INVALID')
  const byId = new Map(contract.requirements.map((req) => [req.id, req]))
  const pending = [...payload.requirement_ids] as string[]
  const selected = new Set<string>()
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i]!
    if (selected.has(id)) continue
    const requirement = byId.get(id)
    if (!requirement) throw new Error('ADMISSION_REQUIREMENT_SCOPE_INVALID')
    selected.add(id)
    pending.push(...(requirement.dependencies ?? []))
  }
  return selected
}

/** Validate decision inventory; evidence text is an attestation, not user authorization by itself. */
export function assertDecisionClosure(contract: Contract, payload: Record<string, unknown>): void {
  const closure = payload.must_ship_decision_closure
  if (!closure || typeof closure !== 'object' || Array.isArray(closure))
    throw new Error('MUST_SHIP_DECISION_CLOSURE_REQUIRED')
  const value = closure as Record<string, unknown>
  if (value.scope !== undefined && !['CONTRACT', 'CURRENT_ADMISSION'].includes(String(value.scope)))
    throw new Error('MUST_SHIP_DECISION_SCOPE_INVALID')
  const incremental = value.scope === 'CURRENT_ADMISSION'
  const strings = (input: unknown): input is string[] =>
    Array.isArray(input) &&
    input.every((item) => typeof item === 'string' && item.trim().length > 0) &&
    new Set(input).size === input.length
  const expected = decisionRequirementScope(contract, payload)
  if (
    !strings(value.requirement_ids) ||
    !value.requirement_ids.length ||
    value.requirement_ids.length !== expected.size ||
    value.requirement_ids.some((id) => !expected.has(id))
  )
    throw new Error('MUST_SHIP_DECISION_REQUIREMENTS_REQUIRED')
  const decisions = new Set(
    contract.requirements
      .filter((req) => expected.has(req.id) && req.requirement_type === 'decision')
      .map((req) => req.id)
  )
  if (
    !strings(value.decision_requirement_ids) ||
    value.decision_requirement_ids.length !== decisions.size ||
    value.decision_requirement_ids.some((id) => !decisions.has(id))
  )
    throw new Error('MUST_SHIP_DECISION_IDS_INVALID')
  if (!Array.isArray(value.dimensions)) throw new Error('MUST_SHIP_DECISION_DIMENSIONS_REQUIRED')
  const seen = new Set<string>()
  for (const item of value.dimensions) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      !DECISION_CLOSURE_DIMENSIONS.includes(item.dimension) ||
      !strings(item.evidence) ||
      !item.evidence.length
    )
      throw new Error('MUST_SHIP_DECISION_DIMENSION_INVALID')
    if (seen.has(item.dimension)) throw new Error('MUST_SHIP_DECISION_DIMENSION_DUPLICATE')
    seen.add(item.dimension)
    if (item.dimension === 'USER_AUTHORITY' && decisions.size && item.disposition !== 'RESOLVED')
      throw new Error('MUST_SHIP_USER_AUTHORITY_NOT_RESOLVED')
    if (
      item.dimension === 'USER_AUTHORITY'
        ? !['NOT_REQUIRED', 'RESOLVED'].includes(item.disposition)
        : item.disposition !== 'CLOSED'
    )
      throw new Error('MUST_SHIP_DECISION_DIMENSION_NOT_CLOSED')
  }
  if (seen.size !== DECISION_CLOSURE_DIMENSIONS.length)
    throw new Error('MUST_SHIP_DECISION_DIMENSION_SCOPE_INVALID')
  // Incremental closure still freezes the contract-wide interfaces and authority on which
  // this slice relies. Later slices close their own execution decisions before dispatch.
  if (
    incremental &&
    (!strings(value.contract_boundary_evidence) || !value.contract_boundary_evidence.length)
  )
    throw new Error('MUST_SHIP_CONTRACT_BOUNDARY_EVIDENCE_REQUIRED')
  if (!Array.isArray(value.unresolved_decisions) || value.unresolved_decisions.length !== 0)
    throw new Error('MUST_SHIP_DECISION_UNRESOLVED')
}
