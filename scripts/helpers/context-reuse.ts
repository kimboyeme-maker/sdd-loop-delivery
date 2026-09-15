import { parseEvents } from '../resource/store/event-log'
import { findLeaseByAgent } from './lease-slots'
import { readSnapshot } from '../resource/state'
import { assertActiveLease } from '../domain/policies/active-lease'
import { assertRoleEvidence } from './role-evidence'
import { verifyRoleEvent } from '../resource/role-signature'
import { roleCapabilityToken } from '../resource/role-capability'
type Item = Record<string, unknown>

/** Reading facts are reusable only by the same authenticated runtime in this epoch.
 * Recovery invalidates retention; an explicit retained-understanding assertion is
 * still required by the caller. A content hash alone never makes that assertion.
 */
export function reusableContextSources(
  sdd: string,
  role: string,
  agentId: string,
  sources: readonly Item[],
  packetId?: string,
  fresh = false
): Item[] {
  const { state, eventText } = readSnapshot(sdd)
  const lease = findLeaseByAgent(state as Item, agentId)
  if (
    !lease ||
    !['operator', 'architect'].includes(role) ||
    lease.role !== role ||
    lease.agent_id !== agentId ||
    (lease.packet_id ?? null) !== (packetId ?? null)
  )
    throw Error('CONTEXT_REUSE_ASSIGNMENT_INVALID')
  assertActiveLease(state, lease)
  try {
    roleCapabilityToken(lease)
  } catch {
    throw Error('CONTEXT_REUSE_AUTH_INVALID')
  }
  if (state.pending_pipeline_repair) return []
  const freshOnly = fresh || lease.verification_mode === 'fresh-independent' || !!lease.fresh_reason
  const result = new Map<string, Item>()
  const events = parseEvents(eventText)
  const counts = new Map<unknown, number>()
  for (const event of events) counts.set(event.event_id, (counts.get(event.event_id) ?? 0) + 1)
  for (const event of [...events].reverse()) {
    if (
      ['pipeline_incident', 'recovery', 'coordinator_takeover', 'contract_amendment'].includes(
        String(event.type)
      )
    )
      break
    const actor = event.actor as Item | undefined
    const prepared = lease.prepared_grant as Item | undefined
    const preparedEvent =
      role === 'architect' &&
      event.type === 'context_ready' &&
      prepared &&
      event.event_id === prepared.ready_event_id &&
      actor?.prepared_id === prepared.prepared_id &&
      prepared.agent_id === agentId &&
      prepared.authority_epoch === state.authority_epoch &&
      prepared.contract_revision === state.contract_revision &&
      prepared.admission_event_id === lease.admission_event_id &&
      prepared.event_public_key === lease.event_public_key
    if (
      (!preparedEvent &&
        (freshOnly || !['agent_started', 'context_refresh'].includes(String(event.type)))) ||
      event.role !== role ||
      actor?.agent_id !== agentId ||
      actor.authority_epoch !== state.authority_epoch
    )
      continue
    if (counts.get(event.event_id) !== 1) continue
    try {
      if (preparedEvent) {
        if (!verifyRoleEvent(event, String(prepared.event_public_key))) continue
      } else assertRoleEvidence(state, event, role)
    } catch {
      continue
    }
    const reading = (event.payload as Item | undefined)?.reading as Item | undefined
    if (reading?.protocol !== 'context-read-evidence/v1' || !Array.isArray(reading.sources))
      continue
    for (const source of sources) {
      if (result.has(String(source.path))) continue
      if (
        reading.sources.some(
          (old: Item) =>
            old !== null &&
            typeof old === 'object' &&
            !Array.isArray(old) &&
            old.path === source.path &&
            old.class === source.class &&
            old.sha256 === source.sha256 &&
            old.bytes === source.bytes
        )
      ) {
        for (const [key, entry] of result) if (entry.path === source.path) result.delete(key)
        result.set(String(source.path), {
          path: source.path,
          class: source.class,
          sha256: source.sha256,
          bytes: source.bytes,
          event_id: event.event_id
        })
        continue
      }
      const currentFragments = Array.isArray(source.fragments) ? (source.fragments as Item[]) : []
      const previousFragments = (reading.sources as Item[])
        .filter(
          (old) =>
            old &&
            old.path === source.path &&
            old.class === source.class &&
            Array.isArray(source.fragment_layout) &&
            JSON.stringify(old.fragment_layout) === JSON.stringify(source.fragment_layout) &&
            Array.isArray(old.fragments)
        )
        .flatMap((old) => old.fragments as Item[])
      for (const fragment of currentFragments) {
        // @document is the ambiguity fallback, never partial evidence.
        if (
          fragment.fragment === '@document' ||
          !previousFragments.some(
            (old) =>
              old &&
              old.fragment === fragment.fragment &&
              old.sha256 === fragment.sha256 &&
              old.bytes === fragment.bytes
          )
        )
          continue
        const key = JSON.stringify([source.path, fragment.fragment])
        if (!result.has(key))
          result.set(key, {
            path: source.path,
            class: source.class,
            fragment: fragment.fragment,
            sha256: fragment.sha256,
            bytes: fragment.bytes,
            event_id: event.event_id
          })
      }
    }
  }
  return [...result.values()].sort((a, b) =>
    JSON.stringify([a.path, a.fragment ?? null]).localeCompare(
      JSON.stringify([b.path, b.fragment ?? null])
    )
  )
}
