import { markdownProseLines } from '../utils/markdown-prose'
import { documentSource } from '../resource/document-source'
import { existsSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
type Source = { path: string; class: string; bytes: number; sha256: string }
const link = /^\s*@(?:<([^>]+)>|(\S+))\s*$/

/** Route explicitly declared Markdown sources; nested @ text is not a recursive include. */
export function contextRouting(
  sdd: string,
  text: string,
  role: string,
  packetId?: string,
  fresh = false,
  allPackets = false,
  documents: readonly { path: string; content: string }[] = []
): {
  map: string | null
  routing_map_sha256: string | null
  selected_blocks: string[]
  sources: Source[]
  total_bytes: number
} {
  const io = documentSource(documents)
  const sddPath = io.canonical(sdd)
  let root = dirname(sddPath),
    cursor = root
  while (true) {
    if (existsSync(resolve(cursor, '.git'))) {
      root = cursor
      break
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const resolveLink = (source: string, raw: string): string => {
    if (isAbsolute(raw) || extname(raw).toLowerCase() !== '.md')
      throw new Error('AGENT_CONTEXT_LINK_INVALID')
    const target = io.canonical(resolve(dirname(source), raw))
    const rel = relative(root, target)
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      throw new Error('AGENT_CONTEXT_LINK_ESCAPES_ROOT')
    if (!io.isFile(target)) throw new Error('AGENT_CONTEXT_LINK_NOT_FOUND')
    return target
  }
  const prose = [...markdownProseLines(text)].map((line) => line.text)
  const declarations = prose.flatMap((line, index) =>
    /^##\s+Agent Context\s*$/.test(line) ? [index] : []
  )
  if (declarations.length > 1) throw new Error('AGENT_CONTEXT_ENTRY_AMBIGUOUS')
  const declaration = declarations[0]
  const routes = new Map<string, { path: string; class: string }[]>()
  let map: string | null = null,
    mapHash: string | null = null
  if (declaration !== undefined) {
    const rest = prose.slice(declaration + 1)
    const end = rest.findIndex((line) => /^##\s+|^<!--\s*sdd-contract:start/.test(line))
    const lines = rest.slice(0, end < 0 ? undefined : end).filter((line) => line.trim())
    const entry = lines.length === 1 ? link.exec(lines[0]!) : null
    if (!entry) throw new Error('AGENT_CONTEXT_ENTRY_INVALID')
    map = resolveLink(sddPath, entry[1] ?? entry[2]!)
    const bytes = io.read(map)
    mapHash = createHash('sha256').update(bytes).digest('hex')
    let block: string | undefined,
      classification = 'contextual'
    const classes = new Map<string, string>()
    for (const { text: line } of markdownProseLines(bytes.toString('utf8'))) {
      const heading =
        /^##\s+(Shared|Coordinator|Temporary|Operator|Architect|Fresh Operator|Fresh Architect|Packet\s+\S+)\s*$/i.exec(
          line
        )
      if (heading) {
        block = heading[1]!.toLowerCase()
        classification = 'contextual'
        if (!routes.has(block)) routes.set(block, [])
        continue
      }
      if (/^##\s+/.test(line)) throw new Error('AGENT_CONTEXT_BLOCK_INVALID')
      const kind = /^###\s+(Normative|Contextual|Evidence|Untrusted)\s*$/i.exec(line)
      if (kind) {
        if (!block) throw new Error('AGENT_CONTEXT_CLASS_OUTSIDE_BLOCK')
        classification = kind[1]!.toLowerCase()
        continue
      }
      if (/^###\s+/.test(line)) throw new Error('AGENT_CONTEXT_CLASS_INVALID')
      const item = link.exec(line)
      if (!item) continue
      if (!block) throw new Error('AGENT_CONTEXT_LINK_OUTSIDE_BLOCK')
      const path = resolveLink(map, item[1] ?? item[2]!)
      if (classes.has(path) && classes.get(path) !== classification)
        throw new Error('AGENT_CONTEXT_SOURCE_CLASS_CONFLICT')
      classes.set(path, classification)
      routes.get(block)!.push({ path, class: classification })
    }
    if (!routes.size) throw new Error('AGENT_CONTEXT_MAP_EMPTY')
  }
  const selected = ['shared', role]
  if (fresh) selected.push(`fresh ${role}`)
  if (allPackets) selected.push(...[...routes.keys()].filter((key) => key.startsWith('packet ')))
  if (packetId) selected.push(`packet ${packetId}`.toLowerCase())
  const seeds = [
    { path: sddPath, class: 'normative' },
    ...selected.flatMap((key) => routes.get(key) ?? []),
    ...[...routes.values()]
      .flat()
      .filter((item) => role === 'coordinator' && item.class === 'normative')
  ]
  const sources: Source[] = [],
    seen = new Map<string, string>()
  for (const seed of seeds) {
    if (seen.has(seed.path)) {
      if (seen.get(seed.path) !== seed.class) throw new Error('AGENT_CONTEXT_SOURCE_CLASS_CONFLICT')
      continue
    }
    seen.set(seed.path, seed.class)
    const bytes = io.read(seed.path)
    sources.push({
      ...seed,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  }
  return {
    map,
    routing_map_sha256: mapHash,
    selected_blocks: selected,
    sources,
    total_bytes: sources.reduce((n, item) => n + item.bytes, 0)
  }
}
