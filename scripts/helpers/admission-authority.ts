import { eventsWithId, lastIndexOfType } from '../utils/event-index'
import { verifyCoordinatorProof } from '../resource/coordinator-evidence'
import { createHmac } from 'node:crypto'
import type { Contract } from '../domain/contract'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0
const list = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(text) &&
  new Set(value).size === value.length

/**
 * Read the latest route decision, never fall back to an older convenient ADMIT.
 * The authenticated producer has already validated the admission payload. Source,
 * epoch and revision bindings prevent a recorded approval becoming a blank cheque
 * after an amendment, takeover or failed execution. This does not authenticate a
 * host runtime or replace the role-specific dispatch checks.
 */
export function currentAdmission(state: Item, events: readonly Item[], token?: string): Item {
  if (state.protocol !== 'control-plane/state-v2')
    throw new Error('ADMISSION_STATE_PROTOCOL_UNSUPPORTED')
  const index = lastIndexOfType(events, 'contract_admission')
  const event = events[index]
  if (!event) throw new Error('CONTRACT_ADMISSION_GATE_MISSING')
  const { signature, ...body } = event
  const payload = object(event.payload)
  if (
    event.role !== 'coordinator' ||
    !text(event.event_id) ||
    eventsWithId(events, event.event_id).length !== 1 ||
    payload?.decision !== 'ADMIT' ||
    !Number.isSafeInteger(state.authority_epoch) ||
    Number(state.authority_epoch) < 1 ||
    event.authority_epoch !== state.authority_epoch ||
    !text(state.contract_revision) ||
    event.contract_revision !== state.contract_revision ||
    !text(state.sdd_fingerprint) ||
    event.sdd_fingerprint !== state.sdd_fingerprint ||
    (event.coordinator_proof !== undefined
      ? !verifyCoordinatorProof(state, event)
      : !token ||
        signature !== createHmac('sha256', token).update(JSON.stringify(body)).digest('hex'))
  )
    throw new Error('CONTRACT_ADMISSION_AUTHORITY_INVALID')
  if (
    state.pending_execution_failure != null ||
    state.pending_user_decision != null ||
    events
      .slice(index + 1)
      .some((item) =>
        ['timeout_decision', 'contract_amendment', 'coordinator_takeover'].includes(
          String(item.type)
        )
      )
  )
    throw new Error('CONTRACT_ADMISSION_AUTHORITY_STALE')
  return event
}

/** Bind the requested product scope and optional packet to this exact admission. */
export function admissionDispatchScope(
  event: Item,
  role: 'operator' | 'architect',
  scope: readonly string[],
  packetId?: string
): void {
  const payload = object(event.payload)!
  let allowed: unknown = payload.modification_packages
  // An Operator packet that declares its own write set is confined to it.
  const packet =
    packetId !== undefined && Array.isArray(payload.execution_packets)
      ? object(payload.execution_packets.find((value) => object(value)?.id === packetId))
      : undefined
  if (role === 'operator' && list(packet?.modification_packages))
    allowed = packet.modification_packages
  if (role === 'architect') {
    const surfaces = object(payload.verification_scope)?.surfaces
    if (!Array.isArray(surfaces) || surfaces.some((entry) => !list(object(entry)?.packages)))
      throw new Error('ADMISSION_DISPATCH_SCOPE_INVALID')
    allowed = [...new Set(surfaces.flatMap((entry) => object(entry)!.packages as string[]))]
  }
  if (
    !list(allowed) ||
    !scope.length ||
    scope.some(
      (path) =>
        !allowed.some((root) => root === '.' || path === root || path.startsWith(root + '/'))
    )
  )
    throw new Error('ADMISSION_DISPATCH_SCOPE_INVALID')
  if (packetId !== undefined) {
    if (
      !text(packetId) ||
      !Array.isArray(payload.execution_packets) ||
      payload.execution_packets.filter((value) => object(value)?.id === packetId).length !== 1
    )
      throw new Error('ADMISSION_DISPATCH_PACKET_INVALID')
  }
}

/**
 * Final verification reads the whole normative Must-Ship set, not the last
 * admitted packet's projection. Include deferred items in the reading inventory;
 * only the existing signed deferral/SHIP checks may exclude their execution.
 * This grants verification scope only, never additional Operator write authority.
 */
export function finalVerificationScope(
  contract: Contract,
  scope: readonly string[]
): {
  requirement_ids: string[]
  acceptance_ids: string[]
} {
  const requirements = contract.requirements.filter((item) => item.kind === 'must-ship')
  if (!requirements.length || !Array.isArray(contract.acceptance))
    throw new Error('FINAL_VERIFICATION_CONTRACT_REQUIRED')
  const acceptance = new Map<string, Item>()
  for (const value of contract.acceptance) {
    const entry = object(value)
    if (!entry || !text(entry.id) || acceptance.has(entry.id))
      throw new Error('FINAL_VERIFICATION_CONTRACT_INVALID')
    acceptance.set(entry.id, entry)
  }
  const ids = new Set<string>(),
    packages = new Set<string>()
  for (const requirement of requirements) {
    if (!list(requirement.acceptance)) throw new Error('FINAL_VERIFICATION_ACCEPTANCE_REQUIRED')
    for (const id of requirement.acceptance) {
      const entry = acceptance.get(id)
      if (
        !entry ||
        !list(entry.packages) ||
        !list(entry.requirement_ids) ||
        !entry.requirement_ids.includes(requirement.id)
      )
        throw new Error('FINAL_VERIFICATION_CONTRACT_INVALID')
      ids.add(id)
      for (const owner of entry.packages) packages.add(owner)
    }
  }
  if (
    !scope.length ||
    scope.some(
      (path) =>
        ![...packages].some((root) => root === '.' || path === root || path.startsWith(root + '/'))
    )
  )
    throw new Error('FINAL_VERIFICATION_SCOPE_INVALID')
  return { requirement_ids: requirements.map((item) => item.id), acceptance_ids: [...ids] }
}
