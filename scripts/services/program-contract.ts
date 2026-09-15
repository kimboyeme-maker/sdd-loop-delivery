import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { readContractBundle } from './contract-document'
import { workspacePath } from '../utils/workspace-path'

/** Typed projection; leaf validation remains the authority for the full contract. */
type LeafItem = {
  id: string
  kind: string
  acceptance?: string[]
  acceptance_ids: string[]
  requirement_ids: string[]
  modification_packages: string[]
  depends_on?: string[]
}
type LeafContract = {
  requirements: LeafItem[]
  acceptance: LeafItem[]
  delivery_plan: { batches: LeafItem[] }
}

/** Program metadata is a projection of leaf contracts, never a second product ledger. */
export type Estimate = {
  design: [number, number]
  implementation: [number, number]
  integration: [number, number]
  verification: [number, number]
  conditional_verification: [number, number]
  basis: string
  waiting: string
}
export type ProgramNode = {
  id: string
  parent: string | null
  kind: 'group' | 'execution'
  sdd: string
  estimate: Estimate
}
export type ProgramMeta = {
  id: string
  kind: 'Entry' | 'Module' | 'Chunk' | 'Bundle' | 'Asset'
  owner: string
  members: string[]
  requires: string[]
  source_id?: string
  path?: string
  reads?: string[]
  /** Original requirement identity; omitted legacy origins resolve to the owning leaf. */
  origin?: { document: string; requirement_id: string }
  /** Existing batch allowed to integrate missing predecessor commits before consumer work. */
  integration_batch_id?: string
  validators: {
    definition: 'program-structure/v1'
    implementation: {
      owner: string
      acceptance_ids: string[]
      method: string
      pass_condition: string
    }
  }
}
export type Program = {
  protocol: 'sdd-program/v1'
  id: string
  revision: string
  nodes: ProgramNode[]
  metas: ProgramMeta[]
  execution: {
    max_parallel: number
    total_test_seconds: number
    base_ref: string
    allocations: Record<string, number>
  }
}
export type ProgramDocument = {
  path: string
  program: Program
  fingerprint: string
  files: Record<string, string>
  contracts: Record<string, LeafContract>
  bundles: ProgramMeta[]
  dependencies: Record<string, string[]>
  total_minutes: [number, number]
  waves: string[][]
  scheduled_minutes: [number, number]
}
const fail = (code: string, at: string): never => {
  throw new Error(`${code}: ${at}`)
}
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const list = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(text) && new Set(v).size === v.length
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
export const programHash = (v: string | Uint8Array): string =>
  createHash('sha256').update(v).digest('hex')

/** The dispatched leaf freezes its contract, owner metadata and incoming edges. */
export function programDefinitionHash(d: ProgramDocument, id: string): string {
  const b = d.bundles.find((m) => m.id === id)
  if (!b) throw new Error('PROGRAM_DISPATCHED_BUNDLE_REMOVED')
  return programHash(
    JSON.stringify({
      contract: d.contracts[b.owner],
      node: d.files[b.owner],
      metas: d.program.metas.filter((m) => m.owner === b.owner),
      dependencies: d.dependencies[id]
    })
  )
}

/** Paths are local references; a source outside the owning program directory is not loaded. */
export function programPath(root: string, path: string): string {
  if (!text(path) || isAbsolute(path)) return fail('PROGRAM_PATH_INVALID', String(path))
  const result = realpathSync(resolve(root, path))
  const rel = relative(realpathSync(root), result)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return fail('PROGRAM_PATH_ESCAPE', path)
  return result
}

/** Read only JSON contracts; never evaluate a document's declared verification command. */
function jsonBlock(source: string, marker: string): Record<string, unknown> {
  const matches = [
    ...source.matchAll(
      new RegExp(
        `<!-- ${marker}:start -->\\s*\x60\x60\x60json\\s*([\\s\\S]*?)\x60\x60\x60\\s*<!-- ${marker}:end -->`,
        'g'
      )
    )
  ]
  if (matches.length !== 1) return fail('PROGRAM_BLOCK_REQUIRED', marker)
  const value: unknown = JSON.parse(matches[0]![1]!)
  if (!object(value)) return fail('PROGRAM_OBJECT_REQUIRED', marker)
  return value
}

