import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { contextDocument, type ContextSelection } from './context-document'
import { contextView } from './context-view'
import { canonicalJson } from '../resource/wire/canonical-json'

/** Verify complete original-byte coverage; this is not proof of retained understanding. */
export function assertContextReadEvidence(
  sdd: string,
  file: string,
  selection?: ContextSelection
): Readonly<{
  protocol: 'context-read-evidence/v1'
  role: string
  packet_id: string | null
  fresh: boolean
  context_fingerprint: string
  content_sha256: string
  bytes: number
  pages: number
  sources: Record<string, unknown>[]
  reused_read_receipts: Record<string, unknown>[]
  retained_understanding: boolean
}> {
  let input: unknown
  try {
    input = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error('CONTEXT_READ_EVIDENCE_REQUIRED')
  }
  const pages = Array.isArray(input) ? input : [input]
  if (!pages.length) throw new Error('CONTEXT_READ_INCOMPLETE')
  const first = pages[0] as Record<string, unknown> | null
  const v2 = first?.protocol === 'context-read/v2'
  const expected = selection
    ? { ...selection, fresh: selection.fresh ?? first?.fresh === true }
    : {
        role: String(first?.role ?? 'coordinator'),
        packetId: typeof first?.packet_id === 'string' ? first.packet_id : undefined,
        fresh: first?.fresh === true
      }
  if (first?.retained_understanding === true) {
    if (!selection?.agentId || first.agent_id !== selection.agentId)
      throw Error('CONTEXT_REUSE_AGENT_REQUIRED')
    Object.assign(expected, { agentId: selection.agentId, retainedUnderstanding: true })
  }
  const document = v2 ? contextDocument(sdd, expected) : null
  const source = document?.bytes ?? readFileSync(sdd)
  if (
    !v2 &&
    (
      (
        contextView(sdd, expected.role, expected.packetId, expected.fresh) as Record<
          string,
          unknown
        >
      ).sources as unknown[]
    ).length > 1
  )
    throw new Error('CONTEXT_READ_LINKED_SOURCES_REQUIRED')
  let cursor = 0
  for (const [index, value] of pages.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('CONTEXT_READ_EVIDENCE_INVALID')
    const page = value as Record<string, unknown>
    const start = page.actualOffset,
      end = page.end
    if (
      page.protocol !== (v2 ? 'context-read/v2' : 'context-read/v1') ||
      (v2 &&
        (page.role !== expected.role ||
          (page.packet_id ?? null) !== (expected.packetId ?? null) ||
          page.fresh !== (expected.fresh ?? false) ||
          (page.prepared_id ?? null) !== (selection?.preparedId ?? null) ||
          (page.retained_understanding ?? false) !== (first?.retained_understanding === true) ||
          (first?.retained_understanding === true &&
            (page.agent_id !== selection?.agentId ||
              canonicalJson(page.reused_read_receipts) !== canonicalJson(document!.reused))) ||
          page.context_fingerprint !== document!.fingerprint)) ||
      typeof page.sdd !== 'string' ||
      resolve(page.sdd) !== resolve(sdd) ||
      page.offset !== cursor ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      Number(start) !== cursor ||
      Number(end) < cursor ||
      Number(end) > source.length ||
      (Number(end) === cursor && source.length !== 0) ||
      page.totalBytes !== source.length
    )
      throw new Error('CONTEXT_READ_EVIDENCE_INVALID')
    const chunk = source.subarray(cursor, Number(end))
    if (
      page.text !== chunk.toString('utf8') ||
      page.sha256 !== createHash('sha256').update(chunk).digest('hex')
    )
      throw new Error('CONTEXT_READ_SOURCE_MISMATCH')
    cursor = Number(end)
    const final = cursor === source.length
    if (
      page.complete !== final ||
      page.nextOffset !== (final ? null : cursor) ||
      (final && index !== pages.length - 1)
    )
      throw new Error('CONTEXT_READ_EVIDENCE_INVALID')
  }
  if (cursor !== source.length) throw new Error('CONTEXT_READ_INCOMPLETE')
  const contentHash = createHash('sha256').update(source).digest('hex')
  return {
    protocol: 'context-read-evidence/v1',
    role: expected.role,
    packet_id: expected.packetId ?? null,
    fresh: expected.fresh ?? false,
    context_fingerprint: document?.fingerprint ?? contentHash,
    content_sha256: contentHash,
    bytes: source.length,
    pages: pages.length,
    sources: document?.sources ?? [],
    reused_read_receipts: document?.reused ?? [],
    retained_understanding: first?.retained_understanding === true
  }
}
