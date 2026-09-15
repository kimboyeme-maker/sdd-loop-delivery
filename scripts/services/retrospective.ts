import { parseEvents } from '../resource/store/event-log'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { creditLedger } from '../helpers/credit-ledger'
import { readSnapshot, sidecarPaths } from '../resource/state'
import { readContractDocument } from './contract-document'

type Item = Record<string, unknown>
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined

/** Skill that should change when an issue kind recurs; `host-profile` means agents/hosts data. */
export type EvolutionTarget = 'create-sdd' | 'sdd-loop-delivery' | 'host-profile'

/**
 * Issue kind → the skill surface whose guidance failed to prevent it. `area` names the
 * reference a reviewer opens first; `change` is the direction, never an automatic edit.
 */
const PLAYBOOK: Readonly<
  Record<string, { target: EvolutionTarget; area: string; change: string; severity: string }>
> = {
  CONTRACT_AMENDMENT: {
    target: 'create-sdd',
    area: 'references/phases/2-admit.md',
    change:
      'Close the design gap named by each amendment reason before calling the SDD loop-ready.',
    severity: 'high'
  },
  LATE_USER_DECISION: {
    target: 'create-sdd',
    area: 'references/phases/1-harvest.md',
    change: 'Harvest this authority question into the AUTHORITY_CONFIRMATION queue at design time.',
    severity: 'medium'
  },
  ARCHITECT_REJECTION: {
    target: 'create-sdd',
    area: 'references/planning/verification-planning.md',
    change:
      'Make the rejected acceptance oracle exact enough that Operator self-check reproduces it.',
    severity: 'high'
  },
  BLOCKING_FINDING: {
    target: 'create-sdd',
    area: 'references/loop-ready.md',
    change: 'Add the missed failure mode to the owning requirement, acceptance and falsifier.',
    severity: 'high'
  },
  IMPLEMENTATION_ESCALATION: {
    target: 'create-sdd',
    area: 'references/work-decomposition.md',
    change: 'Widen the causal scope or split the batch that the escalation invalidated.',
    severity: 'high'
  },
  READBACK_CHALLENGE: {
    target: 'create-sdd',
    area: 'references/complete-design.md',
    change: 'Resolve the challenged route or unknown in the design before handoff.',
    severity: 'medium'
  },
  TEST_TIMEOUT: {
    target: 'create-sdd',
    area: 'references/planning/test-budget.md',
    change: 'Re-estimate the acceptance runtime or narrow the test command to the packet oracle.',
    severity: 'medium'
  },
  ROUND_OVERRUN: {
    target: 'create-sdd',
    area: 'references/work-decomposition.md',
    change: 'Split work so a round closes its batches; more rounds signal under-decomposition.',
    severity: 'medium'
  },
  EXECUTION_FAILURE: {
    target: 'sdd-loop-delivery',
    area: 'references/execution.md',
    change: 'Tighten dispatch guidance, deadlines or packet size for this failure root.',
    severity: 'high'
  },
  NO_PROGRESS_RETURN: {
    target: 'sdd-loop-delivery',
    area: 'references/execution.md#response-end-versus-assignment-end',
    change: 'Make continuation guidance name the remaining outcome, check and stop boundary.',
    severity: 'medium'
  },
  CREDIT_PRESSURE: {
    target: 'sdd-loop-delivery',
    area: 'scripts/config/constants.ts',
    change: 'Recalibrate credit weights or the plan estimate that underpriced this delivery.',
    severity: 'medium'
  },
  COMMAND_REJECTION: {
    target: 'sdd-loop-delivery',
    area: 'references/coordinator.md',
    change:
      'Document the precondition behind this repeated rejection code where the role reads it.',
    severity: 'low'
  },
  PIPELINE_INCIDENT: {
    target: 'sdd-loop-delivery',
    area: 'references/recovery.md',
    change: 'Add a recovery or preflight check for this pipeline incident root.',
    severity: 'medium'
  },
  ESTIMATE_MISS: {
    target: 'create-sdd',
    area: 'references/planning/estimate-calibration.md',
    change:
      'Apply the calibrated ratio for this lane to future estimates, or split the batch that overran.',
    severity: 'medium'
  },
  HOST_INCIDENT: {
    target: 'host-profile',
    area: 'agents/hosts',
    change: 'Correct the host profile operation, tier or isolation mapping that failed.',
    severity: 'medium'
  }
}

/** Credit share above which a delivery is flagged as underpriced. */
const CREDIT_PRESSURE_RATIO = 0.8
/** A rejection code must repeat to count as a documentation gap rather than a typo. */
const REPEATED_REJECTION_MIN = 2
const EVIDENCE_LIMIT = 5
/** Actual/estimated ratios outside this band count as an estimate miss. */
const ESTIMATE_MISS_HIGH = 1.5
const ESTIMATE_MISS_LOW = 0.5
/** Batches shorter than this in elapsed minutes are too noisy to judge. */
const ESTIMATE_MIN_ACTUAL_MINUTES = 5

