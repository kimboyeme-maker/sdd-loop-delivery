import { effectiveMustShipRequirements, type RequirementRecord } from './requirements'

export type ShipRequirement = Readonly<{
  id: string
  kind: string
  status: string
  candidateId?: string
  deferred?: RequirementRecord['deferred']
}>

/** Check candidate coverage using only validated contract deferrals, never display hints. */
export function assertShip(requirements: readonly ShipRequirement[], candidateId: string): void {
  if (!candidateId.trim()) throw new Error('SHIP_CANDIDATE_REQUIRED')
  const effective = effectiveMustShipRequirements(
    requirements.map((item): RequirementRecord => ({
      id: item.id,
      kind: item.kind,
      status: item.status as RequirementRecord['status'],
      ...(item.deferred ? { deferred: item.deferred } : {})
    }))
  )
  const effectiveIds = new Set(effective.map((item) => item.id))
  const shipSet = requirements.filter((item) => effectiveIds.has(item.id))
  if (!requirements.some((item) => item.kind === 'must-ship'))
    throw new Error('SHIP_REQUIREMENTS_EMPTY')
  if (shipSet.some((item) => item.status !== 'verified'))
    throw new Error('SHIP_REQUIREMENTS_UNVERIFIED')
  if (shipSet.some((item) => item.candidateId !== candidateId))
    throw new Error('SHIP_CANDIDATE_MISMATCH')
}
