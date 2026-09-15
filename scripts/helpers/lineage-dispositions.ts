import type { Contract } from '../domain/contract'
import { canonicalJson } from '../resource/wire/canonical-json'

type Item = Record<string, unknown>
function object(value: unknown, code: string): Item {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code)
  return value as Item
}
function strings(value: unknown, code: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item.trim()) ||
    new Set(value).size !== value.length
  )
    throw new Error(code)
  return value
}
function keyed(value: unknown, key: string, code: string): Map<string, Item> {
  if (!Array.isArray(value)) throw new Error(code)
  const map = new Map<string, Item>()
  for (const entry of value) {
    const item = object(entry, code),
      id = item[key]
    if (typeof id !== 'string' || !id.trim() || map.has(id)) throw new Error(code)
    map.set(id, item)
  }
  return map
}
const subset = (items: readonly string[], scope: Iterable<string>): boolean => {
  const allowed = new Set(scope)
  return items.every((id) => allowed.has(id))
}

/**
 * Account for every controller-recorded predecessor obligation exactly once.
 * This consumes an already-authenticated state snapshot; it neither discovers
 * predecessor facts nor authenticates user decisions. Admission must separately
 * validate decision authority before any resulting route receives permissions.
 * No old-engine state, signature or receipt is imported by this rule.
 */
