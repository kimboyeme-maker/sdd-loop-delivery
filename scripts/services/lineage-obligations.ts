import { parseEvents } from '../resource/store/event-log'
import { leaseSlots } from '../helpers/lease-slots'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute, extname } from 'node:path'
import { readSnapshot } from '../resource/state'
import { canonicalJson } from '../resource/wire/canonical-json'
import { readContractDocument } from './contract-document'
import { assertRoleEvidence } from '../helpers/role-evidence'
type Item = Record<string, unknown>
const object = (value: unknown): Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {}
const list = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : [])
const unique = (values: readonly string[]) => [...new Set(values)].sort()
const subset = (a: readonly string[], b: readonly string[]) => a.every((id) => b.includes(id))

/** Stable native ID for a predecessor fact, not a new task or completion condition. */
function obligationId(source: string, event: string, suffix: string): string {
  return `INH-${createHash('sha256').update(canonicalJson({ source, event, suffix })).digest('hex').slice(0, 16)}`
}

/** Derive unresolved product obligations from stable native predecessor snapshots.
 * Public-key role evidence is checked before a later PASS can supersede a failure.
 * Snapshot hashes describe observed bytes; they are not host or user authorization.
 */
export function collectLineageObligations(sdd: string, contract: Item): Item[] {
  const lineage = object(contract.lineage)
  if (lineage.mode === 'fresh') return []
  if (lineage.mode !== 'continuation' || !Array.isArray(lineage.predecessors))
    throw new Error('CONTRACT_LINEAGE_REQUIRED')
  const current = realpathSync(sdd)
  let root = dirname(current),
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
  const seen = new Set<string>(),
    result: Item[] = []
  for (const entry of lineage.predecessors) {
    const raw = object(entry).sdd
    if (typeof raw !== 'string' || !raw || isAbsolute(raw) || extname(raw) !== '.md')
      throw new Error('AGENT_CONTEXT_LINK_INVALID')
    if (!existsSync(resolve(dirname(current), raw)))
      throw new Error('LINEAGE_PREDECESSOR_NOT_FOUND')
    const path = realpathSync(resolve(dirname(current), raw))
    const fromRoot = relative(root, path)
    if (fromRoot === '..' || fromRoot.startsWith('../') || isAbsolute(fromRoot))
      throw new Error('AGENT_CONTEXT_LINK_ESCAPES_ROOT')
    if (path === current) throw new Error('LINEAGE_SELF_REFERENCE_FORBIDDEN')
    if (seen.has(path)) throw new Error('LINEAGE_PREDECESSOR_DUPLICATE')
    seen.add(path)
    const snapshot = readSnapshot(path),
      state = snapshot.state
    if (!['SHIP', 'BLOCKED', 'CANCELLED'].includes(String(state.phase)))
      throw new Error('LINEAGE_PREDECESSOR_NONTERMINAL')
    if (leaseSlots(state as Record<string, unknown>).length > 0)
      throw new Error('LINEAGE_PREDECESSOR_ACTIVE_LEASE')
    const events = parseEvents(snapshot.eventText)
    if (!events.length) throw new Error('LINEAGE_EVENT_LOG_EMPTY')
    const predecessor = readContractDocument(path)
    if (!predecessor) throw new Error('LINEAGE_CONTRACT_REQUIRED')
    const packages = unique(list(object(predecessor.ownership).packages))
    const acceptance = new Map(
      (predecessor.acceptance as Item[]).map((item) => [String(item.id), item])
    )
    const scope = (event: Item, check: Item): { ids: string[]; packages: string[] } => {
      const payload = object(event.payload)
      const ids = list(check.acceptance_ids).length
        ? list(check.acceptance_ids)
        : list(payload.acceptance_ids)
      const acceptedPackages = ids.flatMap((id) => list(acceptance.get(id)?.packages))
      const observed = list(check.packages).length
        ? list(check.packages)
        : acceptedPackages.length
          ? acceptedPackages
          : list(payload.changed_packages).length
            ? list(payload.changed_packages)
            : packages
      return { ids: unique(ids), packages: unique(observed) }
    }
    const roleEvents = (role: string, type: string) =>
      events.filter((event) => {
        if (event.role !== role || event.type !== type) return false
        // Historical events retain their own sealed contract version.
        const actor = object(event.actor),
          lease = object(object(state.issued_leases)[String(actor.lease_id)])
        assertRoleEvidence({ ...state, contract_revision: lease.contract_revision }, event, role)
        return true
      })
    const add = (
      event: Item,
      suffix: string,
      kind: string,
      summary: string,
      affected = packages,
      requirements: string[] = [],
      ids: string[] = [],
      extra: Item = {}
    ) => {
      result.push({
        id: obligationId(raw, String(event.event_id), suffix),
        kind,
        source_sdd: raw,
        source_event: event.event_id,
        summary,
        affected_packages: unique(affected),
        requirement_ids: unique(requirements),
        acceptance_ids: unique(ids),
        ...extra
      })
    }
    const verifications = roleEvents('architect', 'verification')
    for (const event of verifications) {
      const payload = object(event.payload)
      if (payload.result === 'PASS') continue
      const checks = Array.isArray(payload.checks) ? payload.checks.map(object) : []
      let failed = checks
        .map((check, index) => ({ check, index }))
        .filter(({ check }) => check.outcome !== 'PASS')
      if (!failed.length)
        failed = [{ index: -1, check: { oracle: 'overall verification', outcome: payload.result } }]
      for (const { check, index } of failed) {
        const observed = scope(event, check)
        const closed = verifications.some((later) => {
          const next = object(later.payload)
          if (
            events.indexOf(later) <= events.indexOf(event) ||
            next.result !== 'PASS' ||
            !subset(observed.ids, list(next.acceptance_ids))
          )
            return false
          if ((state.phase === 'SHIP' && later.state === 'FINAL_VERIFY') || index === -1)
            return true
          return (
            Array.isArray(next.checks) &&
            next.checks.map(object).some((test) => {
              const reach = scope(later, test)
              return (
                test.outcome === 'PASS' &&
                subset(observed.ids, reach.ids) &&
                subset(observed.packages, reach.packages) &&
                ['method', 'environment', 'oracle'].every((field) => test[field] === check[field])
              )
            })
          )
        })
        if (closed) continue
        add(
          event,
          `check:${index}`,
          'NON_PASS_VERIFICATION',
          `${check.oracle ?? 'verification'} => ${check.outcome ?? payload.result}`,
          observed.packages,
          list(payload.requirement_ids),
          observed.ids,
          {
            source_acceptance: observed.ids
              .filter((id) => acceptance.has(id))
              .map((id) =>
                Object.fromEntries(
                  ['id', 'oracle', 'method', 'environment', 'packages']
                    .filter((field) => Object.hasOwn(acceptance.get(id)!, field))
                    .map((field) => [field, acceptance.get(id)![field]])
                )
              ),
            resolution_method: String(check.method ?? ''),
            verification_environment: String(check.environment ?? ''),
            verification_oracle: String(check.oracle ?? 'overall verification')
          }
        )
      }
    }
    const self = roleEvents('operator', 'self_check').at(-1)
    if (self && object(self.payload).result !== 'PASS') {
      const payload = object(self.payload)
      add(
        self,
        'self-check',
        'NON_PASS_SELF_CHECK',
        `Operator self-check => ${payload.result ?? 'UNKNOWN'}`,
        list(payload.changed_packages).length ? list(payload.changed_packages) : packages,
        list(payload.requirement_ids),
        list(payload.acceptance_ids)
      )
    }
    const escalation = roleEvents('operator', 'implementation_escalation').at(-1)
    if (
      escalation &&
      !events
        .slice(events.indexOf(escalation) + 1)
        .some(
          (event) =>
            event.role === 'coordinator' &&
            event.type === 'contract_admission' &&
            object(event.payload).decision === 'ADMIT'
        )
    )
      add(
        escalation,
        'escalation',
        'ROUTE_INVALIDATION',
        list(object(escalation.payload).invalidated_assumptions).join('; ')
      )
    for (const [id, value] of Object.entries(object(state.findings))) {
      const finding = object(value)
      if (finding.status !== 'open' || !['P0', 'P1', 'P2'].includes(String(finding.priority)))
        continue
      const evidence = events.find(
        (event) =>
          event.event_id === finding.evidence &&
          event.role === 'architect' &&
          event.type === 'finding'
      )
      const payload = object(evidence?.payload)
      add(
        evidence ?? { event_id: finding.evidence ?? 'NO_EVENT' },
        `finding:${id}`,
        'OPEN_FINDING',
        String(payload.summary ?? `${finding.priority} finding ${id} remains open`),
        list(finding.affected_packages).length
          ? list(finding.affected_packages)
          : list(payload.affected_packages).length
            ? list(payload.affected_packages)
            : packages,
        list(payload.requirement_ids),
        list(payload.acceptance_ids)
      )
    }
    if (state.phase === 'BLOCKED') {
      const blocker = events.findLast(
        (event) => event.role === 'coordinator' && event.type === 'terminal_blocker'
      )
      if (blocker && object(blocker.payload).reason !== 'COORDINATOR_AUTHORITY_UNRECOVERABLE')
        add(
          blocker,
          'terminal',
          'TERMINAL_BLOCKER',
          String(object(blocker.payload).summary ?? 'predecessor blocked')
        )
    }
    if (state.pending_user_decision != null) {
      const pending = object(state.pending_user_decision)
      add(
        { event_id: pending.request_hash ?? 'UNKNOWN' },
        'decision',
        'PENDING_USER_DECISION',
        String(pending.question ?? 'predecessor user decision pending')
      )
    }
  }
  return [...new Map(result.map((item) => [String(item.id), item])).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, item]) => item)
}
