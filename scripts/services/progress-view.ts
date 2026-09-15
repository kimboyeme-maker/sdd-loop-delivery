import { eventsWithId } from '../utils/event-index'
import { readContractBundle } from './contract-document'
import { documentPresentation } from '../domain/document-presentation'
import { currentAdmission } from '../helpers/admission-authority'
import { assertCurrentSource } from '../helpers/source-binding'
import { assertRoleEvidence } from '../helpers/role-evidence'
import { assertVerificationReviewer } from '../helpers/verification-reviewer'
import { currentCandidate, assertCandidateBinding } from '../helpers/candidate-evidence'
import { assertExecutionBindings } from '../helpers/execution-bindings'
import { assertRoleReceipt } from '../schemas/role-receipt'
import { assertShipEvidence } from '../helpers/ship-evidence'
import { canonicalJson } from '../resource/wire/canonical-json'
type Item = Record<string, unknown>
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const overlap = (left: readonly string[], right: readonly string[]) =>
  left.some((item) => right.includes(item))
const subset = (left: readonly string[], right: readonly string[]) =>
  left.every((item) => right.includes(item))

/** Derive human progress from the normative index and authenticated candidate evidence.
 * This projection never writes status into the SDD or creates implementation tasks.
 * Incomplete or stale evidence produces UNKNOWN, not an optimistic completion mark.
 */
