import { isDeepStrictEqual } from 'node:util'
import type { Contract, ContractRequirement } from '../contract'

/** Only explicit presentation metadata is non-semantic; unknown contract fields remain binding. */
function sharedSemantics(contract: Partial<Contract> | undefined): Record<string, unknown> {
  if (!contract) return {}
  const {
    revision: _revision,
    requirements: _requirements,
    presentation: _presentation,
    ...shared
  } = contract
  return shared
}

/** Preserve unaffected statuses, invalidating changed requirements and their transitive consumers. */
export function amendedRequirementStatuses(
  previous: Record<string, unknown>,
  next: Contract
): Record<string, unknown> {
  return amendedRequirementState(previous, next).requirements
}

/** Compute status and evidence retention together so invalidated claims keep no live evidence pointer. */
export function amendedRequirementState(
  previous: Record<string, unknown>,
  next: Contract
): { requirements: Record<string, unknown>; requirement_evidence: Record<string, unknown> } {
  const oldContract = previous.contract as Partial<Contract> | undefined
  const old = new Map((oldContract?.requirements ?? []).map((req) => [req.id, req]))
  const changed = new Set<string>()
  const consumers = new Map<string, string[]>()
  // Requirements can be unchanged while shared permissions, ownership or environment
  // changes invalidate their evidence. Never preserve PASS from requirement equality alone.
  const sharedChanged = !isDeepStrictEqual(sharedSemantics(oldContract), sharedSemantics(next))
  for (const req of next.requirements) {
    if (!isDeepStrictEqual(old.get(req.id), req) || sharedChanged) changed.add(req.id)
    for (const dependency of req.dependencies ?? [])
      consumers.set(dependency, [...(consumers.get(dependency) ?? []), req.id])
  }
  const queue = [...changed]
  for (let index = 0; index < queue.length; index++)
    for (const id of consumers.get(queue[index]!) ?? []) {
      if (!changed.has(id)) {
        changed.add(id)
        queue.push(id)
      }
    }
  const statuses = previous.requirements as Record<string, unknown> | undefined
  const requirements = Object.fromEntries(
    next.requirements.map((req: ContractRequirement) => [
      req.id,
      changed.has(req.id) ? 'pending' : (statuses?.[req.id] ?? 'pending')
    ])
  )
  const evidence = previous.requirement_evidence as Record<string, unknown> | undefined
  return {
    requirements,
    requirement_evidence: Object.fromEntries(
      Object.entries(evidence ?? {}).filter(
        ([id]) => Object.hasOwn(requirements, id) && !changed.has(id)
      )
    )
  }
}
