import { documentPresentation } from './document-presentation'
import { resolveDesignDetail } from './design-detail'
import { assertDeliveryPlan } from './delivery-plan'
import { assertExperienceContract } from './experience-contract'
import { assertArchitecture, assertDeliveryPlatforms } from './platform-architecture'
import { markdownProseLines } from '../utils/markdown-prose'

export type ContractRequirement = Readonly<{
  id: string
  kind: 'must-ship' | 'should' | 'non-goal'
  title: string
  requirement_type?: 'delivery' | 'decision'
  dependencies?: readonly string[]
  acceptance?: readonly string[]
}>
export type Contract = Readonly<
  Record<string, unknown> & { revision: string; requirements: readonly ContractRequirement[] }
>

/** Extract the normative JSON block without substituting a summary or another source. */
export function contractJsonText(text: string): string | null {
  const markers = [...markdownProseLines(text)].flatMap((line) =>
    [...line.text.matchAll(/<!--\s*sdd-contract:(start|end)\s*-->/g)].map((match) => ({
      kind: match[1],
      index: line.offset + match.index!,
      length: match[0].length
    }))
  )
  const starts = markers.filter((marker) => marker.kind === 'start')
  const ends = markers.filter((marker) => marker.kind === 'end')
  if (!starts.length && !ends.length) return null
  if (starts.length !== 1 || ends.length !== 1) throw new Error('CONTRACT_BLOCK_COUNT')
  const content = text.slice(starts[0]!.index + starts[0]!.length, ends[0]!.index)
  const fence = /^\s*```json\s*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(content)
  if (!fence) throw new Error('CONTRACT_JSON_INVALID')
  return fence[1]!
}

/** Parse the normative contract block without inferring absent fields from prose. */
export function readContractText(
  text: string,
  sources: Readonly<Record<string, string>> = { self: text }
): Contract | null {
  const json = contractJsonText(text)
  if (json === null) return null
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new Error('CONTRACT_JSON_INVALID')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('CONTRACT_JSON_INVALID')
  const contract = value as Record<string, unknown>
  if (contract.protocol !== 'sdd-loop-delivery/v1') throw new Error('CONTRACT_PROTOCOL_UNSUPPORTED')
  if (typeof contract.revision !== 'string' || !contract.revision.trim())
    throw new Error('CONTRACT_REVISION_REQUIRED')
  if (!Array.isArray(contract.requirements) || !contract.requirements.length)
    throw new Error('CONTRACT_REQUIREMENTS_REQUIRED')
  const ids = new Set<string>()
  for (const value of contract.requirements) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('CONTRACT_REQUIREMENT_INVALID')
    const req = value as Record<string, unknown>
    if (
      typeof req.id !== 'string' ||
      !req.id.trim() ||
      typeof req.title !== 'string' ||
      !req.title.trim() ||
      !['must-ship', 'should', 'non-goal'].includes(String(req.kind))
    )
      throw new Error('CONTRACT_REQUIREMENT_INVALID')
    if (ids.has(req.id)) throw new Error('CONTRACT_REQUIREMENT_DUPLICATE')
    if (
      req.requirement_type !== undefined &&
      !['delivery', 'decision'].includes(String(req.requirement_type))
    )
      throw new Error('CONTRACT_REQUIREMENT_TYPE_INVALID')
    ids.add(req.id)
  }
  const requirements = contract.requirements as ContractRequirement[]
  // A contract may omit the acceptance inventory; an explicit inventory must resolve every
  // reference. Never treat a malformed inventory as "not supplied".
  let acceptanceIds: Set<string> | undefined
  if (Object.hasOwn(contract, 'acceptance')) {
    if (!Array.isArray(contract.acceptance)) throw new Error('CONTRACT_ACCEPTANCE_INVALID')
    acceptanceIds = new Set()
    for (const item of contract.acceptance) {
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        typeof item.id !== 'string' ||
        !item.id.trim()
      )
        throw new Error('CONTRACT_ACCEPTANCE_INVALID')
      if (acceptanceIds.has(item.id)) throw new Error('CONTRACT_ACCEPTANCE_DUPLICATE')
      acceptanceIds.add(item.id)
    }
  }
  const remaining = new Map<string, number>()
  const consumers = new Map<string, string[]>()
  for (const req of requirements) {
    if (Object.hasOwn(req, 'acceptance')) {
      const references = req.acceptance
      if (
        !Array.isArray(references) ||
        references.some((id) => typeof id !== 'string' || !id.trim()) ||
        new Set(references).size !== references.length
      )
        throw new Error('CONTRACT_ACCEPTANCE_REFERENCE_INVALID')
      if (acceptanceIds && references.some((id) => !acceptanceIds.has(id)))
        throw new Error('CONTRACT_ACCEPTANCE_REFERENCE_UNRESOLVED')
    }
    const dependencies = req.dependencies ?? []
    if (
      !Array.isArray(dependencies) ||
      dependencies.some((id) => typeof id !== 'string' || !ids.has(id)) ||
      new Set(dependencies).size !== dependencies.length
    )
      throw new Error('CONTRACT_DEPENDENCY_INVALID')
    remaining.set(req.id, dependencies.length)
    for (const id of dependencies) consumers.set(id, [...(consumers.get(id) ?? []), req.id])
  }
  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id)
  for (let index = 0; index < ready.length; index++)
    for (const id of consumers.get(ready[index]!) ?? []) {
      const count = remaining.get(id)! - 1
      remaining.set(id, count)
      if (count === 0) ready.push(id)
    }
  if (ready.length !== requirements.length) throw new Error('CONTRACT_DEPENDENCY_CYCLE')
  documentPresentation(contract, sources)
  assertDeliveryPlan(contract)
  assertDeliveryPlatforms(contract)
  assertExperienceContract(contract)
  assertArchitecture(contract)
  return resolveDesignDetail(contract, sources) as Contract
}