type Estimate = {
  batch_id: string
  lane: string
  estimated_minutes: number
  actual_minutes: number
  ratio: number
}

/**
 * Planned batch minutes against elapsed Operator lease time for the same packet ID. Elapsed time
 * includes waiting inside the lease, which is exactly what the next plan must budget for.
 */
function batchEstimates(sdd: string, state: Item): Estimate[] {
  let plan: Item | undefined
  try {
    plan = object((readContractDocument(sdd) as unknown as Item | undefined)?.delivery_plan)
  } catch {
    return []
  }
  const leases = Object.values(object(state.issued_leases) ?? {})
    .map(object)
    .filter(
      (lease): lease is Item => lease?.role === 'operator' && typeof lease.ended_at === 'string'
    )
  const estimates: Estimate[] = []
  for (const batch of (Array.isArray(plan?.batches) ? plan.batches : []).map(object)) {
    if (!batch || typeof batch.id !== 'string' || !Number(batch.estimated_minutes)) continue
    const minutes = leases
      .filter((lease) => lease.packet_id === batch.id)
      .reduce(
        (sum, lease) =>
          sum + (Date.parse(String(lease.ended_at)) - Date.parse(String(lease.issued_at))) / 60_000,
        0
      )
    if (!(minutes > 0)) continue
    estimates.push({
      batch_id: batch.id,
      lane: String(batch.lane ?? 'default'),
      estimated_minutes: Number(batch.estimated_minutes),
      actual_minutes: Math.round(minutes * 10) / 10,
      ratio: Math.round((minutes / Number(batch.estimated_minutes)) * 100) / 100
    })
  }
  return estimates
}

const median = (values: readonly number[]): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 100) / 100
}
const DETAIL_LIMIT = 160

type Issue = {
  id: string
  kind: string
  key: string
  severity: string
  count: number
  evidence_event_ids: string[]
  details: string[]
}

/** Append one rejected command outcome; code and command only, never arguments or secrets. */
export function recordRejection(sdd: string, command: string, code: string): void {
  const paths = sidecarPaths(sdd)
  // Only an initialized delivery has a diagnostics sidecar; arbitrary paths stay untouched.
  if (!existsSync(paths.state)) return
  mkdirSync(dirname(paths.rejections), { recursive: true, mode: 0o700 })
  appendFileSync(
    paths.rejections,
    `${JSON.stringify({ at: new Date().toISOString(), command, code })}\n`
  )
}

function rejectionCounts(sdd: string): Map<string, number> {
  const counts = new Map<string, number>()
  const path = sidecarPaths(sdd).rejections
  if (!existsSync(path)) return counts
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
    try {
      const code = String((JSON.parse(line) as Item).code)
      counts.set(code, (counts.get(code) ?? 0) + 1)
    } catch {
      /* A torn diagnostic line is ignored; diagnostics never gate delivery. */
    }
  }
  return counts
}

/**
 * Evidence-first retrospective of one delivery. It reads committed state, signed event history
 * and the rejection diagnostics, classifies every problem the delivery met, and derives
 * case-first evolution proposals for create-sdd, this loop or the host profile. It is a
 * projection: it verifies no signature (run `audit` for that) and mutates no skill.
 */