/** Validate the supported static relationships and derive a bounded-resource schedule. */
export function readProgram(path: string): ProgramDocument {
  const absolute = realpathSync(path),
    root = dirname(absolute)
  const source = readFileSync(absolute, 'utf8')
  const p = jsonBlock(source, 'sdd-program') as Program
  if (
    p.protocol !== 'sdd-program/v1' ||
    !text(p.id) ||
    !text(p.revision) ||
    !Array.isArray(p.nodes) ||
    !p.nodes.length ||
    !Array.isArray(p.metas) ||
    !p.metas.length
  )
    return fail('PROGRAM_SHAPE_INVALID', absolute)
  const nodes = new Map<string, ProgramNode>(),
    metas = new Map<string, ProgramMeta>()
  const files: Record<string, string> = {},
    contracts: Record<string, LeafContract> = {}
  const hashes: string[] = [programHash(source)]
  const totals: [number, number] = [0, 0]
  for (const n of p.nodes) {
    if (
      !object(n) ||
      !text(n.id) ||
      nodes.has(n.id) ||
      !['group', 'execution'].includes(n.kind) ||
      !(n.parent === null || text(n.parent))
    )
      return fail('PROGRAM_NODE_INVALID', String(n?.id))
    const file = programPath(root, n.sdd)
    if (Object.values(files).includes(file)) return fail('PROGRAM_SDD_DUPLICATE', n.id)
    files[n.id] = file
    nodes.set(n.id, n)
    const bytes = readFileSync(file, 'utf8')
    hashes.push(programHash(bytes))
    if (n.kind === 'execution') {
      const bundle = readContractBundle(file, bytes)
      if (!bundle.contract) return fail('PROGRAM_CONTRACT_INCOMPLETE', n.id)
      contracts[n.id] = bundle.contract as unknown as LeafContract
      for (const [name, content] of Object.entries(bundle.sources).sort())
        hashes.push(programHash(`${file}/${name}\n${content}`))
    }
    const e = n.estimate
    if (!object(e) || !text(e.basis) || !text(e.waiting))
      return fail('PROGRAM_ESTIMATE_REQUIRED', n.id)
    for (const key of [
      'design',
      'implementation',
      'integration',
      'verification',
      'conditional_verification'
    ] as const) {
      const r = e[key]
      if (
        !Array.isArray(r) ||
        r.length !== 2 ||
        r.some((v) => !Number.isFinite(v) || v < 0) ||
        r[0] > r[1]
      )
        return fail('PROGRAM_ESTIMATE_INVALID', `${n.id}.${key}`)
      if (key !== 'conditional_verification') {
        totals[0] += r[0]
        totals[1] += r[1]
      }
    }
    if (n.kind === 'group' && (e.implementation[1] || e.integration[1] || e.verification[1]))
      return fail('PROGRAM_GROUP_EXECUTION_FORBIDDEN', n.id)
  }
  const roots = p.nodes.filter((n) => n.parent === null)
  if (roots.length !== 1 || files[roots[0]!.id] !== absolute)
    return fail('PROGRAM_ROOT_INVALID', absolute)
  for (const n of p.nodes) {
    const seen = new Set<string>()
    let next: ProgramNode | undefined = n
    while (next) {
      if (seen.has(next.id)) return fail('PROGRAM_PARENT_CYCLE', n.id)
      seen.add(next.id)
      if (seen.size > 3) return fail('PROGRAM_DEPTH_EXCEEDED', n.id)
      if (next.parent === null) break
      const parent = nodes.get(next.parent)
      if (!parent || parent.kind !== 'group') return fail('PROGRAM_PARENT_INVALID', n.id)
      next = parent
    }
    if (n.kind === 'group' && !p.nodes.some((child) => child.parent === n.id))
      return fail('PROGRAM_EMPTY_GROUP', n.id)
  }
  for (const m of p.metas) {
    if (
      !object(m) ||
      !text(m.id) ||
      metas.has(m.id) ||
      !nodes.has(m.owner) ||
      !['Entry', 'Module', 'Chunk', 'Bundle', 'Asset'].includes(m.kind) ||
      !list(m.members) ||
      !list(m.requires)
    )
      return fail('PROGRAM_META_INVALID', String(m?.id))
    metas.set(m.id, m)
    const v = m.validators
    if (
      !object(v) ||
      v.definition !== 'program-structure/v1' ||
      !object(v.implementation) ||
      !nodes.has(v.implementation.owner) ||
      !list(v.implementation.acceptance_ids) ||
      !text(v.implementation.method) ||
      !text(v.implementation.pass_condition)
    )
      return fail('PROGRAM_VALIDATOR_REQUIRED', m.id)
    const acceptance = contracts[v.implementation.owner]?.acceptance ?? []
    if (v.implementation.acceptance_ids.some((id) => !acceptance.some((a) => a.id === id)))
      return fail('PROGRAM_ACCEPTANCE_UNKNOWN', m.id)
    if (m.kind !== 'Entry' && !v.implementation.acceptance_ids.length)
      return fail('PROGRAM_ACCEPTANCE_REQUIRED', m.id)
  }
  const bundles = p.metas.filter((m) => m.kind === 'Bundle')
  if (!bundles.length || !p.metas.some((m) => m.kind === 'Entry'))
    return fail('PROGRAM_ENTRY_BUNDLE_REQUIRED', p.id)
  const belong = new Map<string, string>()
  const origins = new Set<string>()
  const expected = { Entry: 'Module', Module: null, Chunk: 'Module', Bundle: 'Chunk', Asset: null }
  for (const m of p.metas) {
    for (const id of m.members) {
      const child = metas.get(id)
      if (!child || child.kind !== expected[m.kind])
        return fail('PROGRAM_MEMBER_INVALID', `${m.id}/${id}`)
      if (m.kind !== 'Entry') {
        if (child.owner !== m.owner || (m.kind !== 'Chunk' && belong.has(id)))
          return fail('PROGRAM_OWNERSHIP_DUPLICATE', id)
        belong.set(id, m.id)
      }
    }
    if (m.requires.some((id) => metas.get(id)?.kind !== 'Asset'))
      return fail('PROGRAM_ASSET_UNKNOWN', m.id)
    if (m.kind !== 'Bundle' && m.requires.length)
      return fail('PROGRAM_DEPENDENCY_ON_BUNDLE_REQUIRED', m.id)
    if (['Entry', 'Chunk', 'Bundle'].includes(m.kind) && !m.members.length)
      return fail('PROGRAM_EMPTY_META', m.id)
    if (m.kind === 'Bundle' && nodes.get(m.owner)?.kind !== 'execution')
      return fail('PROGRAM_BUNDLE_OWNER_INVALID', m.id)
    if (m.kind === 'Bundle' && !list(m.reads)) return fail('PROGRAM_READ_SET_REQUIRED', m.id)
    if (m.kind === 'Entry') {
      const descendants = (owner: string): boolean => {
        let node = nodes.get(owner)
        while (node) {
          if (node.id === m.owner) return true
          node = node.parent === null ? undefined : nodes.get(node.parent)
        }
        return false
      }
      if (
        m.members.some((id) => !descendants(metas.get(id)!.owner)) ||
        !descendants(m.validators.implementation.owner)
      )
        return fail('PROGRAM_ENTRY_OWNER_INVALID', m.id)
    }
    if (['Module', 'Chunk'].includes(m.kind)) {
      const items =
        m.kind === 'Module'
          ? contracts[m.owner]?.requirements
          : contracts[m.owner]?.delivery_plan?.batches
      if (!text(m.source_id) || !Array.isArray(items) || !items.some((i) => i.id === m.source_id))
        return fail('PROGRAM_SOURCE_UNKNOWN', m.id)
      const sourceId = m.source_id
      const item = items.find((i) => i.id === sourceId)!
      const allowed =
        m.kind === 'Module'
          ? (contracts[m.owner]?.acceptance ?? [])
              .filter(
                (a) => a.requirement_ids?.includes(sourceId) && item.acceptance?.includes(a.id)
              )
              .map((a) => a.id)
          : item.acceptance_ids
      if (
        m.validators.implementation.owner !== m.owner ||
        !Array.isArray(allowed) ||
        m.validators.implementation.acceptance_ids.some((id) => !allowed.includes(id))
      )
        return fail('PROGRAM_VALIDATOR_SCOPE_INVALID', m.id)
      if (m.kind === 'Module') {
        if (!m.origin && bundles.length > 1) return fail('PROGRAM_ORIGIN_REQUIRED', m.id)
        let originFile = files[m.owner]!,
          originId = sourceId
        if (m.origin !== undefined) {
          if (!object(m.origin) || !text(m.origin.document) || !text(m.origin.requirement_id))
            return fail('PROGRAM_ORIGIN_INVALID', m.id)
          originFile = programPath(root, m.origin.document)
          originId = m.origin.requirement_id
          const original = readContractBundle(originFile)
          if (!original.contract?.requirements.some((r) => r.id === originId))
            return fail('PROGRAM_ORIGIN_UNKNOWN', m.id)
          hashes.push(programHash(JSON.stringify(original.sources)))
        }
        const identity = JSON.stringify([originFile, originId])
        if (origins.has(identity)) return fail('PROGRAM_ORIGIN_DUPLICATE', m.id)
        origins.add(identity)
      }
    }
    if (
      m.kind === 'Asset' &&
      (!text(m.path) || isAbsolute(m.path) || m.path.split(/[\\/]/).includes('..'))
    )
      return fail('PROGRAM_ASSET_PATH_INVALID', m.id)
    if (m.kind === 'Asset') m.path = workspacePath(m.path!)
  }
  for (const n of p.nodes.filter((n) => n.kind === 'execution')) {
    if (!p.metas.some((m) => m.kind === 'Asset' && m.owner === n.id))
      return fail('PROGRAM_ASSET_COVERAGE', n.id)
    if (bundles.filter((b) => b.owner === n.id).length !== 1)
      return fail('PROGRAM_BUNDLE_COVERAGE', n.id)
    for (const [kind, items] of [
      ['Module', contracts[n.id]?.requirements?.filter((r) => r.kind !== 'non-goal')],
      ['Chunk', contracts[n.id]?.delivery_plan?.batches]
    ] as const) {
      if (!Array.isArray(items)) return fail('PROGRAM_CONTRACT_INCOMPLETE', n.id)
      for (const item of items) {
        const matches = p.metas.filter(
          (m) => m.kind === kind && m.owner === n.id && m.source_id === item.id
        )
        if (matches.length !== 1 || !belong.has(matches[0]!.id))
          return fail('PROGRAM_SOURCE_COVERAGE', `${n.id}/${item.id}`)
      }
    }
    // The node estimate must be able to hold the leaf's own batch plan; a range below it, or one
    // that would still hold the plan several times over, is an unreconciled second estimate.
    const batchMinutes = contracts[n.id]!.delivery_plan.batches.reduce(
      (sum, b) => sum + (Number((b as { estimated_minutes?: number }).estimated_minutes) || 0),
      0
    )
    const work = (side: 0 | 1) =>
      n.estimate.implementation[side] + n.estimate.integration[side] + n.estimate.verification[side]
    if (batchMinutes && (work(1) < batchMinutes || work(0) > batchMinutes * 3))
      return fail('PROGRAM_ESTIMATE_DIVERGED', `${n.id}: batches ${batchMinutes}`)
    for (const c of p.metas.filter((m) => m.kind === 'Chunk' && m.owner === n.id)) {
      const batch = contracts[n.id]!.delivery_plan.batches.find((b) => b.id === c.source_id)!
      const ids = c.members.map((id) => metas.get(id)!.source_id!)
      if (
        ids.length !== batch.requirement_ids.length ||
        ids.some((id) => !batch.requirement_ids.includes(id))
      )
        return fail('PROGRAM_CHUNK_DIVERGED', c.id)
    }
  }
  const entries = p.metas.filter((m) => m.kind === 'Entry').flatMap((m) => m.members)
  if (p.metas.some((m) => m.kind === 'Module' && !entries.includes(m.id)))
    return fail('PROGRAM_ENTRY_COVERAGE', p.id)
  for (const a of p.metas.filter((m) => m.kind === 'Asset'))
    if (!bundles.some((b) => b.owner === a.owner) || a.validators.implementation.owner !== a.owner)
      return fail('PROGRAM_ASSET_PRODUCER_INVALID', a.id)
  for (const m of p.metas.filter((m) => ['Asset', 'Bundle'].includes(m.kind))) {
    const leaf = contracts[m.owner]!
    if (
      m.validators.implementation.owner !== m.owner ||
      m.validators.implementation.acceptance_ids.some(
        (id) =>
          !leaf.requirements.some(
            (r) =>
              r.kind !== 'non-goal' &&
              r.acceptance?.includes(id) &&
              leaf.acceptance.some((a) => a.id === id && a.requirement_ids?.includes(r.id))
          )
      )
    )
      return fail('PROGRAM_VALIDATOR_SCOPE_INVALID', m.id)
  }
  const dependencies = Object.fromEntries(
    bundles.map((b) => [
      b.id,
      [
        ...new Set(
          b.requires.map(
            (id) =>
              bundles.find((other) => other.owner === metas.get(id)!.owner)?.id ??
              fail('PROGRAM_ASSET_PRODUCER_INVALID', id)
          )
        )
      ]
    ])
  )
  const ancestors = (id: string, stack = new Set<string>()): Set<string> => {
    if (stack.has(id)) return fail('PROGRAM_DEPENDENCY_CYCLE', id)
    const next = new Set(stack).add(id),
      result = new Set<string>()
    for (const d of dependencies[id] ?? []) {
      result.add(d)
      for (const a of ancestors(d, next)) result.add(a)
    }
    return result
  }
  const closure = Object.fromEntries(bundles.map((b) => [b.id, ancestors(b.id)]))
  for (const b of bundles) {
    const batches = contracts[b.owner]!.delivery_plan.batches
    if (dependencies[b.id]!.length > 1 && !b.integration_batch_id)
      return fail('PROGRAM_MULTI_SOURCE_INTEGRATION_REQUIRED', b.id)
    if (b.integration_batch_id !== undefined) {
      const first = batches.find((batch) => batch.id === b.integration_batch_id)
      if (!first || first.depends_on?.length) return fail('PROGRAM_INTEGRATION_BATCH_INVALID', b.id)
      const follows = (id: string): boolean => {
        const batch = batches.find((x) => x.id === id)!
        return (batch.depends_on ?? []).some((parent) => parent === first.id || follows(parent))
      }
      if (batches.some((batch) => batch !== first && !follows(batch.id)))
        return fail('PROGRAM_INTEGRATION_ORDER_INVALID', b.id)
    }
  }
  const writes = (b: ProgramMeta): string[] =>
    (contracts[b.owner]?.delivery_plan?.batches ?? []).flatMap((c) => c.modification_packages ?? [])
  const overlaps = (a: string, b: string): boolean =>
    a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
  for (const a of bundles)
    for (const b of bundles) {
      if (a.id >= b.id || closure[a.id]!.has(b.id) || closure[b.id]!.has(a.id)) continue
      if (
        writes(a).some((x) =>
          [...writes(b), ...b.reads!].some((y) =>
            overlaps(x.replace(/\/$/, ''), y.replace(/\/$/, ''))
          )
        ) ||
        writes(b).some((x) =>
          a.reads!.some((y) => overlaps(x.replace(/\/$/, ''), y.replace(/\/$/, '')))
        )
      )
        return fail('PROGRAM_WRITE_CONFLICT', `${a.id}/${b.id}`)
    }
  const e = p.execution
  if (
    !object(e) ||
    !Number.isSafeInteger(e.max_parallel) ||
    e.max_parallel < 1 ||
    !Number.isSafeInteger(e.total_test_seconds) ||
    e.total_test_seconds < 0 ||
    !text(e.base_ref) ||
    !object(e.allocations)
  )
    return fail('PROGRAM_EXECUTION_INVALID', p.id)
  if (
    Object.keys(e.allocations).length !== bundles.length ||
    bundles.some((b) => !Number.isSafeInteger(e.allocations[b.id]) || e.allocations[b.id]! < 0) ||
    Object.values(e.allocations).reduce((a, b) => a + b, 0) > e.total_test_seconds
  )
    return fail('PROGRAM_ALLOCATION_INVALID', p.id)
  const waves: string[][] = [],
    done = new Set<string>(),
    schedule: [number, number] = [0, 0]
  while (done.size < bundles.length) {
    const wave = bundles
      .filter((b) => !done.has(b.id) && dependencies[b.id]!.every((d) => done.has(d)))
      .slice(0, e.max_parallel)
    if (!wave.length) return fail('PROGRAM_DEPENDENCY_CYCLE', p.id)
    waves.push(wave.map((b) => b.id))
    for (const side of [0, 1] as const)
      schedule[side] += Math.max(
        ...wave.map((b) => {
          const est = nodes.get(b.owner)!.estimate
          return (
            est.design[side] +
            est.implementation[side] +
            est.integration[side] +
            est.verification[side]
          )
        })
      )
    wave.forEach((b) => done.add(b.id))
  }
  for (const n of p.nodes.filter((n) => n.kind === 'group')) {
    schedule[0] += n.estimate.design[0]
    schedule[1] += n.estimate.design[1]
  }
  return {
    path: absolute,
    program: p,
    fingerprint: programHash(hashes.join('\n')),
    files,
    contracts,
    bundles,
    dependencies,
    total_minutes: totals,
    waves,
    scheduled_minutes: schedule
  }
}

/** Public projection excludes source bodies and never asserts runtime readiness. */
export function programCheck(path: string): object {
  const d = readProgram(path)
  return {
    protocol: 'program-check/v1',
    valid: true,
    fingerprint: d.fingerprint,
    total_minutes: d.total_minutes,
    scheduled_minutes: d.scheduled_minutes,
    waves: d.waves,
    max_parallel: d.program.execution.max_parallel,
    execution_task_count: d.bundles.length,
    nodes: d.program.nodes,
    bundles: d.bundles.map((b) => ({
      id: b.id,
      sdd: d.files[b.owner],
      depends_on: d.dependencies[b.id]
    })),
    note: 'Structural checks only. Schedule excludes external waits and conditional verification; no commands executed.'
  }
}
