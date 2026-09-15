import { tableCells } from './markdown-table'
import { markdownProseLines } from './markdown-prose'
export type DocumentTable = {
  document: string
  heading: string
  table: number
  line: number
  headers: string[]
  ambiguous_heading: boolean
  rows: { line: number; values: Record<string, string> }[]
}
/** Strip cell framing only; explanatory content remains authored text. */
export const plainCell = (text: string): string =>
  text
    .trim()
    .replace(/^[\x60*]+|[\x60*]+$/g, '')
    .trim()
    .replaceAll('\\|', '|')
export const cellReferences = (text: string): string[] =>
  text
    .trim()
    .split(/[,，、;；\s]+/)
    .map(plainCell)
    .filter((value) => !['', '—', '-', '[]'].includes(value))

/** Locate real pipe tables with physical lines; fenced examples cannot define reporting objects. */
export function documentTables(text: string, document: string): DocumentTable[] {
  const unquoted = text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:>\s*)+/, ''))
    .join('\n')
  const visible = new Map<number, { text: string; heading: string }>()
  const headingCounts = new Map<string, number>()
  let heading = ''
  for (const line of markdownProseLines(unquoted)) {
    if (/^ {4}/.test(line.text)) continue
    const match = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line.text)
    if (match) {
      heading = match[1]!
      headingCounts.set(heading, (headingCounts.get(heading) ?? 0) + 1)
    }
    if (/<table\b/i.test(line.text))
      throw Error(`${document}:${line.line}: SDD_HTML_TABLE_UNSUPPORTED`)
    visible.set(line.line, { text: line.text, heading })
  }
  const result: DocumentTable[] = []
  const counts = new Map<string, number>()
  let last = 0
  for (const line of visible.keys()) last = line
  for (let line = 1; line < last; line++) {
    const current = visible.get(line),
      next = visible.get(line + 1)
    if (!current || !next || !current.text.includes('|')) continue
    const dividers = tableCells(next.text)
    if (!dividers.length || !dividers.every((cell) => /^:?-{3,}:?$/.test(cell))) continue
    const headers = tableCells(current.text).map((cell) => plainCell(cell).toLowerCase())
    if (headers.length !== dividers.length || new Set(headers).size !== headers.length)
      throw Error(`${document}:${line}: SDD_TABLE_COLUMNS_INVALID`)
    const number = (counts.get(current.heading) ?? 0) + 1
    counts.set(current.heading, number)
    const table: DocumentTable = {
      document,
      heading: current.heading,
      table: number,
      line,
      headers,
      rows: [],
      ambiguous_heading: (headingCounts.get(current.heading) ?? 0) > 1
    }
    line += 2
    for (; line <= last; line++) {
      const row = visible.get(line)
      if (!row || !row.text.trim() || !row.text.includes('|')) break
      const cells = tableCells(row.text)
      if (cells.length !== headers.length)
        throw Error(`${document}:${line}: SDD_TABLE_COLUMNS_MISMATCH`)
      table.rows.push({
        line,
        values: Object.fromEntries(headers.map((name, index) => [name, cells[index]!]))
      })
    }
    line--
    result.push(table)
  }
  return result
}
