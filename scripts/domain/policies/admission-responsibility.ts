import type { Contract } from '../contract'

/** Check role separation and explicit scope metadata without interpreting it as a granted lease. */
export function assertAdmissionResponsibility(payload: Record<string, unknown>): void {
  const object = (value: unknown): Record<string, unknown> | undefined =>
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
  const responsibility = object(payload.responsibility)
  if (
    !responsibility ||
    responsibility.decision_owner !== 'coordinator' ||
    responsibility.implementation_owner !== 'operator' ||
    responsibility.verification_owner !== 'architect' ||
    !text(responsibility.approval_authority)
  )
    throw new Error('CONTRACT_ADMISSION_RESPONSIBILITY_INVALID')
  if (!list(payload.modification_packages))
    throw new Error('CONTRACT_ADMISSION_MODIFICATION_SCOPE_REQUIRED')
  const workload = object(payload.workload)
  if (
    !workload ||
    !list(workload.affected_packages) ||
    !list(workload.verification_surfaces) ||
    !['HIGH', 'MEDIUM', 'LOW'].includes(String(workload.confidence))
  )
    throw new Error('CONTRACT_ADMISSION_WORKLOAD_INVALID')
  if (workload.confidence === 'LOW') throw new Error('CONTRACT_ADMISSION_LOW_WORKLOAD_CONFIDENCE')
  const difficulty = object(payload.difficulty)
  if (
    !difficulty ||
    !['ROUTINE', 'NON_ROUTINE', 'CRITICAL'].includes(String(difficulty.level)) ||
    !list(difficulty.drivers)
  )
    throw new Error('CONTRACT_ADMISSION_DIFFICULTY_INVALID')
}

/**
 * Bind declared authority and package scope to the normative ownership table.
 * Identifiers are compared exactly: filesystem owner normalization belongs to
 * the frozen worktree mapping, not to permission expansion during admission.
 */
export function assertAdmissionAuthority(
  contract: Contract,
  payload: Record<string, unknown>
): void {
  const ownership = contract.ownership as Record<string, unknown> | undefined
  if (
    !ownership ||
    typeof ownership !== 'object' ||
    Array.isArray(ownership) ||
    typeof ownership.approval_authority !== 'string' ||
    !ownership.approval_authority.trim() ||
    !Array.isArray(ownership.packages) ||
    !ownership.packages.length ||
    ownership.packages.some((item) => typeof item !== 'string' || !item.trim()) ||
    new Set(ownership.packages).size !== ownership.packages.length
  )
    throw new Error('CONTRACT_OWNERSHIP_REQUIRED')
  const responsibility = payload.responsibility as Record<string, unknown> | undefined
  if (responsibility?.approval_authority !== ownership.approval_authority)
    throw new Error('CONTRACT_ADMISSION_APPROVAL_AUTHORITY_MISMATCH')
  const workload = payload.workload as Record<string, unknown> | undefined
  const allowed = new Set(ownership.packages)
  if (
    !Array.isArray(workload?.affected_packages) ||
    !workload.affected_packages.length ||
    workload.affected_packages.some((item) => !allowed.has(item))
  )
    throw new Error('CONTRACT_ADMISSION_PACKAGE_SCOPE_INVALID')
  if (
    !Array.isArray(payload.modification_packages) ||
    !payload.modification_packages.length ||
    payload.modification_packages.some((item) => !allowed.has(item))
  )
    throw new Error('CONTRACT_ADMISSION_MODIFICATION_SCOPE_INVALID')
}
