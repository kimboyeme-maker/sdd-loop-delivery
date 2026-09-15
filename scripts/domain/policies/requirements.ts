export type RequirementStatus = 'pending' | 'in-progress' | 'verified' | 'deferred'

export type RequirementRecord = Readonly<{
  id: string
  kind: string
  status: RequirementStatus
  evidence?: string
  deferred?: Readonly<{
    owner: string
    trigger: string
    impact: string
    approvedBy: string
  }>
}>

/**
 * Projects contract requirements into the set the final SHIP gate must check.
 * A Must-Ship deferral is effective only when its complete metadata is present
 * and the contract explicitly records user approval.
 */
export function effectiveMustShipRequirements(
  requirements: readonly RequirementRecord[]
): readonly RequirementRecord[] {
  return requirements.filter((requirement) => {
    if (requirement.kind !== 'must-ship') return false
    if (requirement.status !== 'deferred') return true
    const deferred = requirement.deferred
    return (
      !deferred ||
      deferred.approvedBy !== 'user' ||
      ![deferred.owner, deferred.trigger, deferred.impact].every(
        (value) => typeof value === 'string' && value.trim().length > 0
      )
    )
  })
}

export function assertRequirementStatus(requirement: RequirementRecord): void {
  if (requirement.status === 'verified' && !requirement.evidence)
    throw new Error('VERIFIED_REQUIRES_EVIDENCE')
  if (requirement.status !== 'deferred') return
  const deferred = requirement.deferred
  if (
    !deferred ||
    ![deferred.owner, deferred.trigger, deferred.impact, deferred.approvedBy].every(
      (value) => typeof value === 'string' && value.trim().length > 0
    )
  )
    throw new Error('DEFERRED_METADATA_REQUIRED')
  if (requirement.kind === 'must-ship' && deferred.approvedBy !== 'user')
    throw new Error('MUST_SHIP_DEFERRAL_REQUIRES_USER')
}
