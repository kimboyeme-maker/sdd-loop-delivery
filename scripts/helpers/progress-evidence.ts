import { eventsWithId, lastIndexOfType } from '../utils/event-index'
import { assertVerificationReviewer } from './verification-reviewer'
import { assertRoleEvidence } from './role-evidence'
import { assertCandidateBinding } from './candidate-evidence'

/** Display completion only for explicitly linked requirements backed by current signed results. */
export function hasProgressEvidence(
  state: Record<string, unknown>,
  entry: Record<string, unknown>,
  events: readonly Record<string, unknown>[]
): boolean {
  try {
    const ids = entry.requirement_ids
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.some((id) => typeof id !== 'string' || !id.trim())
    )
      return false
    const statuses = state.requirements as Record<string, unknown> | undefined
    if (ids.some((id) => statuses?.[id] !== 'verified')) return false
    const references = entry.evidence
    if (!Array.isArray(references) || !references.length) return false
    const implementationIndex = lastIndexOfType(events, 'implementation')
    const implementation = events[implementationIndex]
    if (!implementation) return false
    assertRoleEvidence(state, implementation, 'operator')
    const candidate = (implementation.payload as Record<string, unknown>)?.candidate as Record<
      string,
      unknown
    >
    const covered = new Set<string>()
    for (const reference of references) {
      const matches = eventsWithId(events, reference)
      if (matches.length !== 1) return false
      const event = matches[0]!
      const index = events.indexOf(event)
      if (index <= implementationIndex || event.type !== 'verification') return false
      assertVerificationReviewer(state, events, event)
      const payload = event.payload as Record<string, unknown>
      if (payload?.result !== 'PASS' || !Array.isArray(payload.requirement_ids)) return false
      assertCandidateBinding(payload, candidate)
      if (
        events
          .slice(index + 1)
          .some(
            (later) =>
              [
                'contract_amendment',
                'amend',
                'verification_revoked',
                'timeout_decision',
                'pipeline_incident'
              ].includes(String(later.type)) ||
              (later.type === 'verification' &&
                (later.payload as Record<string, unknown>)?.result !== 'PASS')
          )
      )
        return false
      for (const id of payload.requirement_ids) if (typeof id === 'string') covered.add(id)
    }
    return ids.every((id) => covered.has(id))
  } catch {
    // A read-only display remains usable when evidence is incomplete; it never repairs authority.
    return false
  }
}
