import { leaseSlots } from './lease-slots'
import { createHash } from 'node:crypto'

/** Stage a changed repair hypothesis; only a later bound role probe can close the incident. */
export function stagePipelineRepair(
  state: Record<string, unknown>,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const pending = state.pending_pipeline_repair as Record<string, unknown> | undefined
  if (!pending || typeof pending !== 'object' || Array.isArray(pending))
    throw new Error('PIPELINE_REPAIR_NOT_PENDING')
  if (leaseSlots(state as Record<string, unknown>).length > 0)
    throw new Error('PIPELINE_REPAIR_PROBE_ACTIVE')
  if (typeof pending.root_cause_key !== 'string' || !pending.root_cause_key.trim())
    throw new Error('PIPELINE_REPAIR_ROOT_INVALID')
  if (payload.root_cause_key !== pending.root_cause_key)
    throw new Error('PIPELINE_REPAIR_ROOT_MISMATCH')
  if (
    typeof payload.mechanism !== 'string' ||
    !payload.mechanism.trim() ||
    typeof payload.falsifier !== 'string' ||
    !payload.falsifier.trim()
  )
    throw new Error('PIPELINE_REPAIR_CANDIDATE_INVALID')
  const candidate = { mechanism: payload.mechanism, falsifier: payload.falsifier }
  const candidateHash = createHash('sha256').update(JSON.stringify(candidate)).digest('hex')
  const root = String(pending.root_cause_key)
  const histories = state.pipeline_repair_candidate_hashes as Record<string, unknown> | undefined
  // A damaged history is not an empty history: replacing it would permit repeated failed fixes.
  if (
    histories !== undefined &&
    (!histories || typeof histories !== 'object' || Array.isArray(histories))
  )
    throw new Error('PIPELINE_REPAIR_HISTORY_INVALID')
  if (
    histories &&
    Object.values(histories).some(
      (values) =>
        !Array.isArray(values) ||
        values.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
    )
  )
    throw new Error('PIPELINE_REPAIR_HISTORY_INVALID')
  const history = histories && Object.hasOwn(histories, root) ? histories[root] : []
  if (!Array.isArray(history)) throw new Error('PIPELINE_REPAIR_HISTORY_INVALID')
  if (history.includes(candidateHash)) throw new Error('PIPELINE_REPAIR_CANDIDATE_MUST_CHANGE')
  return {
    ...state,
    pending_pipeline_repair: { ...pending, candidate, candidate_hash: candidateHash },
    pipeline_repair_candidate_hashes: { ...histories, [root]: [...history, candidateHash] }
  }
}
