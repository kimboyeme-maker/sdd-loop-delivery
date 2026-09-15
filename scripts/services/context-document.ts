import { parseEvents } from '../resource/store/event-log'
import { roleCapabilityToken } from '../resource/role-capability'
import { contextFragments } from '../helpers/context-fragments'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../resource/wire/canonical-json'
import { contextView } from './context-view'
import { reusableContextSources } from '../helpers/context-reuse'
import { readSnapshot } from '../resource/state'
import { assertCurrentSource } from '../helpers/source-binding'
import { currentAdmission } from '../helpers/admission-authority'
type Item = Record<string, unknown>
export type ContextSelection = {
  role: string
  packetId?: string | undefined
  fresh?: boolean | undefined
  agentId?: string | undefined
  retainedUnderstanding?: boolean | undefined
  preparedId?: string | undefined
}

/** Materialize only original selected text, with explicit source/class boundaries. Never summarize. */
export function contextDocument(
  sdd: string,
  selection: ContextSelection
): { bytes: Buffer; fingerprint: string; sources: Item[]; reused: Item[] } {
  if (selection.preparedId) {
    const { state, eventText } = readSnapshot(sdd)
    const grant = state.preparation as Item | undefined
    if (
      !grant ||
      selection.role !== 'architect' ||
      grant.prepared_id !== selection.preparedId ||
      grant.agent_id !== selection.agentId ||
      grant.authority_epoch !== state.authority_epoch ||
      grant.contract_revision !== state.contract_revision
    )
      throw Error('PREPARATION_CONTEXT_AUTH_INVALID')
    try {
      roleCapabilityToken(grant)
    } catch {
      throw Error('PREPARATION_CONTEXT_AUTH_INVALID')
    }
    if (
      ['PAUSED', 'CANCELLED', 'SHIP', 'BLOCKED'].includes(String(state.phase)) ||
      state.pending_pipeline_repair
    )
      throw Error('PREPARATION_STATE_INVALID')
    assertCurrentSource(state, sdd)
    const events = parseEvents(eventText)
    if (
      grant.source_sha256 !== state.sdd_fingerprint ||
      grant.admission_event_id !== currentAdmission(state, events).event_id
    )
      throw Error('PREPARATION_ADMISSION_STALE')
    const snapshot = grant.context_snapshot as Item | undefined
    if (
      !snapshot ||
      typeof snapshot.text !== 'string' ||
      typeof snapshot.fingerprint !== 'string' ||
      !Array.isArray(snapshot.sources) ||
      (selection.fresh ?? false) !== (grant.fresh === true) ||
      selection.packetId ||
      selection.retainedUnderstanding
    )
      throw Error('PREPARATION_CONTEXT_SNAPSHOT_INVALID')
    return {
      bytes: Buffer.from(snapshot.text),
      fingerprint: snapshot.fingerprint,
      sources: snapshot.sources as Item[],
      reused: []
    }
  }
  const view = contextView(
    sdd,
    selection.role,
    selection.packetId,
    selection.fresh ?? false
  ) as Item
  const originals = (view.sources as Item[]).map((source) => {
    const raw = readFileSync(String(source.path))
    if (createHash('sha256').update(raw).digest('hex') !== source.file_sha256)
      throw Error('CONTEXT_SOURCE_CHANGED')
    const lines = raw.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) ?? []
    const text = (source.ranges as number[][])
      .map(([start, end]) => lines.slice(start, end).join(''))
      .join('')
    if (createHash('sha256').update(text).digest('hex') !== source.sha256)
      throw Error('CONTEXT_SOURCE_CHANGED')
    return { source, text, fragments: contextFragments(text) }
  })
  const sources = originals.map(({ source, fragments }) => ({
    path: source.path,
    class: source.class,
    sha256: source.sha256,
    bytes: source.bytes,
    fragment_layout: fragments.map((item) => item.fragment),
    fragments: fragments.map(({ text: _text, ...metadata }) => metadata)
  }))
  if (selection.retainedUnderstanding && !selection.agentId)
    throw Error('CONTEXT_REUSE_AGENT_REQUIRED')
  const reused = selection.retainedUnderstanding
    ? reusableContextSources(
        sdd,
        selection.role,
        selection.agentId!,
        sources,
        selection.packetId,
        selection.fresh
      )
    : []
  const parts = originals.flatMap(({ source, text, fragments }) => {
    const previous = reused.filter((item) => item.path === source.path)
    if (previous.some((item) => item.fragment === undefined)) return []
    if (!previous.length) return [JSON.stringify({ path: source.path, class: source.class, text })]
    return fragments
      .filter(
        (fragment) =>
          !previous.some(
            (item) => item.fragment === fragment.fragment && item.sha256 === fragment.sha256
          )
      )
      .map((fragment) =>
        JSON.stringify({
          path: source.path,
          class: source.class,
          fragment: fragment.fragment,
          text: fragment.text
        })
      )
  })
  return {
    bytes: Buffer.from(parts.join('\n')),
    fingerprint: createHash('sha256').update(canonicalJson({ view, reused })).digest('hex'),
    sources,
    reused
  }
}

/** Bound a page to the complete projection; final-page status alone is not full-read evidence. */
export function contextDocumentPage(
  sdd: string,
  selection: ContextSelection,
  offset: number,
  limit: number
): Item {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('CONTEXT_OFFSET_INVALID')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 262144)
    throw new Error('CONTEXT_LIMIT_INVALID')
  const { bytes, fingerprint, reused } = contextDocument(sdd, selection)
  if (offset > bytes.length) throw new Error('CONTEXT_OFFSET_OUT_OF_RANGE')
  let start = offset,
    end = Math.min(offset + limit, bytes.length)
  while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end++
  const chunk = bytes.subarray(start, end)
  return {
    protocol: 'context-read/v2',
    sdd,
    role: selection.role,
    packet_id: selection.packetId ?? null,
    fresh: selection.fresh ?? false,
    agent_id: selection.agentId ?? null,
    prepared_id: selection.preparedId ?? null,
    retained_understanding: selection.retainedUnderstanding ?? false,
    reused_read_receipts: reused,
    context_fingerprint: fingerprint,
    offset,
    actualOffset: start,
    end,
    limit,
    totalBytes: bytes.length,
    complete: end === bytes.length,
    nextOffset: end === bytes.length ? null : end,
    sha256: createHash('sha256').update(chunk).digest('hex'),
    text: chunk.toString('utf8')
  }
}
