import { documentSource } from '../resource/document-source'
import { readFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { readContractText } from '../domain/contract'
import { contextRouting } from '../helpers/context-routing'

/** Load only explicitly normative detail sources; contextual material cannot define the contract. */
export function readContractBundle(
  sdd: string,
  text = readFileSync(sdd, 'utf8'),
  documents: readonly { path: string; content: string }[] = []
) {
  const sources: Record<string, string> = { self: text }
  const provided = documentSource(documents)
  const root = provided.canonical(sdd)
  const related = documents.filter((entry) => {
    if (provided.canonical(entry.path) !== root) return true
    if (entry.content !== text) throw Error('DRAFT_ROOT_CONTENT_CONFLICT')
    return false
  })
  const overlay = [...related, { path: root, content: text }]
  const io = documentSource(overlay)
  for (const source of contextRouting(sdd, text, 'coordinator', undefined, false, false, overlay)
    .sources) {
    if (source.class === 'normative' && source.path !== root)
      sources[relative(dirname(root), source.path)] = io.read(source.path).toString('utf8')
  }
  return { contract: readContractText(text, sources), sources }
}

/** Share the same normative source collection across execution and read-only presentation. */
export function readContractDocument(
  sdd: string,
  text = readFileSync(sdd, 'utf8'),
  documents: readonly { path: string; content: string }[] = []
) {
  return readContractBundle(sdd, text, documents).contract
}
