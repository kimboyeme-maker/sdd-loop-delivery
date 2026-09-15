import { eventsWithId } from '../utils/event-index'
import { assertVerificationReviewer } from './verification-reviewer'
import { assertCurrentSource } from './source-binding'
import { currentCandidate, assertCandidateBinding } from './candidate-evidence'
type Item = Record<string, unknown>

/** Authenticate a PASS against current product bytes before recording completion.
 * Callers additionally enforce their requirement/acceptance or Finding scope.
 * This checks provenance and applicability, not the correctness of the oracle.
 */
export function assertCurrentVerification(
  sdd: string,
  state: Item,
  events: readonly Item[],
  event: Item
): void {
  if (event.type !== 'verification' || (event.payload as Item)?.result !== 'PASS')
    throw new Error('VERIFIED_REQUIRES_ARCHITECT_VERIFICATION_EVENT')
  if (eventsWithId(events, event.event_id).length !== 1)
    throw new Error('VERIFIED_EVIDENCE_AMBIGUOUS')
  assertVerificationReviewer(state, events, event)
  assertCurrentSource(state, sdd)
  const current = currentCandidate(sdd, state, events),
    index = events.indexOf(event)
  if (index <= events.indexOf(current.event)) throw new Error('VERIFIED_EVIDENCE_STALE')
  if ((event.actor as Item).agent_id === (current.event.actor as Item).agent_id)
    throw new Error('VERIFIED_REVIEWER_NOT_INDEPENDENT')
  assertCandidateBinding(event.payload as Item, current.candidate)
  if (
    events
      .slice(index + 1)
      .some(
        (later) =>
          [
            'timeout_decision',
            'pipeline_incident',
            'verification_revoked',
            'amend',
            'contract_amendment'
          ].includes(String(later.type)) ||
          (later.type === 'verification' && (later.payload as Item)?.result !== 'PASS')
      )
  )
    throw new Error('VERIFIED_EVIDENCE_STALE')
}