export function retrospective(sdd: string): Item {
  const snapshot = readSnapshot(sdd)
  const state = snapshot.state as Item
  const events = parseEvents(snapshot.eventText)
  const issues = new Map<string, Issue>()
  const note = (kind: string, key: string, event?: Item, detail?: unknown): void => {
    const id = `${kind}:${key}`
    const issue = issues.get(id) ?? {
      id: '',
      kind,
      key,
      severity: PLAYBOOK[kind]!.severity,
      count: 0,
      evidence_event_ids: [],
      details: []
    }
    issue.count++
    if (typeof event?.event_id === 'string' && issue.evidence_event_ids.length < EVIDENCE_LIMIT)
      issue.evidence_event_ids.push(event.event_id)
    if (typeof detail === 'string' && detail.trim() && issue.details.length < EVIDENCE_LIMIT)
      issue.details.push(detail.trim().slice(0, DETAIL_LIMIT))
    issues.set(id, issue)
  }
  const tests = { runs: 0, failed: 0, timed_out: 0, seconds: 0 }
  const verdicts: Record<string, number> = {}
  const findings: Record<string, number> = {}
  let creditExtensions = 0
  for (const event of events) {
    const payload = object(event.payload) ?? {}
    switch (event.type) {
      case 'contract_amendment':
        note('CONTRACT_AMENDMENT', 'amendment', event, payload.reason)
        break
      case 'contract_admission':
        if (payload.decision === 'USER_DECISION')
          note(
            'LATE_USER_DECISION',
            'user-decision',
            event,
            object(payload.authorization_request)?.scenario
          )
        break
      case 'finding_decision': {
        const result = String(payload.architect_result ?? 'UNRECORDED')
        verdicts[result] = (verdicts[result] ?? 0) + 1
        if (['FAIL', 'NOT_RUN', 'INCONCLUSIVE'].includes(result))
          note('ARCHITECT_REJECTION', result, event)
        break
      }
      case 'finding': {
        const priority = String(payload.priority)
        findings[priority] = (findings[priority] ?? 0) + 1
        if (priority === 'P0' || priority === 'P1')
          note('BLOCKING_FINDING', priority, event, payload.summary)
        break
      }
      case 'implementation_escalation':
        note(
          'IMPLEMENTATION_ESCALATION',
          'escalation',
          event,
          String(payload.causal_expansion ?? '')
        )
        break
      case 'contract_readback':
        if (payload.assessment !== undefined && payload.assessment !== 'ACCEPT')
          note('READBACK_CHALLENGE', String(payload.assessment), event)
        break
      case 'plan_challenge':
        note('READBACK_CHALLENGE', 'plan_challenge', event, String(payload.summary ?? ''))
        break
      case 'test_run':
        tests.runs++
        tests.seconds += Number(payload.duration_seconds ?? 0)
        if (payload.timed_out === true) {
          tests.timed_out++
          note('TEST_TIMEOUT', 'timeout', event)
        } else if (payload.outcome !== 'PASS') tests.failed++
        break
      case 'timeout_decision':
        if (payload.action === 'execution_failure')
          note('EXECUTION_FAILURE', String(payload.root_cause_key), event, payload.reason)
        break
      case 'pipeline_incident': {
        const root = String(payload.root_cause_key)
        note(
          /^(HOST|RUNTIME|COORDINATOR_RUNTIME)_/.test(root) ? 'HOST_INCIDENT' : 'PIPELINE_INCIDENT',
          root,
          event,
          payload.reason
        )
        break
      }
      case 'operator_reconcile': {
        const observation = object(payload.observation) ?? payload
        if (observation.no_progress === true)
          note('NO_PROGRESS_RETURN', 'no-progress', event, observation.reason)
        break
      }
      default:
        if (payload.action === 'extend-credit') creditExtensions++
    }
  }
  const estimates = batchEstimates(sdd, state)
  for (const estimate of estimates)
    if (
      estimate.actual_minutes >= ESTIMATE_MIN_ACTUAL_MINUTES &&
      (estimate.ratio > ESTIMATE_MISS_HIGH || estimate.ratio < ESTIMATE_MISS_LOW)
    )
      note(
        'ESTIMATE_MISS',
        estimate.batch_id,
        undefined,
        `lane ${estimate.lane}: estimated ${estimate.estimated_minutes} min, elapsed ${estimate.actual_minutes} min`
      )
  const ledger = creditLedger(state)
  if (ledger && ledger.budget > 0 && ledger.spent / ledger.budget >= CREDIT_PRESSURE_RATIO)
    note(
      'CREDIT_PRESSURE',
      'ledger',
      undefined,
      `spent ${ledger.spent} of ${ledger.budget}; extensions ${creditExtensions}`
    )
  if (Number(state.logical_round ?? 1) > 1)
    note(
      'ROUND_OVERRUN',
      'rounds',
      undefined,
      `closed in round ${state.logical_round} of ${state.max_rounds}`
    )
  for (const [code, count] of rejectionCounts(sdd))
    if (count >= REPEATED_REJECTION_MIN)
      for (let index = 0; index < count; index++) note('COMMAND_REJECTION', code)
  const ordered = [...issues.values()].sort(
    (left, right) =>
      ['high', 'medium', 'low'].indexOf(left.severity) -
        ['high', 'medium', 'low'].indexOf(right.severity) || right.count - left.count
  )
  ordered.forEach((issue, index) => (issue.id = `ISS-${String(index + 1).padStart(2, '0')}`))
  const proposals = ordered.map((issue, index) => {
    const play = PLAYBOOK[issue.kind]!
    return {
      id: `EVO-${String(index + 1).padStart(2, '0')}`,
      key: `${play.target}:${issue.kind}:${issue.key}`,
      target: play.target,
      area: play.area,
      issue_ids: [issue.id],
      change: play.change,
      // A proposal becomes a rule only through a reproducible Bad/Good pair (behavior evaluation).
      behavior_case: {
        bad: `Delivery repeats ${issue.kind} (${issue.key}) as recorded in ${issue.evidence_event_ids[0] ?? 'the diagnostics'}.`,
        good: `The ${play.target} guidance at ${play.area} prevents ${issue.kind} before execution.`
      },
      maturity: 'report'
    }
  })
  const phase = String(state.phase)
  return {
    protocol: 'retrospective/v1',
    sdd: String(state.sdd ?? sdd),
    phase,
    terminal: ['SHIP', 'BLOCKED', 'CANCELLED'].includes(phase),
    source: {
      state_sha256: snapshot.stateHash,
      events_sha256: snapshot.eventsHash,
      event_count: snapshot.eventCount,
      signatures_verified: false
    },
    metrics: {
      rounds: { logical: state.logical_round ?? null, max: state.max_rounds ?? null },
      attempts: state.completed_attempts ?? 0,
      invocations: {
        operator: state.operator_invocations ?? 0,
        architect: state.architect_invocations ?? 0,
        design_counsel: state.design_counsel_invocations ?? 0,
        pipeline_repair_probe: state.pipeline_repair_probe_invocations ?? 0
      },
      contract_revision: state.contract_revision ?? null,
      credit: ledger ? { ...ledger, extensions: creditExtensions } : null,
      tests,
      estimates,
      verdicts,
      findings,
      execution_failures: state.total_execution_failures ?? 0,
      pipeline_incidents: state.pipeline_incidents ?? 0
    },
    issues: ordered,
    proposals,
    apply_policy:
      'Proposals only. A skill changes through a reviewed, case-first edit with user or maintainer authority; recurring keys across deliveries mature to trace.'
  }
}

