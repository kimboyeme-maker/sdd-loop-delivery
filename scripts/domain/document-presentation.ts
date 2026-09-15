import { SDD_DEFAULT_ID_PREFIXES, SDD_DOCUMENT_ID_PATTERN } from '../config/constants'
import {
  documentTables,
  plainCell,
  cellReferences,
  type DocumentTable
} from '../utils/document-tables'
import { isDeepStrictEqual } from 'node:util'
type Item = Record<string, unknown>
const object = (value: unknown): Item =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {}
const array = (value: unknown): Item[] => (Array.isArray(value) ? (value as Item[]) : [])
const executable = new Set(['batch', 'closure', 'gate', 'requirement', 'acceptance', 'decision'])

/** Enumerate definition sites, excluding external symbols and runtime identities. */
function contractIds(contract: Item): [unknown, string][] {
  const groups: [Item[], string][] = [
    [array(contract.requirements), 'requirement'],
    [array(contract.acceptance), 'acceptance'],
    [array(object(contract.design_convergence).review_passes), 'design_review'],
    [array(object(contract.migration).legacy_surfaces), 'legacy_surface'],
    [array(object(contract.migration).readers), 'reader']
  ]
  for (const path of array(object(contract.implementation_logic).paths))
    groups.push([[path], 'implementation_path'], [array(path.steps), 'implementation_step'])
  for (const entry of array(contract.acceptance))
    if (Object.keys(object(entry.claim)).length) groups.push([[object(entry.claim)], 'claim'])
  return groups.flatMap(([values, kind]) =>
    values.map(
      (value) =>
        [
          value.id,
          kind === 'requirement' && value.requirement_type === 'decision' ? 'decision' : kind
        ] as [unknown, string]
    )
  )
}

/** Derive descriptions and links from normative tables. The index cannot store status,
 * add obligations, or introduce a second dependency graph. Missing policy preserves
 * existing documents; opting into the policy requires the complete checked index.
 */
