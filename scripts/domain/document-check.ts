import { SDD_DOCUMENT_ID_PATTERN } from '../config/constants'
import { tableCells } from '../utils/markdown-table'
import { readFileSync } from 'node:fs'

export type DocumentDiagnostic = Readonly<{ code: string; line: number; message: string }>
const ID = new RegExp(SDD_DOCUMENT_ID_PATTERN)
const ID_TOKEN = /\b[A-Z]{2}[0-9]{1,5}\b/g

/** Check SDD presentation and references without deciding semantic design quality. */
export function checkDocument(path: string): readonly DocumentDiagnostic[] {
  return checkDocumentText(readFileSync(path, 'utf8'))
}

/** Same structural checker for an unpersisted draft; never performs file I/O. */
export function checkDocumentText(text: string): readonly DocumentDiagnostic[] {
  const lines = text.split(/\r?\n/)
  const diagnostics: DocumentDiagnostic[] = []
  const definitions = new Map<string, number>()
  const references = new Map<string, number[]>()
  let fence: { character: string; length: number } | undefined
  let tableHeader: { columns: string[]; line: number } | undefined

  const report = (code: string, line: number, message: string) =>
    diagnostics.push({ code, line, message })
  lines.forEach((raw, index) => {
    const line = index + 1
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(raw)
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.character &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = undefined
      return
    }
    if (marker) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length }
      tableHeader = undefined
      return
    }
    const parsed = tableCells(raw)
    const next = tableCells(lines[index + 1] ?? '')
    const rowShape = parsed.length > 1 || raw.trimStart().startsWith('|')
    const begins =
      rowShape && next.length === parsed.length && next.every((cell) => /^:?-{3,}:?$/.test(cell))
    const cells = rowShape && (tableHeader || begins) ? parsed : undefined
    if (cells) {
      const separator = cells.every((cell) => /^:?-{3,}:?$/.test(cell))
      if (!tableHeader && !separator) {
        tableHeader = { columns: cells.map((cell) => cell.toLowerCase()), line }
        if (!tableHeader.columns.includes('description'))
          report('SDD_TABLE_DESCRIPTION_MISSING', line, 'table must contain description column')
      } else if (tableHeader && !separator) {
        if (cells.length !== tableHeader.columns.length)
          report('SDD_TABLE_COLUMNS_MISMATCH', line, 'table row does not match its header')
        const description = tableHeader.columns.indexOf('description')
        if (description >= 0 && !cells[description]?.trim())
          report('SDD_DESCRIPTION_EMPTY', line, 'description must be non-empty')
        const identifier = tableHeader.columns.findIndex((column) =>
          ['id', 'identifier', '编号'].includes(column)
        )
        const candidate = identifier >= 0 ? cells[identifier]?.trim() : undefined
        if (candidate && ID.test(candidate)) {
          if (definitions.has(candidate))
            report(
              'SDD_ID_DUPLICATE',
              line,
              candidate + ' is already defined at line ' + definitions.get(candidate)
            )
          else definitions.set(candidate, line)
        }
      }
    } else if (tableHeader) {
      tableHeader = undefined
    }
    for (const match of raw.matchAll(ID_TOKEN)) {
      const id = match[0]
      if (ID.test(id)) {
        if (
          !cells &&
          /^\s*(?:[-*]\s*|\d+\.\s*)?\b[A-Z]{2}[0-9]{2,4}\b(?:\s|[|:)])/.test(raw) &&
          !definitions.has(id)
        )
          definitions.set(id, line)
        else (references.get(id) ?? references.set(id, []).get(id)!).push(line)
      } else if (/^[A-Z]{2}[0-9]+$/.test(id)) {
        report('SDD_ID_INVALID', line, `${id} must match ^[A-Z]{2}[0-9]{2,4}$`)
      }
    }
  })
  for (const [id, linesForId] of references) {
    if (!definitions.has(id))
      report('SDD_ID_DANGLING', linesForId[0]!, `${id} is referenced but not defined`)
  }
  return diagnostics
}
