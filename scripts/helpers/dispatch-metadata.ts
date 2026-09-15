import { eventsWithId } from '../utils/event-index'
import { assertRoleEvidence } from './role-evidence'
import { FRESH_ARCHITECT_REASONS } from '../config/constants'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined

export type DispatchMetadata = Readonly<{
  agent: 'operator' | 'architect'
  agentId: string
  verificationMode: string
  packet?: string | undefined
  workItem: string
  freshReason?: string | undefined
  correctionFindingId?: string | undefined
  resumeCheckpoint?: string | undefined
  repairProbeRoot?: string | undefined
}>

/** Latest Architect that produced a verification in the current authority epoch. */
function previousArchitect(state: Item, events: readonly Item[]): string | undefined {
  const event = events.findLast(
    (item) =>
      item.type === 'verification' &&
      item.role === 'architect' &&
      object(item.actor)?.authority_epoch === state.authority_epoch
  )
  return object(event?.actor)?.agent_id as string | undefined
}

/**
 * Reuse the current Architect by default. A distinct Architect requires an explicit
 * enumerated reason, and a bounded correction must go back to the Finding's author.
 * Metadata that does not apply to the selected mode is rejected rather than ignored.
 */
export function assertDispatchMetadata(
  state: Item,
  events: readonly Item[],
  input: DispatchMetadata
): void {
  const { agent, agentId, verificationMode: mode } = input
  const override = !!input.freshReason || !!input.correctionFindingId
  if (input.repairProbeRoot) {
    if (mode !== 'standard' || override || input.resumeCheckpoint || input.packet)
      throw new Error('REPAIR_PROBE_FORBIDS_PRODUCT_DISPATCH_METADATA')
    return
  }
  if (mode === 'design-counsel') {
    if (override || input.resumeCheckpoint || input.packet)
      throw new Error('DESIGN_COUNSEL_METADATA_INVALID')
    return
  }
  if (agent === 'operator') {
    if (mode !== 'standard' || override) throw new Error('VERIFICATION_MODE_ARCHITECT_ONLY')
    return
  }
  const previous = previousArchitect(state, events)
  if (mode === 'bounded-correction') {
    if (state.phase !== 'ARCHITECT_VERIFY')
      throw new Error('BOUNDED_CORRECTION_REQUIRES_ARCHITECT_VERIFY')
    if (input.freshReason) throw new Error('BOUNDED_CORRECTION_FORBIDS_FRESH_REASON')
    const finding = object(object(state.findings)?.[input.correctionFindingId ?? ''])
    if (!input.correctionFindingId || !finding)
      throw new Error('BOUNDED_CORRECTION_REQUIRES_TRACKED_FINDING')
    if (finding.status !== 'open') throw new Error('BOUNDED_CORRECTION_REQUIRES_OPEN_FINDING')
    const matches = eventsWithId(events, finding.evidence)
    const evidence = matches[0]
    if (matches.length !== 1 || !evidence || evidence.type !== 'finding')
      throw new Error('BOUNDED_CORRECTION_REQUIRES_ARCHITECT_FINDING_EVIDENCE')
    assertRoleEvidence(state, evidence, 'architect')
    if (object(evidence.actor)?.agent_id !== agentId)
      throw new Error('BOUNDED_CORRECTION_REQUIRES_ARCHITECT_REUSE')
    return
  }
  if (mode === 'fresh-independent') {
    if (input.correctionFindingId) throw new Error('FRESH_ARCHITECT_FORBIDS_BOUNDED_FINDING')
    if (!FRESH_ARCHITECT_REASONS.includes(String(input.freshReason)))
      throw new Error('FRESH_ARCHITECT_REASON_INVALID')
    if (previous !== undefined && previous === agentId)
      throw new Error('FRESH_ARCHITECT_REQUIRES_DISTINCT_PRIOR_ARCHITECT')
    return
  }
  if (override) throw new Error('STANDARD_VERIFICATION_FORBIDS_OVERRIDE_METADATA')
  if (previous !== undefined && previous !== agentId)
    throw new Error('FRESH_ARCHITECT_REQUIRES_EXPLICIT_MODE_AND_REASON')
}

/** A previous no-progress observation for the same work disqualifies the bounded profile. */
export function hasPriorNoProgress(
  state: Item,
  events: readonly Item[],
  packet: string | undefined,
  workItem: string
): boolean {
  const leases = object(state.issued_leases) ?? {}
  return events.some((event) => {
    const payload = object(event.payload)
    if (event.type !== 'operator_reconcile' || payload?.no_progress !== true) return false
    const lease = object(leases[String(payload.lease_id)])
    return lease?.packet_id || packet ? lease?.packet_id === packet : lease?.work_item === workItem
  })
}

/**
 * Validate a resume checkpoint and return the recovery binding the successor must read back.
 * Only a signed SAFE_TO_RESUME checkpoint from a revoked lease in this phase qualifies.
 */
export function resumeCheckpointRecovery(
  state: Item,
  events: readonly Item[],
  agent: 'operator' | 'architect',
  checkpointId: string
): Item {
  const matches = eventsWithId(events, checkpointId)
  const checkpoint = matches[0]
  const payload = object(checkpoint?.payload)
  const actor = object(checkpoint?.actor)
  if (
    matches.length !== 1 ||
    !checkpoint ||
    checkpoint.type !== 'checkpoint' ||
    checkpoint.role !== agent ||
    checkpoint.state !== state.phase ||
    checkpoint.contract_revision !== state.contract_revision ||
    payload?.status !== 'SAFE_TO_RESUME' ||
    object(state.active_lease)?.lease_id === actor?.lease_id
  )
    throw new Error('RESUME_CHECKPOINT_INVALID')
  assertRoleEvidence(state, checkpoint, agent)
  return {
    source: 'checkpoint',
    checkpoint_id: checkpointId,
    predecessor_lease_id: actor!.lease_id,
    next_action: object(payload.resume)?.next_action
  }
}
