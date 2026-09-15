import { parseEvents } from '../resource/store/event-log'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readSnapshot, sidecarPaths } from '../resource/state'
import { readContractDocument } from '../services/contract-document'
import { assertCurrentSource } from '../helpers/source-binding'
import { currentAdmission } from '../helpers/admission-authority'
import { contractContext } from '../helpers/contract-context'
import { contextRouting } from '../helpers/context-routing'
import { projectContextSources } from '../helpers/context-projection'
import { markdownSections } from '../utils/markdown-sections'

/** Shared projection for viewing, reading and receipt validation. */
export function contextView(
  sdd: string,
  role = 'coordinator',
  packetId?: string,
  fresh = false
): object {
  if (!['coordinator', 'operator', 'architect', 'temporary'].includes(role))
    throw new Error('CONTEXT_ROLE_INVALID')
  const source = readFileSync(sdd)
  const text = source.toString('utf8')
  const contract = readContractDocument(sdd, text)
  const snapshot = existsSync(sidecarPaths(sdd).state) ? readSnapshot(sdd) : null
  if (snapshot) assertCurrentSource(snapshot.state, sdd, source)
  const final = role === 'architect' && snapshot?.state.phase === 'FINAL_VERIFY'
  let packet: Record<string, unknown> | undefined
  if (packetId) {
    if (!snapshot) throw new Error('CONTEXT_PACKET_NOT_ADMITTED')
    const events = parseEvents(snapshot.eventText)
    const admission = currentAdmission(
      snapshot.state,
      events,
      process.env.SDD_LOOP_COORDINATOR_TOKEN ?? ''
    ).payload as Record<string, unknown>
    const matches = (admission.execution_packets as Record<string, unknown>[]).filter(
      (item) => item.id === packetId
    )
    if (matches.length !== 1) throw new Error('CONTEXT_PACKET_NOT_ADMITTED')
    if (
      role !== 'coordinator' &&
      !(role === 'architect' && snapshot.state.phase === 'FINAL_VERIFY')
    )
      packet = matches[0]
  }
  const routing = contextRouting(sdd, text, role, packetId, fresh, final)
  const selected = contract ? contractContext(contract, packet) : null
  return {
    sdd,
    role,
    fresh,
    ...routing,
    ...projectContextSources(routing.sources, routing.map, role, contract, selected),
    packet_id: packetId ?? null,
    ...(selected ? { contract: selected } : {}),
    protocol: 'context-view/v2',
    source: { bytes: source.byteLength, sha256: createHash('sha256').update(source).digest('hex') },
    sections: markdownSections(text).map(({ heading, startLine, endLine, text: section }) => ({
      heading,
      startLine,
      endLine,
      bytes: Buffer.byteLength(section),
      sha256: createHash('sha256').update(section).digest('hex')
    })),
    note: 'Original sections and hashes only; no model summary and no completion claim.'
  }
}
