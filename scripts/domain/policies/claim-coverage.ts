import type { Contract } from '../contract'
import {
  EVIDENCE_KINDS_BY_CLAIM,
  RUNTIME_REMOVAL_CLAIM_DIMENSIONS,
  READER_INVENTORY_EVIDENCE_KINDS
} from '../../config/constants'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === 'string' && item.trim().length > 0) &&
  new Set(value).size === value.length

/** Keep proof of an existing baseline separate from work still assigned to packets. */
export function assertClaimDispositions(
  contract: Contract,
  payload: Record<string, unknown>
): void {
  if (
    !Array.isArray(contract.acceptance) ||
    !strings(payload.acceptance_ids) ||
    !Array.isArray(payload.claim_dispositions)
  )
    throw new Error('ADMISSION_CLAIM_DISPOSITIONS_REQUIRED')
  const selected = new Map<string, Record<string, unknown>>()
  for (const value of contract.acceptance) {
    const acceptance = record(value),
      claim = record(acceptance?.claim)
    if (
      acceptance &&
      claim &&
      typeof claim.id === 'string' &&
      payload.acceptance_ids.includes(String(acceptance.id))
    )
      selected.set(claim.id, acceptance)
  }
  const facts = record(payload.fact_closure)?.facts
  const packets = payload.execution_packets
  if (!Array.isArray(facts) || !Array.isArray(packets))
    throw new Error('ADMISSION_CLAIM_DISPOSITION_INVALID')
  const seen = new Set<string>()
  const inventory = record(payload.migration_closure)?.inventory_fact_ids
  const inventoryIds = new Set(strings(inventory) ? inventory : [])
  for (const value of payload.claim_dispositions) {
    const item = record(value)
    if (
      !item ||
      typeof item.claim_id !== 'string' ||
      seen.has(item.claim_id) ||
      !['VERIFIED_BASELINE', 'IMPLEMENTATION_REQUIRED'].includes(String(item.disposition)) ||
      !strings(item.fact_ids) ||
      !strings(item.packet_ids) ||
      !strings(item.evidence) ||
      !item.evidence.length
    )
      throw new Error('ADMISSION_CLAIM_DISPOSITION_INVALID')
    seen.add(item.claim_id)
    const acceptance = selected.get(item.claim_id)
    if (!acceptance) throw new Error('ADMISSION_CLAIM_DISPOSITION_SCOPE_INVALID')
    if (item.disposition === 'IMPLEMENTATION_REQUIRED') {
      if (item.fact_ids.length || !item.packet_ids.length)
        throw new Error('ADMISSION_IMPLEMENTATION_PACKET_REQUIRED')
      for (const id of item.packet_ids) {
        const matches = packets.map(record).filter((packet) => packet?.id === id)
        if (
          matches.length !== 1 ||
          !Array.isArray(matches[0]?.acceptance_ids) ||
          !matches[0].acceptance_ids.includes(acceptance.id)
        )
          throw new Error('ADMISSION_IMPLEMENTATION_PACKET_CLAIM_MISMATCH')
      }
    } else {
      if (item.packet_ids.length || !item.fact_ids.length)
        throw new Error('ADMISSION_BASELINE_CONFORMANCE_FACT_REQUIRED')
      const allowed = EVIDENCE_KINDS_BY_CLAIM[String(record(acceptance.claim)?.dimension)] ?? []
      const surfaces = record(contract.migration)?.legacy_surfaces
      const refined =
        contract.migration_applicability === 'REQUIRED' &&
        RUNTIME_REMOVAL_CLAIM_DIMENSIONS.includes(String(record(acceptance.claim)?.dimension)) &&
        Array.isArray(surfaces) &&
        surfaces.some((value) => {
          const surface = record(value)
          return (
            surface?.final_disposition === 'REMOVE' &&
            Array.isArray(surface.zero_reader_acceptance_ids) &&
            surface.zero_reader_acceptance_ids.includes(acceptance.id)
          )
        })
      let substantive = false
      for (const id of item.fact_ids) {
        const matches = facts.map(record).filter((fact) => fact?.id === id)
        const fact = matches[0]
        if (
          matches.length !== 1 ||
          !fact ||
          fact.status !== 'CONFIRMED_PASS' ||
          !Array.isArray(fact.claim_ids) ||
          !fact.claim_ids.includes(item.claim_id)
        )
          throw new Error('ADMISSION_BASELINE_CONFORMANCE_FACT_INVALID')
        if (allowed.includes(String(fact.evidence_kind)) && (!refined || !inventoryIds.has(id)))
          substantive = true
      }
      if (!substantive) throw new Error('ADMISSION_BASELINE_CONFORMANCE_DIMENSION_REQUIRED')
    }
  }
  if (seen.size !== selected.size) throw new Error('ADMISSION_CLAIM_DISPOSITION_SCOPE_INVALID')
}

