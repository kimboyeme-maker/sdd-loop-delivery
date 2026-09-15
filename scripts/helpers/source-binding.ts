import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { contextRouting } from './context-routing'
import { canonicalJson } from '../resource/wire/canonical-json'

/** Freeze every normative source, including documents routed to other roles. */
export function normativeSourceBinding(sdd: string, source: Uint8Array = readFileSync(sdd)) {
  const text = Buffer.from(source).toString('utf8')
  return contextRouting(sdd, text, 'coordinator', undefined, false, false, [
    { path: resolve(sdd), content: text }
  ])
    .sources.filter((item) => item.class === 'normative')
    .map(({ path, sha256 }) => ({ path, sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Bind native SDD bytes; an unknown engine never bypasses source authentication. */
export function assertCurrentSource(
  state: Record<string, unknown>,
  sdd: string,
  source?: Uint8Array
): void {
  if (state.protocol !== 'control-plane/state-v2')
    throw new Error('CONTROL_STATE_PROTOCOL_UNSUPPORTED')
  if (typeof state.sdd_fingerprint !== 'string') throw new Error('SDD_SOURCE_BINDING_MISSING')
  const bytes = source ?? readFileSync(sdd)
  if (createHash('sha256').update(bytes).digest('hex') !== state.sdd_fingerprint)
    throw new Error('SDD_SOURCE_CHANGED_REQUIRES_AMEND')
  const current = normativeSourceBinding(sdd, bytes)
  if (state.normative_sources === undefined) {
    if (current.length > 1) throw new Error('NORMATIVE_SOURCE_BINDING_MISSING')
  } else if (canonicalJson(state.normative_sources) !== canonicalJson(current)) {
    throw new Error('NORMATIVE_SOURCE_CHANGED_REQUIRES_AMEND')
  }
}