/** Persist the retrospective next to the other sidecars; returns its path. */
export function writeRetrospective(sdd: string): string {
  const path = sidecarPaths(sdd).retrospective
  writeFileSync(path, `${JSON.stringify(retrospective(sdd), null, 2)}\n`)
  return path
}

/**
 * Merge retrospectives of several deliveries. A proposal key seen in two or more deliveries
 * matures from `report` to `trace`: a recurring, cited pattern worth a behavior case.
 */
export function evolutionDigest(files: readonly string[]): Item {
  type Merged = {
    key: string
    target: string
    area: string
    change: string
    deliveries: string[]
    evidence: string[]
  }
  const merged = new Map<string, Merged>()
  const samples: Estimate[] = []
  for (const file of files) {
    const retro = JSON.parse(readFileSync(file, 'utf8')) as Item
    if (retro.protocol !== 'retrospective/v1') throw new Error('RETROSPECTIVE_PROTOCOL_INVALID')
    const metrics = object(retro.metrics)
    if (Array.isArray(metrics?.estimates)) samples.push(...(metrics.estimates as Estimate[]))
    const issues = new Map(
      (Array.isArray(retro.issues) ? retro.issues : []).map((issue) => [
        String((issue as Item).id),
        issue as Issue
      ])
    )
    for (const proposal of (Array.isArray(retro.proposals) ? retro.proposals : []) as Item[]) {
      const key = String(proposal.key)
      const entry: Merged = merged.get(key) ?? {
        key,
        target: String(proposal.target),
        area: String(proposal.area),
        change: String(proposal.change),
        deliveries: [],
        evidence: []
      }
      if (!entry.deliveries.includes(String(retro.sdd))) entry.deliveries.push(String(retro.sdd))
      for (const id of (proposal.issue_ids ?? []) as string[])
        for (const evidence of issues.get(id)?.evidence_event_ids ?? [])
          if (entry.evidence.length < EVIDENCE_LIMIT) entry.evidence.push(evidence)
      merged.set(key, entry)
    }
  }
  const proposals = [...merged.values()]
    .map((entry) => ({
      ...entry,
      occurrences: entry.deliveries.length,
      maturity: entry.deliveries.length >= 2 ? 'trace' : 'report'
    }))
    .sort((left, right) => right.occurrences - left.occurrences)
  return {
    protocol: 'evolution-digest/v1',
    retrospectives: files.length,
    by_target: Object.fromEntries(
      ['create-sdd', 'sdd-loop-delivery', 'host-profile'].map((target) => [
        target,
        proposals.filter((proposal) => proposal.target === target).length
      ])
    ),
    // Median elapsed/estimated ratio: create-sdd multiplies future batch estimates by it.
    estimate_calibration: {
      samples: samples.length,
      median_ratio: median(samples.map((sample) => sample.ratio)),
      by_lane: Object.fromEntries(
        [...new Set(samples.map((sample) => sample.lane))].map((lane) => {
          const ratios = samples
            .filter((sample) => sample.lane === lane)
            .map((sample) => sample.ratio)
          return [lane, { samples: ratios.length, median_ratio: median(ratios) }]
        })
      )
    },
    proposals
  }
}