export function progressView(sdd: string, state: Item, events: readonly Item[]): Item {
  const control = {
    state: state.phase,
    waiting_user: !!state.pending_user_decision,
    paused: state.phase === 'PAUSED',
    pipeline_repair: !!state.pending_pipeline_repair
  }
  const empty = (reason: string) => ({
    protocol: 'sdd-presentation/v1',
    status: 'UNKNOWN',
    reason,
    items: [],
    batches: [],
    current_items: [],
    control
  })
  try {
    assertCurrentSource(state, sdd)
    const { contract, sources } = readContractBundle(sdd)
    if (!contract) return empty('CONTRACT_REQUIRED')
    const presentation = documentPresentation(contract, sources)
    let admission: Item = {}
    try {
      admission = currentAdmission(state, events, process.env.SDD_LOOP_COORDINATOR_TOKEN)
        .payload as Item
    } catch {
      /* Unadmitted documents can still show pending requirements. */
    }
    const packets = Array.isArray(admission.execution_packets)
      ? (admission.execution_packets as Item[])
      : []
    const items = presentation
      ? (presentation.items as Item[])
      : packets.length
        ? packets.map((packet) => ({
            id: packet.id,
            kind: 'batch',
            description: packet.outcome ?? '描述未提供',
            requirement_ids: strings(packet.requirement_ids),
            acceptance_ids: strings(packet.acceptance_ids),
            batch_ids: [],
            gate: null,
            source: { event: 'current_admission' }
          }))
        : contract.requirements
            .filter((item) => item.kind !== 'non-goal')
            .map((item) => ({
              id: item.id,
              kind: 'requirement',
              description: item.title ?? '描述未提供',
              requirement_ids: [item.id],
              acceptance_ids: item.acceptance ?? [],
              batch_ids: [],
              gate: null,
              source: { document: 'self' }
            }))
    const counts = new Map<unknown, number>()
    for (const event of events) counts.set(event.event_id, (counts.get(event.event_id) ?? 0) + 1)
    const validRole = (event: Item, role: string): boolean => {
      try {
        if (counts.get(event.event_id) !== 1) return false
        assertRoleEvidence(state, event, role)
        return true
      } catch {
        return false
      }
    }
    const cases = new Map((contract.acceptance as Item[]).map((item) => [String(item.id), item]))
    const implemented = new Set<string>()
    for (const event of events)
      if (event.type === 'implementation' && validRole(event, 'operator')) {
        const payload = event.payload as Item
        strings(payload.requirement_ids).forEach((id) => implemented.add(id))
        for (const packet of packets)
          if (strings(payload.execution_packet_ids).includes(String(packet.id)))
            strings(packet.requirement_ids).forEach((id) => implemented.add(id))
      }
    let candidate: Item | undefined
    try {
      candidate = currentCandidate(sdd, state, events).candidate
    } catch {
      /* No current candidate means no completion evidence. */
    }
    const facts = new Map<string, { status: string; evidence_ids: string[] }>()
    const verified = new Set<string>()
    for (const event of events) {
      if (
        [
          'verification_revoked',
          'contract_amendment',
          'timeout_decision',
          'pipeline_incident',
          'recovery'
        ].includes(String(event.type))
      ) {
        for (const [id, fact] of facts) facts.set(id, { ...fact, status: 'UNKNOWN' })
        verified.clear()
        continue
      }
      if (event.type !== 'verification' || event.contract_revision !== state.contract_revision)
        continue
      const payload = event.payload as Item
      let authenticated = false
      try {
        if (!candidate || !Object.keys(admission).length || !validRole(event, 'architect'))
          throw Error('NO_CURRENT_CANDIDATE')
        assertVerificationReviewer(state, events, event)
        assertRoleReceipt('verification', payload)
        assertCandidateBinding(payload, candidate)
        const actor = event.actor as Item
        const lease = (state.issued_leases as Record<string, Item>)[String(actor.lease_id)]!
        assertExecutionBindings(state, contract, lease, payload, events, admission)
        authenticated = true
      } catch {
        /* Invalid evidence is visible as UNKNOWN for its claimed scope. */
      }
      for (const aid of strings(payload.acceptance_ids)) {
        const entry = cases.get(aid)
        if (!entry) continue
        const checks = (Array.isArray(payload.checks) ? (payload.checks as Item[]) : []).filter(
          (check) => strings(check.acceptance_ids).includes(aid)
        )
        const bound =
          checks.length > 0 &&
          checks.every(
            (check) =>
              ['method', 'environment', 'oracle'].every((key) => check[key] === entry[key]) &&
              canonicalJson(strings(check.packages).sort()) ===
                canonicalJson(strings(entry.packages).sort())
          )
        const stage =
          authenticated && bound
            ? payload.result === 'PASS' && checks.every((check) => check.outcome === 'PASS')
              ? 'DONE'
              : payload.result === 'FAIL'
                ? 'REWORK'
                : 'UNKNOWN'
            : 'UNKNOWN'
        facts.set(aid, {
          status: stage,
          evidence_ids: authenticated ? [String(event.event_id)] : []
        })
      }
      if (authenticated && payload.result === 'PASS')
        for (const req of contract.requirements) {
          if (
            (state.requirements as Item | undefined)?.[req.id] === 'verified' &&
            (state.requirement_evidence as Item | undefined)?.[req.id] === event.event_id &&
            strings(payload.requirement_ids).includes(req.id) &&
            subset(req.acceptance ?? [], strings(payload.acceptance_ids))
          )
            verified.add(req.id)
        }
    }
    const findingReqs: string[] = [],
      findingAcs: string[] = []
    for (const finding of Object.values((state.findings ?? {}) as Record<string, Item>)) {
      if (finding.status !== 'open') continue
      const event = eventsWithId(events, finding.evidence)[0]
      if (event?.type === 'finding' && validRole(event, 'architect')) {
        const payload = event.payload as Item
        findingReqs.push(...strings(payload.requirement_ids))
        findingAcs.push(...strings(payload.acceptance_ids))
      }
    }
    let ship = false
    try {
      if (state.phase === 'SHIP') {
        assertShipEvidence(state, events, process.env.SDD_LOOP_COORDINATOR_TOKEN ?? '', sdd)
        ship = true
      }
    } catch {
      /* A stored SHIP label alone is not completion evidence. */
    }
    const active = state.active_lease as Item | undefined
    const activeIds =
      active && !active.repair_probe_root && active.verification_mode !== 'design-counsel'
        ? strings(
            (packets.find((packet) => packet.id === active.packet_id) ?? admission).requirement_ids
          )
        : []
    const reliable = !state.pending_pipeline_repair && !state.pending_execution_failure
    const output = items
      .filter((item) => item.executable !== false)
      .map((item) => {
        const reqs = strings(item.requirement_ids),
          aids = strings(item.acceptance_ids)
        const relevant = aids.map((id) => facts.get(id) ?? { status: 'PENDING', evidence_ids: [] })
        const statuses = relevant.map((fact) => fact.status)
        let stage: string, next_action: string
        if (!reliable || !reqs.length || !aids.length || statuses.includes('UNKNOWN')) {
          stage = 'UNKNOWN'
          next_action = '核实描述关联、退出条件和当前证据'
        } else if (
          statuses.includes('REWORK') ||
          overlap(reqs, findingReqs) ||
          overlap(aids, findingAcs)
        ) {
          stage = 'REWORK'
          next_action = '处理关联发现并重新验证'
        } else if (
          statuses.every((status) => status === 'DONE') &&
          reqs.every((id) => verified.has(id)) &&
          (!item.gate || ship)
        ) {
          stage = 'DONE'
          next_action = '已具备当前有效的完成证据'
        } else if (overlap(reqs, activeIds)) {
          stage = 'ACTIVE'
          next_action = '继续当前已准入事项并提交必要检查'
        } else if (
          statuses.every((status) => status === 'DONE') ||
          reqs.every((id) => implemented.has(id))
        ) {
          stage = 'AWAITING_VERIFICATION'
          next_action = '完成独立验证及关联门禁确认'
        } else {
          stage = 'PENDING'
          next_action = '依照现有依赖和准入安排执行'
        }
        return {
          ...item,
          stage,
          next_action,
          evidence_ids: [...new Set(relevant.flatMap((fact) => fact.evidence_ids))].sort()
        } as Item
      })
    for (const batch of output)
      if (batch.kind === 'batch' && batch.stage === 'DONE') {
        const children = output.filter(
          (item) => strings(item.batch_ids).includes(String(batch.id)) && item.stage !== 'DONE'
        )
        if (children.length) {
          batch.stage = children.some((item) => item.stage === 'UNKNOWN')
            ? 'UNKNOWN'
            : children.some((item) => item.stage === 'REWORK')
              ? 'REWORK'
              : 'AWAITING_VERIFICATION'
          batch.next_action = '关闭关联事项：' + children.map((item) => item.id).join(', ')
        }
      }
    const activeBatches = output
      .filter((item) => item.kind === 'batch' && overlap(strings(item.requirement_ids), activeIds))
      .map((item) => String(item.id))
    return {
      protocol: 'sdd-presentation/v1',
      status: reliable ? 'CURRENT' : 'UNKNOWN',
      items: output,
      batches: output.filter((item) => item.kind === 'batch').map((item) => item.id),
      current_items: output
        .filter(
          (item) =>
            item.kind !== 'batch' &&
            (overlap(strings(item.batch_ids), activeBatches) ||
              overlap(strings(item.requirement_ids), activeIds))
        )
        .map((item) => item.id),
      notes: presentation
        ? []
        : ['Descriptions use existing packet outcomes or requirement titles.'],
      control
    }
  } catch (error) {
    return empty(error instanceof Error ? error.message : 'PROGRESS_UNAVAILABLE')
  }
}
