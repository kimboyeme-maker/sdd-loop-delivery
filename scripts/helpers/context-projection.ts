import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { markdownSections } from '../utils/markdown-sections'
type Item = Record<string, unknown>
type Source = { path: string; class: string; bytes: number; sha256: string }
type Entry = {
  path: string
  heading: string
  requirement_ids: string[]
  acceptance_ids: string[]
  shared: boolean
}
const texts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

/** Only explicit unrelated ranges may be omitted. Unknown content and ambiguous indexes remain mandatory. */
export function projectContextSources(
  sources: readonly Source[],
  map: string | null,
  role: string,
  contract: Item | null,
  selected: Item | null
): { sources: Item[]; projection_fallbacks: string[]; total_bytes: number } {
  const fallbacks: string[] = []
  const entries = new Map<string, Entry[]>()
  if (map) {
    const blocks = [
      ...readFileSync(map, 'utf8').matchAll(
        /<!-- context-index:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- context-index:end -->/g
      )
    ]
    if (blocks.length)
      try {
        if (blocks.length !== 1) throw Error()
        const index = JSON.parse(blocks[0]![1]!)
        if (index.protocol !== 'context-index/v2' || !Array.isArray(index.sections) || !contract)
          throw Error()
        const reqs = new Set((contract.requirements as Item[]).map((item) => item.id))
        const acs = new Set((contract.acceptance as Item[]).map((item) => item.id))
        for (const raw of index.sections) {
          if (
            !raw ||
            typeof raw !== 'object' ||
            Array.isArray(raw) ||
            Object.keys(raw).sort().join(',') !==
              'acceptance_ids,heading,path,requirement_ids,shared' ||
            typeof raw.path !== 'string' ||
            isAbsolute(raw.path) ||
            typeof raw.heading !== 'string' ||
            !raw.heading.trim() ||
            !texts(raw.requirement_ids) ||
            !texts(raw.acceptance_ids) ||
            typeof raw.shared !== 'boolean' ||
            raw.requirement_ids.some((id: string) => !reqs.has(id)) ||
            raw.acceptance_ids.some((id: string) => !acs.has(id))
          )
            throw Error()
          const path = realpathSync(resolve(dirname(map), raw.path))
          // Index entries never introduce new sources or grant file access.
          if (!sources.some((source) => source.path === path)) continue
          entries.set(path, [...(entries.get(path) ?? []), { ...raw, path }])
        }
      } catch {
        entries.clear()
        fallbacks.push('INVALID_INDEX_FULL_READ')
      }
  }
  const reqs = new Set(((selected?.requirements ?? []) as Item[]).map((item) => item.id))
  const acs = new Set(((selected?.acceptance ?? []) as Item[]).map((item) => item.id))
  const projected = sources.map((source): Item => {
    const bytes = readFileSync(source.path),
      text = bytes.toString('utf8')
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
    let ranges: number[][] = [[0, lines.length]]
    const declared = entries.get(source.path) ?? []
    if (role !== 'coordinator' && selected && declared.length) {
      const sections = markdownSections(text)
      const intervals: { start: number; end: number; keep: boolean }[] = []
      let valid = true
      for (const entry of declared) {
        const matches = sections.filter((section) => section.heading === entry.heading)
        const section = matches[0]
        if (matches.length !== 1 || !section) {
          valid = false
          break
        }
        const next = sections.find(
          (item) => item.startLine > section.startLine && item.level <= section.level
        )
        intervals.push({
          start: section.startLine - 1,
          end: next ? next.startLine - 1 : lines.length,
          keep:
            entry.shared ||
            (!entry.requirement_ids.length && !entry.acceptance_ids.length) ||
            entry.requirement_ids.some((id) => reqs.has(id)) ||
            entry.acceptance_ids.some((id) => acs.has(id))
        })
      }
      intervals.sort((a, b) => a.start - b.start)
      if (intervals.some((item, index) => index > 0 && intervals[index - 1]!.end > item.start))
        valid = false
      if (!valid) fallbacks.push(source.path + ':AMBIGUOUS_SECTION_FULL_READ')
      else {
        const keep = lines.map(() => true)
        for (const interval of intervals)
          if (!interval.keep) keep.fill(false, interval.start, interval.end)
        // Routing instructions remain shared even if an index incorrectly assigns them
        // to an unrelated requirement. An index cannot remove source selection rules.
        for (const section of sections.filter((item) => item.heading === 'Agent Context')) {
          const next = sections.find(
            (item) => item.startLine > section.startLine && item.level <= section.level
          )
          keep.fill(true, section.startLine - 1, next ? next.startLine - 1 : lines.length)
        }
        let protectedBlock = false
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.includes('<!-- sdd-contract:start -->')) protectedBlock = true
          if (protectedBlock) keep[i] = true
          if (lines[i]!.includes('<!-- sdd-contract:end -->')) protectedBlock = false
        }
        ranges = []
        for (let i = 0; i < keep.length; i++)
          if (keep[i]) {
            const last = ranges.at(-1)
            if (last && last[1] === i) last[1] = i + 1
            else ranges.push([i, i + 1])
          }
      }
    }
    const selectedText = ranges.map(([start, end]) => lines.slice(start, end).join('')).join('')
    return {
      ...source,
      file_sha256: createHash('sha256').update(bytes).digest('hex'),
      ranges,
      bytes: Buffer.byteLength(selectedText),
      sha256: createHash('sha256').update(selectedText).digest('hex')
    }
  })
  return {
    sources: projected,
    projection_fallbacks: fallbacks,
    total_bytes: projected.reduce((sum, item) => sum + Number(item.bytes), 0)
  }
}
