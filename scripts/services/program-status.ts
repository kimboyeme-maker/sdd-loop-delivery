import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { packagesOverlap } from '../domain/delivery-plan'
import { creditLedger } from '../helpers/credit-ledger'
import { readSnapshot, sidecarPaths } from '../resource/state'

type Item = Record<string, unknown>
const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim())
const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)

/**
 * Read-only aggregate over a program plan (`*.program.md`): one row per SDD with `ID`, `role`,
 * `sdd`, `write_set` and `depends_on` columns. It reports each controller's public state, the
 * children ready to start, and write-set conflicts between SDDs without a dependency path.
 * It never writes a sidecar and is not an orchestrator: each SDD keeps its own Coordinator.
 */
export function programStatus(program: string): Item {
  if (!isAbsolute(program) || !existsSync(program)) throw new Error('PROGRAM_PLAN_NOT_FOUND')
  const lines = readFileSync(program, 'utf8').split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => {
    const header = cells(line).map((cell) => cell.toLowerCase())
    return line.trim().startsWith('|') && header.includes('id') && header.includes('sdd')
  })
  if (headerIndex < 0) throw new Error('PROGRAM_PLAN_TABLE_REQUIRED')
  const header = cells(lines[headerIndex]!).map((cell) => cell.toLowerCase())
  const column = (name: string) => header.indexOf(name)
  const rows: Item[] = []
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith('|')) break
    const values = cells(line)
    const id = values[column('id')]
    const sdd = values[column('sdd')]
    if (!id || !sdd) throw new Error('PROGRAM_PLAN_ROW_INVALID')
    rows.push({
      id,
      role: values[column('role')] ?? '',
      sdd: resolve(dirname(program), sdd),
      write_set: list(values[column('write_set')]),
      depends_on: list(values[column('depends_on')])
    })
  }
  const ids = new Set(rows.map((row) => String(row.id)))
  if (ids.size !== rows.length) throw new Error('PROGRAM_PLAN_ID_DUPLICATE')
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  for (const row of rows)
    if ((row.depends_on as string[]).some((id) => !ids.has(id)))
      throw new Error('PROGRAM_PLAN_DEPENDENCY_UNKNOWN')
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const dependency of byId.get(id)!.depends_on as string[])
      if (!seen.has(dependency)) {
        seen.add(dependency)
        ancestors(dependency, seen)
      }
    return seen
  }
  const sdds = rows.map((row) => {
    const path = String(row.sdd)
    if (!existsSync(sidecarPaths(path).state))
      return { id: row.id, role: row.role, sdd: path, status: 'NOT_STARTED' }
    try {
      const snapshot = readSnapshot(path)
      const state = snapshot.state as Item
      const lease = state.active_lease as Item | null | undefined
      return {
        id: row.id,
        role: row.role,
        sdd: path,
        status: 'STARTED',
        phase: state.phase,
        contract_revision: state.contract_revision ?? null,
        active_role: lease?.role ?? null,
        waiting_user: !!state.pending_user_decision,
        credit: creditLedger(state),
        updated_at: state.updated_at ?? null
      }
    } catch (error) {
      return {
        id: row.id,
        role: row.role,
        sdd: path,
        status: 'UNREADABLE',
        reason: error instanceof Error ? error.message : 'unknown'
      }
    }
  })
  const phaseOf = new Map(sdds.map((entry) => [String(entry.id), (entry as Item).phase]))
  const conflicts: string[] = []
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const a = String(rows[i]!.id),
        b = String(rows[j]!.id)
      if (ancestors(a).has(b) || ancestors(b).has(a)) continue
      if (
        (rows[i]!.write_set as string[]).some((left) =>
          (rows[j]!.write_set as string[]).some((right) => packagesOverlap(left, right))
        )
      )
        conflicts.push(`${a}/${b}`)
    }
  return {
    protocol: 'program-status/v1',
    program,
    sdds,
    ready_to_start: sdds
      .filter(
        (entry) =>
          entry.status === 'NOT_STARTED' &&
          (byId.get(String(entry.id))!.depends_on as string[]).every(
            (dependency) => phaseOf.get(dependency) === 'SHIP'
          )
      )
      .map((entry) => entry.id),
    write_set_conflicts: conflicts,
    note: 'Aggregate projection only; each SDD keeps its own Coordinator, worktree and authority.'
  }
}