export function assertLineageDispositions(contract: Contract, state: Item, payload: Item): void {
  const closure = object(payload.fact_closure, 'ADMISSION_FACT_CLOSURE_REQUIRED')
  const lineage = object(contract.lineage, 'ADMISSION_FACT_LINEAGE_MODE_MISMATCH')
  if (
    !['fresh', 'continuation'].includes(String(lineage.mode)) ||
    closure.lineage_mode !== lineage.mode
  )
    throw new Error('ADMISSION_FACT_LINEAGE_MODE_MISMATCH')
  const expected = keyed(state.lineage_obligations ?? [], 'id', 'ADMISSION_LINEAGE_STATE_INVALID')
  const observed = keyed(
    closure.inherited_obligations,
    'obligation_id',
    'ADMISSION_INHERITED_OBLIGATION_SCOPE_INVALID'
  )
  if (expected.size !== observed.size || !subset([...expected.keys()], observed.keys()))
    throw new Error('ADMISSION_INHERITED_OBLIGATION_SCOPE_INVALID')
  if (lineage.mode === 'fresh' && expected.size)
    throw new Error('ADMISSION_FACT_LINEAGE_MODE_MISMATCH')
  const facts = keyed(closure.facts, 'id', 'ADMISSION_FACT_INVALID')
  const acceptance = keyed(contract.acceptance, 'id', 'CONTRACT_ACCEPTANCE_INVALID')
  const requirements = strings(payload.requirement_ids, 'ADMISSION_REQUIREMENT_SCOPE_INVALID')
  const acceptanceIds = strings(payload.acceptance_ids, 'ADMISSION_ACCEPTANCE_SCOPE_INVALID')
  const modifications = strings(
    payload.modification_packages,
    'ADMISSION_MODIFICATION_SCOPE_INVALID'
  )
  const packages = new Set([
    ...strings(
      object(contract.ownership, 'ADMISSION_AUTHORITY_REQUIRED').packages,
      'ADMISSION_AUTHORITY_REQUIRED'
    ),
    ...modifications,
    ...strings(
      object(payload.workload, 'CONTRACT_ADMISSION_WORKLOAD_REQUIRED').affected_packages,
      'CONTRACT_ADMISSION_WORKLOAD_REQUIRED'
    )
  ])
  const surfaces = object(
    payload.verification_scope,
    'CONTRACT_ADMISSION_VERIFICATION_SCOPE_INVALID'
  ).surfaces
  if (!Array.isArray(surfaces)) throw new Error('CONTRACT_ADMISSION_VERIFICATION_SCOPE_INVALID')
  for (const entry of surfaces)
    for (const owner of strings(
      object(entry, 'CONTRACT_ADMISSION_VERIFICATION_SURFACE_INVALID').packages,
      'CONTRACT_ADMISSION_VERIFICATION_SURFACE_INVALID'
    ))
      packages.add(owner)
  const decisions = strings(
    object(payload.must_ship_decision_closure, 'MUST_SHIP_DECISION_CLOSURE_REQUIRED')
      .decision_requirement_ids,
    'MUST_SHIP_DECISION_IDS_INVALID'
  )
  for (const [id, item] of observed) {
    const obligation = expected.get(id)!
    const affected = strings(obligation.affected_packages, 'ADMISSION_LINEAGE_STATE_INVALID')
    const factIds = strings(item.fact_ids, 'ADMISSION_INHERITED_FACT_REFERENCE_INVALID')
    if (!subset(factIds, facts.keys()))
      throw new Error('ADMISSION_INHERITED_FACT_REFERENCE_INVALID')
    const referenced = factIds.map((factId) => facts.get(factId)!)
    const reqIds = strings(item.requirement_ids, 'ADMISSION_INHERITED_OBLIGATION_INVALID')
    const accIds = strings(item.acceptance_ids, 'ADMISSION_INHERITED_OBLIGATION_INVALID')
    const repairPackages = strings(item.repair_packages, 'ADMISSION_INHERITED_REPAIR_SCOPE_INVALID')
    if (!strings(item.evidence, 'ADMISSION_INHERITED_OBLIGATION_INVALID').length)
      throw new Error('ADMISSION_INHERITED_OBLIGATION_INVALID')
    const source = keyed(
      obligation.source_acceptance ?? [],
      'id',
      'ADMISSION_LINEAGE_STATE_INVALID'
    )
    if (source.size && item.disposition !== 'USER_AUTHORIZED_CONTRACT_CHANGE') {
      if (accIds.length !== source.size || !subset(accIds, source.keys()))
        throw new Error('ADMISSION_INHERITED_CONTRACT_CHANGE_REQUIRES_USER')
      // Compare by acceptance ID, not a sorted multiset: swapping two oracles
      // between IDs must not preserve the meaning of either obligation.
      for (const [aid, previous] of source) {
        const current = acceptance.get(aid)
        if (!current) throw new Error('ADMISSION_INHERITED_CONTRACT_CHANGE_REQUIRES_USER')
        for (const field of [
          'oracle',
          'method',
          'environment',
          'packages',
          'claim',
          'oracle_sensitivity',
          'execution'
        ]) {
          if (
            Object.hasOwn(previous, field) &&
            (!Object.hasOwn(current, field) ||
              canonicalJson(previous[field]) !== canonicalJson(current[field]))
          )
            throw new Error('ADMISSION_INHERITED_CONTRACT_CHANGE_REQUIRES_USER')
        }
      }
    }
    const covered = (field: string): string[] =>
      referenced.flatMap((fact) =>
        strings(fact[field], 'ADMISSION_INHERITED_FACT_REFERENCE_INVALID')
      )
    const passing =
      referenced.length > 0 && referenced.every((fact) => fact.status === 'CONFIRMED_PASS')
    switch (item.disposition) {
      case 'RESOLVED':
        if (
          !passing ||
          !reqIds.length ||
          !accIds.length ||
          !subset(reqIds, requirements) ||
          !subset(accIds, acceptanceIds) ||
          !subset(affected, covered('packages')) ||
          !subset(reqIds, covered('requirement_ids')) ||
          !subset(accIds, covered('acceptance_ids'))
        )
          throw new Error('ADMISSION_INHERITED_RESOLUTION_NOT_PROVEN')
        if (
          obligation.kind === 'NON_PASS_VERIFICATION' &&
          !referenced.some((fact) => {
            const source = object(fact.source, 'ADMISSION_INHERITED_VERIFICATION_RERUN_REQUIRED')
            return (
              source.kind === 'COMMAND' &&
              typeof obligation.resolution_method === 'string' &&
              obligation.resolution_method.trim() &&
              source.reference === obligation.resolution_method
            )
          })
        )
          throw new Error('ADMISSION_INHERITED_VERIFICATION_RERUN_REQUIRED')
        if (repairPackages.length) throw new Error('ADMISSION_INHERITED_REPAIR_SCOPE_INVALID')
        break
      case 'ADMITTED_REPAIR':
        if (
          !reqIds.length ||
          !accIds.length ||
          !repairPackages.length ||
          !subset(reqIds, requirements) ||
          !subset(accIds, acceptanceIds) ||
          !subset(repairPackages, affected) ||
          !subset(repairPackages, modifications)
        )
          throw new Error('ADMISSION_INHERITED_REPAIR_SCOPE_INVALID')
        break
      case 'SCOPE_EXTERNAL':
        if (repairPackages.length) throw new Error('ADMISSION_INHERITED_REPAIR_SCOPE_INVALID')
        if (affected.some((owner) => packages.has(owner)))
          throw new Error('ADMISSION_INHERITED_SCOPE_EXTERNAL_CONTRADICTION')
        if (!passing || !subset(affected, covered('packages')))
          throw new Error('ADMISSION_INHERITED_SCOPE_EXTERNAL_NOT_PROVEN')
        break
      case 'USER_AUTHORIZED_CONTRACT_CHANGE': {
        if (repairPackages.length) throw new Error('ADMISSION_INHERITED_REPAIR_SCOPE_INVALID')
        const selected = strings(
          item.decision_requirement_ids,
          'ADMISSION_INHERITED_AUTHORITY_EVIDENCE_REQUIRED'
        )
        if (!selected.length || !subset(selected, decisions))
          throw new Error('ADMISSION_INHERITED_AUTHORITY_EVIDENCE_REQUIRED')
        break
      }
      default:
        throw new Error('ADMISSION_INHERITED_OBLIGATION_INVALID')
    }
  }
}
