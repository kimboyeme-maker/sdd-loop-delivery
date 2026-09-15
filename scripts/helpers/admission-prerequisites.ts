import { lastIndexOfType } from '../utils/event-index'
import { assertVerificationReviewer } from './verification-reviewer'
import type { Contract } from '../domain/contract'
import { assertCandidateBinding } from './candidate-evidence'

/** Collect transitive prerequisites outside the round without inventing another task graph. */
export function externalPrerequisites(contract: Contract, admitted: readonly string[]): string[] {
  const selected = new Set(admitted)
  const byId = new Map(contract.requirements.map((requirement) => [requirement.id, requirement]))
  const visited = new Set<string>()
  const external = new Set<string>()
  const pending = [...admitted]
  while (pending.length) {
    const id = pending.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    const requirement = byId.get(id)
    if (!requirement || requirement.kind === 'non-goal')
      throw new Error('ADMISSION_PREREQUISITE_INVALID')
    for (const dependency of requirement.dependencies ?? []) {
      if (!selected.has(dependency)) external.add(dependency)
      pending.push(dependency)
    }
  }
  return [...external]
}

/**
 * Require current, signed independent results for prerequisites omitted from this
 * round. The caller must first validate the candidate against the real worktree.
 * A status string alone cannot establish that the required input is available.
 */
export function assertPrerequisiteEvidence(
  contract: Contract,
  ids: readonly string[],
  state: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
  candidate: Record<string, unknown>
): void {
  const statuses = state.requirements as Record<string, unknown> | undefined
  const implementationIndex = lastIndexOfType(events, 'implementation')
  if (implementationIndex < 0) throw new Error('ADMISSION_PREREQUISITE_EVIDENCE_REQUIRED')
  const duplicateIds = new Set<string>()
  const seen = new Set<string>()
  for (const event of events) {
    if (typeof event.event_id !== 'string') continue
    if (seen.has(event.event_id)) duplicateIds.add(event.event_id)
    seen.add(event.event_id)
  }
  for (const id of ids) {
    if (!statuses || !Object.hasOwn(statuses, id) || statuses[id] !== 'verified')
      throw new Error('ADMISSION_PREREQUISITE_NOT_VERIFIED')
    const index = events.findLastIndex((event) => {
      const payload = event.payload as Record<string, unknown> | undefined
      return (
        event.type === 'verification' &&
        Array.isArray(payload?.requirement_ids) &&
        payload.requirement_ids.includes(id)
      )
    })
    const event = events[index]
    if (!event || index <= implementationIndex || duplicateIds.has(String(event.event_id)))
      throw new Error('ADMISSION_PREREQUISITE_EVIDENCE_REQUIRED')
    assertVerificationReviewer(state, events, event)
    const payload = event.payload as Record<string, unknown>
    const acceptance = contract.requirements.find(
      (requirement) => requirement.id === id
    )?.acceptance
    const observedAcceptance = payload.acceptance_ids
    if (
      payload.result !== 'PASS' ||
      !acceptance?.length ||
      !Array.isArray(observedAcceptance) ||
      acceptance.some((item) => !observedAcceptance.includes(item))
    )
      throw new Error('ADMISSION_PREREQUISITE_COVERAGE_INVALID')
    assertCandidateBinding(payload, candidate)
    if (
      events
        .slice(index + 1)
        .some((later) =>
          ['contract_amendment', 'verification_revoked', 'timeout_decision'].includes(
            String(later.type)
          )
        )
    )
      throw new Error('ADMISSION_PREREQUISITE_EVIDENCE_STALE')
  }
}
