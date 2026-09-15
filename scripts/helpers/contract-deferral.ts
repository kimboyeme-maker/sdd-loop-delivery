type Item = Record<string, unknown>

/** An event records application of an approved deferral; it cannot create that approval.
 * Compare authoritative contract metadata exactly so a later amendment cannot reuse
 * an earlier decision with a different owner, trigger, impact, or approving party.
 */
export function assertContractDeferral(contract: unknown, id: string, submitted: Item): void {
  const object = (value: unknown): Item | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Item)
      : undefined
  const requirements = object(contract)?.requirements
  if (!Array.isArray(requirements)) throw new Error('DEFERRAL_CONTRACT_REQUIRED')
  const matches = requirements.map(object).filter((item) => item?.id === id)
  if (matches.length !== 1) throw new Error('DEFERRAL_CONTRACT_REQUIREMENT_INVALID')
  const requirement = matches[0]!
  const deferred = object(requirement.deferred)
  if (!deferred) throw new Error('DEFERRAL_CONTRACT_APPROVAL_REQUIRED')
  for (const field of ['owner', 'trigger', 'impact', 'approved_by']) {
    if (
      typeof deferred[field] !== 'string' ||
      !(deferred[field] as string).trim() ||
      submitted[field] !== deferred[field]
    )
      throw new Error('DEFERRAL_CONTRACT_METADATA_MISMATCH')
  }
  if (requirement.kind === 'must-ship' && deferred.approved_by !== 'user')
    throw new Error('MUST_SHIP_DEFERRAL_REQUIRES_USER')
}