/**
 * Validate quantified claim inventories and the union of their supporting facts.
 * Complete enumeration is necessary for UNIVERSAL claims, not proof that each
 * listed observation is semantically sound. Evidence-kind checks remain separate.
 */
export function assertClaimCoverage(contract: Contract, payload: Record<string, unknown>): void {
  if (!Array.isArray(contract.acceptance)) throw new Error('CONTRACT_ACCEPTANCE_REQUIRED')
  const facts = record(payload.fact_closure)?.facts
  if (!Array.isArray(facts)) throw new Error('ADMISSION_FACT_CLOSURE_REQUIRED')
  const claimIds = new Set<string>()
  const dimensions = new Map<string, string>()
  const refined = new Set<string>()
  const migration = record(contract.migration)
  const removedAcceptance = new Set<string>()
  if (contract.migration_applicability === 'REQUIRED' && Array.isArray(migration?.legacy_surfaces))
    for (const value of migration.legacy_surfaces) {
      const surface = record(value)
      if (surface?.final_disposition === 'REMOVE' && strings(surface.zero_reader_acceptance_ids))
        surface.zero_reader_acceptance_ids.forEach((id) => removedAcceptance.add(id))
    }
  const inventory = record(payload.migration_closure)?.inventory_fact_ids
  const inventoryIds = new Set(strings(inventory) ? inventory : [])
  for (const acceptance of contract.acceptance) {
    const claim = record(record(acceptance)?.claim)
    if (
      !claim ||
      typeof claim.id !== 'string' ||
      !claim.id.trim() ||
      !['SINGLE', 'UNIVERSAL'].includes(String(claim.quantifier))
    )
      throw new Error('CONTRACT_CLAIM_QUANTIFIER_INVALID')
    if (claimIds.has(claim.id)) throw new Error('ACCEPTANCE_CLAIM_ID_DUPLICATE')
    claimIds.add(claim.id)
    if (
      typeof claim.statement !== 'string' ||
      !claim.statement.trim() ||
      typeof claim.dimension !== 'string' ||
      !Object.hasOwn(EVIDENCE_KINDS_BY_CLAIM, claim.dimension)
    )
      throw new Error('CONTRACT_CLAIM_DIMENSION_INVALID')
    dimensions.set(claim.id, claim.dimension)
    if (
      removedAcceptance.has(String(record(acceptance)?.id)) &&
      RUNTIME_REMOVAL_CLAIM_DIMENSIONS.includes(claim.dimension)
    )
      refined.add(claim.id)
    if (claim.quantifier === 'SINGLE') {
      if (claim.universe != null && (!Array.isArray(claim.universe) || claim.universe.length))
        throw new Error('CONTRACT_CLAIM_UNIVERSE_INVALID')
      continue
    }
    if (!strings(claim.universe) || !claim.universe.length)
      throw new Error('CONTRACT_CLAIM_UNIVERSE_INVALID')
    const claimId = claim.id
    const supporting = facts
      .map(record)
      .filter(
        (fact) =>
          fact?.status === 'CONFIRMED_PASS' &&
          Array.isArray(fact.claim_ids) &&
          fact.claim_ids.includes(claimId) &&
          (!refined.has(claimId) || !inventoryIds.has(String(fact.id)))
      )
    // Claims without supporting facts still require disposition/proof in the
    // remaining admission gates; this function must not label them proven.
    if (!supporting.length) continue
    const covered = new Set<string>()
    for (const fact of supporting) {
      if (!strings(fact!.covered_universe))
        throw new Error('ADMISSION_UNIVERSAL_CLAIM_COVERAGE_INCOMPLETE')
      for (const item of fact!.covered_universe) covered.add(item)
    }
    if (covered.size !== claim.universe.length || claim.universe.some((item) => !covered.has(item)))
      throw new Error('ADMISSION_UNIVERSAL_CLAIM_COVERAGE_INCOMPLETE')
  }
  // References are checked after collecting the entire inventory; declaration
  // order never changes which claims a fact may reference.
  for (const value of facts) {
    const fact = record(value)
    if (
      !fact ||
      !strings(fact.claim_ids) ||
      !fact.claim_ids.length ||
      fact.claim_ids.some((id) => !claimIds.has(id))
    )
      throw new Error('ADMISSION_FACT_CLAIM_REFERENCE_INVALID')
    for (const id of fact.claim_ids) {
      if (EVIDENCE_KINDS_BY_CLAIM[dimensions.get(id)!]!.includes(String(fact.evidence_kind)))
        continue
      // Reader inventory remains required supporting context for runtime removal,
      // but is excluded above from proof of the refined runtime claim itself.
      if (
        refined.has(id) &&
        inventoryIds.has(String(fact.id)) &&
        READER_INVENTORY_EVIDENCE_KINDS.includes(String(fact.evidence_kind))
      )
        continue
      throw new Error('ADMISSION_FACT_EVIDENCE_DIMENSION_MISMATCH')
    }
  }
}
