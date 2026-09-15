import { eventsWithId } from '../utils/event-index'
import { assertRoleEvidence } from './role-evidence'

type Item = Record<string, unknown>
export type PacketPrerequisite = { id: string; requirementIds: string[]; acceptanceIds: string[] }

/** Follow the admitted graph; omitting a packet cannot bypass a multi-packet dependency. */
export function packetPrerequisites(admission: Item, packetId?: string): PacketPrerequisite[] {
  const payload = admission.payload as Item
  const packets = payload.execution_packets as Item[]
  if (!Array.isArray(packets) || !packets.length) throw new Error('EXECUTION_PACKETS_REQUIRED')
  if (packetId === undefined && packets.length !== 1) throw new Error('DISPATCH_PACKET_REQUIRED')
  const selected = packetId ?? String(packets[0]!.id)
  const byId = new Map(packets.map((packet) => [String(packet.id), packet]))
  if (!byId.has(selected) || byId.size !== packets.length)
    throw new Error('DISPATCH_PACKET_INVALID')
  const pending = [...((byId.get(selected)!.depends_on_packet_ids ?? []) as string[])]
  const visited = new Set<string>()
  const result: PacketPrerequisite[] = []
  while (pending.length) {
    const id = pending.pop()!
    if (id === selected) throw new Error('EXECUTION_PACKET_DEPENDENCY_CYCLE')
    if (visited.has(id)) continue
    visited.add(id)
    const packet = byId.get(id)
    if (!packet) throw new Error('EXECUTION_PACKET_DEPENDENCY_SCOPE_INVALID')
    result.push({
      id,
      requirementIds: packet.requirement_ids as string[],
      acceptanceIds: packet.acceptance_ids as string[]
    })
    pending.push(...((packet.depends_on_packet_ids ?? []) as string[]))
  }
  return result
}

/** Require current-round implementation evidence, not premature independent acceptance.
 * Requiring Architect PASS here would deadlock: verification starts after all packets.
 * The caller separately rechecks the latest candidate against actual workspace bytes.
 */
export function assertPacketPrerequisiteEvidence(
  prerequisites: readonly PacketPrerequisite[],
  state: Item,
  events: readonly Item[],
  _candidate: Item
): void {
  const entered = events.findLastIndex(
    (event) =>
      event.type === 'state_transition' &&
      (event.payload as Item | undefined)?.to === 'IMPLEMENTING'
  )
  const completed = new Set<string>()
  for (const event of events.slice(entered + 1)) {
    if (
      event.type !== 'implementation' ||
      event.role !== 'operator' ||
      event.contract_revision !== state.contract_revision
    )
      continue
    assertRoleEvidence(state, event, 'operator')
    if (eventsWithId(events, event.event_id).length !== 1)
      throw new Error('PACKET_PREREQUISITE_EVIDENCE_AMBIGUOUS')
    const ids = (event.payload as Item | undefined)?.execution_packet_ids
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
      throw new Error('PACKET_PREREQUISITE_COVERAGE_INVALID')
    for (const id of ids) completed.add(id)
  }
  for (const packet of prerequisites) {
    if (!completed.has(packet.id))
      throw new Error('EXECUTION_PACKET_PREDECESSOR_NOT_IMPLEMENTED:' + packet.id)
  }
}
