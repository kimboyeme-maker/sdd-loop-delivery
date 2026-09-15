import { eventsWithId } from '../utils/event-index'
import { rolePublicKey, verifyRoleEvent } from '../resource/role-signature'
import { isDeepStrictEqual } from 'node:util'
import { bootstrapReceiptFor } from './lease-slots'

/** A cached bootstrap marker is reusable only with all three authenticated source events. */
export function assertBootstrapEvidence(
  state: Record<string, unknown>,
  lease: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
  token: string,
  expectedReceipts?: readonly unknown[],
  complete = true
): void {
  const bootstrap = bootstrapReceiptFor(state, lease.lease_id)
  if (
    !bootstrap ||
    bootstrap.lease_id !== lease.lease_id ||
    !Array.isArray(bootstrap.event_ids) ||
    !Array.isArray(bootstrap.receipts) ||
    bootstrap.receipts.length !== bootstrap.event_ids.length ||
    (complete
      ? bootstrap.event_ids.length !== 3
      : bootstrap.event_ids.length < 1 || bootstrap.event_ids.length > 3) ||
    new Set(bootstrap.event_ids).size !== bootstrap.event_ids.length
  )
    throw new Error('AGENT_BOOTSTRAP_REQUIRED')
  const processes = new Set<string>()
  let previousPosition = -1
  for (const [index, id] of bootstrap.event_ids.entries()) {
    const matches = eventsWithId(events, id),
      event = matches[0]
    if (matches.length !== 1 || !event) throw new Error('AGENT_BOOTSTRAP_EVIDENCE_INVALID')
    const actor = event.actor as Record<string, unknown> | undefined
    const payload = event.payload as Record<string, unknown> | undefined
    if (
      event.role !== lease.role ||
      event.type !== 'capability_probe' ||
      event.contract_revision !== state.contract_revision ||
      events.indexOf(event) <= previousPosition ||
      !isDeepStrictEqual(payload, bootstrap.receipts[index]) ||
      typeof payload?.processId !== 'string' ||
      !payload.processId ||
      processes.has(payload.processId) ||
      actor?.agent_id !== lease.agent_id ||
      actor?.lease_id !== lease.lease_id ||
      actor?.authority_epoch !== state.authority_epoch ||
      payload?.stage !== ['OPEN', 'REAUTHENTICATE', 'READY'][index] ||
      payload?.agentId !== lease.agent_id ||
      payload?.success !== true ||
      (expectedReceipts !== undefined && !isDeepStrictEqual(payload, expectedReceipts[index])) ||
      lease.event_public_key !== rolePublicKey(token) ||
      !verifyRoleEvent(event, String(lease.event_public_key))
    )
      throw new Error('AGENT_BOOTSTRAP_EVIDENCE_INVALID')
    processes.add(String(payload!.processId))
    previousPosition = events.indexOf(event)
  }
}