export function documentPresentation(
  contract: Item,
  sources: Record<string, string>,
  required = false
): Item | null {
  if (contract.document_policy != null && contract.document_policy !== 'sdd-document/v1')
    throw Error('SDD_DOCUMENT_POLICY_UNSUPPORTED')
  const strict = contract.document_policy === 'sdd-document/v1'
  if (required && !strict) throw Error('SDD_DOCUMENT_POLICY_REQUIRED')
  if (contract.presentation == null) {
    if (required || strict) throw Error('SDD_PRESENTATION_REQUIRED')
    return null
  }
  const presentation = object(contract.presentation)
  if (
    presentation.protocol !== 'sdd-presentation/v1' ||
    Object.keys(presentation).some(
      (key) => !['protocol', 'prefixes', 'retired_ids', 'items'].includes(key)
    )
  )
    throw Error('SDD_PRESENTATION_SCHEMA_INVALID')
  const prefixes = { ...SDD_DEFAULT_ID_PREFIXES }
  if (
    presentation.prefixes !== undefined &&
    (!presentation.prefixes ||
      Array.isArray(presentation.prefixes) ||
      typeof presentation.prefixes !== 'object')
  )
    throw Error('SDD_PREFIXES_INVALID')
  for (const [prefix, kind] of Object.entries(object(presentation.prefixes))) {
    if (
      !/^[A-Z]{2}$/.test(prefix) ||
      typeof kind !== 'string' ||
      !kind.trim() ||
      (prefixes[prefix] && prefixes[prefix] !== kind)
    )
      throw Error('SDD_PREFIX_CONFLICT:' + prefix)
    prefixes[prefix] = kind
  }
  const pattern = new RegExp(SDD_DOCUMENT_ID_PATTERN)
  const id = (value: unknown, kind?: string): string => {
    if (typeof value !== 'string' || !value.trim()) throw Error('SDD_ID_REQUIRED')
    if (!strict && !pattern.test(value)) return value
    if (
      !pattern.test(value) ||
      !prefixes[value.slice(0, 2)] ||
      (kind !== undefined && prefixes[value.slice(0, 2)] !== kind)
    )
      throw Error('SDD_ID_OR_PREFIX_INVALID:' + value)
    return value
  }
  const retired = presentation.retired_ids ?? []
  if (
    !Array.isArray(retired) ||
    retired.some((value) => typeof value !== 'string') ||
    new Set(retired).size !== retired.length
  )
    throw Error('SDD_RETIRED_IDS_INVALID')
  retired.forEach((value) => id(value))
  const definitions = new Map<string, string>()
  for (const [value, kind] of contractIds(contract)) {
    const key = id(value, kind)
    if (definitions.has(key)) throw Error('SDD_CONTRACT_ID_DUPLICATE:' + key)
    definitions.set(key, kind)
  }
  if (!Array.isArray(presentation.items)) throw Error('SDD_PRESENTATION_ITEMS_REQUIRED')
  const legacyKinds = new Map(array(presentation.items).map((item) => [item.id, item.kind]))
  const tables = Object.entries(sources).flatMap(([document, text]) =>
    documentTables(text, document)
  )
  const rows = new Map<string, { table: DocumentTable; row: DocumentTable['rows'][number] }>()
  for (const table of tables) {
    if (!table.headers.includes('description'))
      throw Error(`${table.document}:${table.line}: SDD_TABLE_DESCRIPTION_MISSING`)
    for (const row of table.rows) {
      const description = plainCell(row.values.description!),
        key = plainCell(row.values.id ?? '')
      if (
        !description ||
        description === key ||
        ['完成该项', '完成此项', 'TODO', 'TBD', '—', '-'].includes(description)
      )
        throw Error(`${table.document}:${row.line}: SDD_DESCRIPTION_MEANINGLESS`)
      if (!key) continue
      id(key)
      if (rows.has(key)) throw Error(`${table.document}:${row.line}: SDD_TABLE_ID_DUPLICATE:${key}`)
      rows.set(key, { table, row })
      if (!definitions.has(key))
        definitions.set(key, prefixes[key.slice(0, 2)] ?? String(legacyKinds.get(key) ?? ''))
    }
  }
  if (retired.some((value) => definitions.has(value))) throw Error('SDD_RETIRED_ID_REUSED')
  for (const table of tables) {
    const token = table.heading.split(' ')[0]!.replace(/^[\x60[]+|[\x60\]]+$/g, '')
    if (/^[A-Z]{2}[-_]?[0-9]+$/.test(token)) {
      id(token)
      if (!definitions.has(token)) definitions.set(token, prefixes[token.slice(0, 2)] ?? '')
    }
  }
  for (const table of tables)
    for (const row of table.rows)
      for (const column of ['requirement_ids', 'acceptance_ids', 'batch_ids', 'refs']) {
        for (const ref of cellReferences(row.values[column] ?? '')) {
          if (!definitions.has(ref))
            throw Error(`${table.document}:${row.line}: SDD_REFERENCE_DANGLING:${ref}`)
          const expected: Record<string, string[]> = {
            requirement_ids: ['requirement', 'decision'],
            acceptance_ids: ['acceptance'],
            batch_ids: ['batch']
          }
          if (expected[column] && !expected[column]!.includes(definitions.get(ref)!))
            throw Error(`${table.document}:${row.line}: SDD_REFERENCE_KIND_INVALID:${ref}`)
        }
      }
  const indexed = new Set<string>()
  const reqs = new Set(array(contract.requirements).map((item) => item.id)),
    acs = new Set(array(contract.acceptance).map((item) => item.id))
  const derived: Item[] = []
  for (const raw of presentation.items) {
    const item = object(raw),
      kind = item.kind
    if (
      !Object.keys(item).length ||
      Object.keys(item).some((key) => !['id', 'kind', 'source', 'description'].includes(key)) ||
      typeof kind !== 'string' ||
      !Object.values(prefixes).includes(kind)
    )
      throw Error('SDD_PRESENTATION_ITEM_INVALID')
    const key = id(item.id, kind),
      found = rows.get(key)
    if (indexed.has(key) || !found) throw Error('SDD_PRESENTATION_ROW_MISSING_OR_DUPLICATE:' + key)
    indexed.add(key)
    const { table, row } = found,
      source = { document: table.document, heading: table.heading, table: table.table }
    if (
      table.ambiguous_heading ||
      !isDeepStrictEqual(item.source ?? null, source) ||
      definitions.get(key) !== kind
    )
      throw Error('SDD_PRESENTATION_SOURCE_DRIFT:' + key)
    const description = plainCell(row.values.description!)
    if (item.description !== undefined && item.description !== description)
      throw Error('SDD_PRESENTATION_DESCRIPTION_DRIFT:' + key)
    const runs = executable.has(kind)
    if (
      runs &&
      (!Object.hasOwn(row.values, 'requirement_ids') ||
        !Object.hasOwn(row.values, 'acceptance_ids'))
    )
      throw Error('SDD_PRESENTATION_LINK_COLUMNS_REQUIRED:' + key)
    const gate = plainCell(row.values.gate ?? '')
    if (!['', '—', '-', 'SHIP'].includes(gate)) throw Error('SDD_PRESENTATION_GATE_INVALID:' + key)
    const requirement_ids = cellReferences(row.values.requirement_ids ?? ''),
      acceptance_ids = cellReferences(row.values.acceptance_ids ?? ''),
      batch_ids = cellReferences(row.values.batch_ids ?? '')
    if (
      requirement_ids.some((ref) => !reqs.has(ref)) ||
      acceptance_ids.some((ref) => !acs.has(ref))
    )
      throw Error('SDD_PRESENTATION_SCOPE_EXPANSION:' + key)
    if (kind === 'batch' && batch_ids.length) throw Error('SDD_PRESENTATION_SECOND_GRAPH_FORBIDDEN')
    derived.push({
      id: key,
      kind,
      description,
      source: { ...source, line: row.line },
      requirement_ids,
      acceptance_ids,
      batch_ids,
      gate: gate === 'SHIP' ? 'SHIP' : null,
      executable: runs
    })
  }
  for (const [key, kind] of definitions)
    if (['batch', 'closure', 'gate'].includes(kind) && !indexed.has(key))
      throw Error('SDD_PRESENTATION_OBJECT_UNINDEXED:' + key)
  for (const item of derived)
    for (const batchId of item.batch_ids as string[]) {
      const batch = derived.find((value) => value.id === batchId && value.kind === 'batch')
      if (
        !batch ||
        ['requirement_ids', 'acceptance_ids'].some((key) =>
          (item[key] as string[]).some((ref) => !(batch[key] as string[]).includes(ref))
        )
      )
        throw Error('SDD_PRESENTATION_BATCH_SCOPE_INVALID:' + item.id)
    }
  // The final SHIP gate cannot release while any Must-Ship acceptance is outside every SHIP row.
  const shipRows = derived.filter((item) => item.gate === 'SHIP')
  if (shipRows.length) {
    const covered = new Set(shipRows.flatMap((item) => item.acceptance_ids as string[]))
    const missing = array(contract.requirements)
      .filter((req) => req.kind === 'must-ship')
      .flatMap((req) => (Array.isArray(req.acceptance) ? (req.acceptance as string[]) : []))
      .filter((id) => !covered.has(id))
    if (missing.length)
      throw Error('SDD_PRESENTATION_SHIP_COVERAGE_INCOMPLETE:' + missing.join(','))
  }
  return {
    protocol: presentation.protocol,
    prefixes,
    ids: [...new Set([...definitions.keys(), ...retired])].sort(),
    items: derived
  }
}
