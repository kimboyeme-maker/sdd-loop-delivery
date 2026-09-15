import { eventsOfType } from '../utils/event-index'
import { assertRoleEvidence } from './role-evidence'
import { assertWorktreeCandidate } from './worktree-candidate'

/** Resolve the latest authenticated candidate and recheck its actual workspace before a handoff. */
export function currentCandidate(
  sdd: string,
  state: Record<string, unknown>,
  events: readonly Record<string, unknown>[]
) {
  const event = eventsOfType(events, 'implementation').at(-1)
  if (!event) throw new Error('CANDIDATE_IMPLEMENTATION_REQUIRED')
  assertRoleEvidence(state, event, 'operator')
  const payload = event.payload as Record<string, unknown> | undefined
  const candidate = payload?.candidate
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new Error('CANDIDATE_REQUIRED')
  const actor = event.actor as Record<string, unknown>
  const leases = state.issued_leases as Record<string, Record<string, unknown>>
  assertWorktreeCandidate(
    sdd,
    leases[String(actor.lease_id)]!,
    candidate as Record<string, unknown>
  )
  return { event, candidate: candidate as Record<string, unknown> }
}

/** Bind a result to the exact candidate. Matching strings do not establish oracle correctness. */
export function assertCandidateBinding(
  result: Record<string, unknown>,
  candidate: Record<string, unknown>,
  environmentDriftReport = false
): void {
  for (const field of [
    'candidate_id',
    'environment_fingerprint',
    'manifest_sha256',
    'worktree_fingerprint'
  ]) {
    if (field === 'environment_fingerprint' && environmentDriftReport) continue
    if (
      typeof candidate[field] !== 'string' ||
      !(candidate[field] as string).trim() ||
      result[field] !== candidate[field]
    )
      throw new Error('CANDIDATE_RESULT_BINDING_MISMATCH')
  }
}
