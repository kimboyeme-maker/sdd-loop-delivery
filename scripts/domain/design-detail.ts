import { markdownSections } from '../utils/markdown-sections'
type Item = Record<string, unknown>
const sections: Record<string, string[]> = {
  breaking_changes: [
    'Before',
    'After',
    'Consumers',
    'Migration',
    'Intermediate states',
    'Recovery'
  ],
  api_typing: ['Signatures', 'Inputs and outputs', 'Errors', 'Examples', 'Exports and consumers'],
  entities_tools: ['Changes', 'Owners', 'Lifecycle', 'Dependencies', 'Reuse evidence'],
  implementation_flow: ['Entry points', 'Ordered flow', 'Data and state', 'Step coverage'],
  delivery_verification: [
    'Batches and dependencies',
    'Exit conditions',
    'Acceptance',
    'Executed probes'
  ]
}
const stepFields = [
  'Location',
  'Owner',
  'Inputs and types',
  'Preconditions',
  'Calls',
  'State changes',
  'Failure',
  'Lifecycle and recovery',
  'Observable result'
]
const item = (value: unknown): Item => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('DESIGN_DETAIL_OBJECT_REQUIRED')
  return value as Item
}
/** Reject explicit design stand-ins without guessing quality from text length. */
function meaningful(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  const text = value
    .trim()
    .replace(/^```[^\n]*\n([\s\S]*?)\n```$/, '$1')
    .trim()
  return (
    !/^(?:(?:#|\/\/|\/\*|<!--)\s*)?(?:TODO|TBD|待补充|待实现)(?:\s|[:：—-]|$)/i.test(text) &&
    !['todo', 'tbd', '', '待补充', '待实现', '实现适配', '处理异常', '调用新接口'].includes(
      text.replace(/^[`.*;。 ]+|[`.*;。 ]+$/g, '').toLowerCase()
    )
  )
}
/** Read explicit field labels (ASCII or full-width colon) while preserving fenced code as their original value. */
function fields(body: string): Record<string, string> {
  const result: Record<string, string> = {}
  let key: string | undefined, fence: string | undefined
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) {
      if (!fence) fence = marker[1]!
      else if (
        marker[1]![0] === fence[0] &&
        marker[1]!.length >= fence.length &&
        !line.slice(marker[0].length).trim()
      )
        fence = undefined
      if (key) result[key] += '\n' + line
      continue
    }
    if (!fence && /^#{1,6}\s/.test(line)) break
    const match = !fence && /^\*\*([^*：]+?)[:：]\*\*\s*(.*)$/.exec(line)
    if (match) {
      key = match[1]!
      if (Object.hasOwn(result, key)) throw Error('DESIGN_DETAIL_DUPLICATE_FIELD:' + key)
      result[key] = match[2]!
      fence = /^(`{3,}|~{3,})/.exec(match[2]!)?.[1]
    } else if (key) result[key] += '\n' + line
  }
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.trim()]))
}
/** Resolve versioned design sections and step code from authoritative source text only. */
export function resolveDesignDetail(
  contract: Item,
  sources: Readonly<Record<string, string>>
): Item {
  if (contract.design_detail === undefined) return contract
  const detail = item(contract.design_detail),
    located = item(detail.sections)
  if (
    detail.protocol !== 'design-detail/v1' ||
    Object.keys(detail).sort().join() !== 'protocol,sections' ||
    Object.keys(located).sort().join() !== Object.keys(sections).sort().join()
  )
    throw Error('DESIGN_DETAIL_PROTOCOL_INVALID')
  const sourceBody = (raw: unknown) => {
    const source = item(raw)
    if (
      Object.keys(source).sort().join() !== 'document,heading' ||
      typeof source.document !== 'string' ||
      typeof source.heading !== 'string' ||
      !Object.hasOwn(sources, source.document)
    )
      throw Error('DESIGN_DETAIL_SOURCE_INVALID')
    const text = sources[source.document]!.replace(
      /^(\*\*[^*]+[:：]\*\*)[ \t]+(?=`{3,}|~{3,})/gm,
      '$1\n'
    )
    const all = markdownSections(text),
      matches = all.filter((section) => section.heading === source.heading)
    if (matches.length !== 1) throw Error('DESIGN_DETAIL_HEADING_AMBIGUOUS:' + source.heading)
    const section = matches[0]!,
      next = all.find(
        (entry) => entry.startLine > section.startLine && entry.level <= section.level
      )
    return text
      .split(/\r?\n/)
      .slice(section.startLine, next ? next.startLine - 1 : undefined)
      .join('\n')
      .trim()
  }
  const requireFields = (values: Record<string, string>, names: string[]) => {
    for (const name of names)
      if (!meaningful(values[name])) throw Error('DESIGN_DETAIL_FIELD_REQUIRED:' + name)
  }
  const seenSections = new Set<string>()
  for (const [name, names] of Object.entries(sections)) {
    const source = item(located[name]),
      identity = JSON.stringify([source.document, source.heading])
    if (seenSections.has(identity)) throw Error('DESIGN_DETAIL_SECTION_REUSED')
    seenSections.add(identity)
    const values = fields(sourceBody(source))
    if (
      values.Applicability === 'NOT_APPLICABLE' &&
      !['implementation_flow', 'delivery_verification'].includes(name)
    )
      requireFields(values, ['Reason', 'Evidence'])
    else if (values.Applicability === 'APPLICABLE') requireFields(values, names)
    else throw Error('DESIGN_DETAIL_APPLICABILITY_REQUIRED:' + name)
  }
  const result = structuredClone(contract),
    paths = item(result.implementation_logic).paths
  if (!Array.isArray(paths)) throw Error('DESIGN_DETAIL_PATHS_REQUIRED')
  const seenSteps = new Set<string>()
  for (const raw of paths) {
    const path = item(raw)
    if (!Array.isArray(path.steps)) throw Error('DESIGN_DETAIL_STEPS_REQUIRED')
    for (const rawStep of path.steps) {
      const step = item(rawStep),
        source = item(step.source),
        identity = JSON.stringify([source.document, source.heading])
      if (seenSteps.has(identity)) throw Error('DESIGN_DETAIL_STEP_SOURCE_REUSED')
      seenSteps.add(identity)
      const values = fields(sourceBody(source))
      requireFields(values, stepFields)
      let pseudocode: string
      if (values.Kind === 'BEHAVIOR') {
        const blocks = [...(values.Pseudocode ?? '').matchAll(/^```([^\n]+)\n([\s\S]*?)^```\s*$/gm)]
        if (blocks.length !== 1 || !meaningful(blocks[0]![2]))
          throw Error('DESIGN_DETAIL_PSEUDOCODE_REQUIRED')
        pseudocode = blocks[0]![2]!.trim()
      } else if (values.Kind === 'MECHANICAL') {
        requireFields(values, ['Operation'])
        pseudocode = values.Operation!
      } else throw Error('DESIGN_DETAIL_STEP_KIND_INVALID')
      for (const [name, value] of [
        ['pseudocode', pseudocode],
        ['failure', values.Failure!]
      ]) {
        if (Object.hasOwn(step, name!) && step[name!] !== value)
          throw Error('DESIGN_DETAIL_INDEX_DRIFT:' + step.id + '.' + name)
        step[name!] = value
      }
    }
  }
  return result
}
