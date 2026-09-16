import { resolve } from 'node:path'
import { parseEvents } from '../resource/store/event-log'
import { hostProfile, operatorRuntime, roleRuntime, type HostProfile } from '../config/host'
import policy from '../../agents/roles.json'
import { readSnapshot } from '../resource/state'
import { closeDecision, spawnDecision } from '../helpers/runtime-facts'
import { leaseSlots } from '../helpers/lease-slots'
import { coordinatorBrief } from './coordinator-brief'
import { runtimeCandidates } from './runtime-candidates'

type Item = Record<string, unknown>
const object = (value: unknown): Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {}

/** Obligation code prefix → the role runtime that must be available to satisfy it. */
const ROLE_FOR_OBLIGATION: ReadonlyArray<readonly [string, 'operator' | 'architect']> = [
  ['DISPATCH_OPERATOR_READBACK', 'operator'],
  ['DISPATCH_NEXT_PACKET', 'operator'],
  ['PREPARE_ARCHITECT_AND_OPEN_READBACK', 'architect'],
  ['DISPATCH_ARCHITECT_VERIFICATION', 'architect'],
  ['DISPATCH_FINAL_VERIFICATION', 'architect']
]
/** Host statuses a runtime can be reused from without a new spawn. */
const REUSABLE = new Set(['idle', 'completed', 'healthy'])
/**
 * Two ceilings, because two different things are being bounded.
 *
 * `INTERACTIVE_WAIT_CAP_MS` is how long one blocking call may hold a turn while a person is waiting
 * for the Coordinator to say something; the program reference states the same 60 seconds for
 * supervision. `LEASE_WAIT_CAP_MS` is how far ahead a wait may be aimed at a lease deadline that is
 * genuinely minutes away. Collapsing them to the smaller number turns a single deadline wait into
 * a polling loop; collapsing them to the larger one lets a supervised turn go silent for ten
 * minutes. The plan emits the interactive ceiling and names the deadline it is really waiting for,
 * so the caller can re-wait without losing the target.
 */
const INTERACTIVE_WAIT_CAP_MS = 60_000
const LEASE_WAIT_CAP_MS = 10 * 60_000

type Call = {
  operation: string
  available: boolean
  call: string | null
  args: Item
  /** Plan context, never a host argument: how far away the thing being waited for actually is. */
  deadline_ms?: number
  purpose: string
  record_after: string | null
}

/** Build one host call from the neutral operation, naming parameters the way the host does. */
function hostCall(
  host: HostProfile,
  operation: keyof HostProfile['operations'],
  values: Item,
  purpose: string,
  recordAfter: string | null,
  deadlineMs?: number
): Call {
  const entry = host.operations[operation]
  if (!entry.available)
    return {
      operation,
      available: false,
      call: null,
      args: {},
      purpose: `${purpose}; unavailable: ${entry.reason}`,
      record_after: null
    }
  const params = entry.params ?? []
  const map = object(entry.arg_map)
  const args: Item = {}
  for (const [neutral, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue
    const mapped =
      typeof map[neutral] === 'string'
        ? String(map[neutral])
        : neutral === 'target'
          ? (params.find((param) => ['target', 'to', 'task_id', 'id'].includes(param)) ?? null)
          : params.includes(neutral)
            ? neutral
            : null
    if (mapped) args[mapped] = value
  }
  return {
    operation,
    available: true,
    call: entry.call ?? null,
    args,
    ...(deadlineMs === undefined ? {} : { deadline_ms: deadlineMs }),
    purpose,
    record_after: recordAfter
  }
}

export { closeDecision, spawnDecision } from '../helpers/runtime-facts'

/**
 * Controller-generated host call plan for the Coordinator's next obligation, in capacity order:
 * close retired runtimes first, then wait on the nearest live lease deadline, then reuse an eligible
 * runtime or spawn with the tier model and isolation arguments. Expired leases are left to the
 * brief's timeout obligation instead of a wait. It executes nothing and grants nothing; dispatch
 * still issues the lease, and every executed call is followed by its runtime-record.
 */
/**
 * The facts a role needs before it can do anything, all of them already in the controller: where
 * the skill and the document are, which packet it holds, and which reference states its protocol.
 * Filling these mechanically is not a second task graph — the guidance, the scope and the lease
 * still come from the dispatch the Coordinator makes. It only stops a hand-assembled prompt from
 * omitting one of them.
 */
function handoff(sdd: string, role: 'operator' | 'architect', state: Item): string {
  return [
    `You are the ${role} for ${sdd}.`,
    `Run controller commands with: bun ${resolve(import.meta.dir, '..', 'main.ts')}`,
    `Read ${resolve(import.meta.dir, '..', '..', 'references', `${role}.md`)} before acting.`,
    `Contract revision ${String(state.contract_revision ?? 'unknown')}, round ${String(state.logical_round ?? 1)}.`,
    'Your lease id, capability file, packet, scope and deadlines arrive with the dispatch that follows; do not act before it.'
  ].join(' ')
}

export function runtimePlan(sdd: string, token = process.env.SDD_LOOP_COORDINATOR_TOKEN): Item {
  const host = hostProfile()
  const snapshot = readSnapshot(sdd)
  const state = snapshot.state as Item
  const events = parseEvents(snapshot.eventText)
  const brief = coordinatorBrief(sdd, token)
  const obligations = (brief.obligations ?? []) as string[]
  const candidates = runtimeCandidates(state, events)
  const calls: Call[] = []
  const lifecycle: Item[] = []
  const decisions = new Map<unknown, string>()
  for (const candidate of candidates) {
    const records = events
      .filter(
        (event) =>
          event.type === 'runtime_record' && object(event.payload).agent_id === candidate.agent_id
      )
      .map((event) => object(event.payload))
    const observedDecision = closeDecision(records)
    const decision =
      observedDecision === 'CLOSE' && !host.operations.close.available
        ? 'CLOSE_UNAVAILABLE'
        : observedDecision
    decisions.set(candidate.agent_id, decision)
    if (decision === 'CLOSE')
      calls.push(
        hostCall(
          host,
          'close',
          { target: candidate.agent_id },
          `retired ${String(candidate.role)} ${String(candidate.agent_id)} still holds host capacity`,
          'runtime-record close_result'
        )
      )
    else if (decision !== 'NONE' && decision !== 'DONE')
      lifecycle.push({ agent_id: candidate.agent_id, decision })
  }
  const deadlines = (Array.isArray(brief.lease_deadlines) ? brief.lease_deadlines : []) as Item[]
  const live = deadlines.filter(
    (deadline) => typeof deadline.seconds_remaining === 'number' && deadline.seconds_remaining > 0
  )
  if (obligations.includes('SUPERVISE_ACTIVE_LEASE') && live.length) {
    const nearest = live.reduce((a, b) =>
      Number(a.seconds_remaining) <= Number(b.seconds_remaining) ? a : b
    )
    // A host's wait has a floor as well as a ceiling. Asking for less than the floor is an invalid
    // call, and rounding it up to the floor would wait past a deadline that is about to fire, so
    // close to expiry there is nothing useful to wait for: the deadline itself is the next event,
    // and the brief's timeout obligation already covers it.
    const floor = Number(object(host.operations.wait.limits)?.min_ms ?? 0)
    const remaining = Number(nearest.seconds_remaining) * 1000
    if (remaining < floor)
      lifecycle.push({
        role: String(nearest.role),
        decision: 'DEADLINE_IMMINENT_NO_WAIT',
        lease_id: nearest.lease_id,
        seconds_remaining: nearest.seconds_remaining
      })
    else
      calls.push(
        hostCall(
          host,
          'wait',
          { timeout_ms: Math.max(floor, Math.min(remaining, INTERACTIVE_WAIT_CAP_MS)) },
          `wait for role events up to the interactive ceiling, then re-wait: the ${String(nearest.role)} lease ${String(nearest.lease_id)} deadline is the real target, not a poll interval`,
          null,
          Math.min(Number(nearest.seconds_remaining) * 1000, LEASE_WAIT_CAP_MS)
        )
      )
  }
  // After a LIMIT, creation is proposed again only once recorded capacity changed.
  const spawn = spawnDecision(events)
  for (const [prefix, role] of ROLE_FOR_OBLIGATION) {
    if (!obligations.some((code) => code.startsWith(prefix))) continue
    const reusable = candidates.find(
      (candidate) =>
        candidate.role === role &&
        candidate.eligible === true &&
        REUSABLE.has(String(candidate.host_status)) &&
        !(candidate.active_grants as unknown[]).length
    )
    if (reusable) {
      calls.push(
        hostCall(
          host,
          'idle_continuation',
          {
            target: reusable.agent_id,
            message: `Continue as ${role} for ${sdd} at contract revision ${String(state.contract_revision ?? 'unknown')}. The dispatch that follows carries your lease id, capability file, packet and deadlines; act only on it.`
          },
          `reuse eligible ${role} ${String(reusable.agent_id)} after dispatch`,
          null
        )
      )
      continue
    }
    if (spawn === 'LIMIT_UNCHANGED') {
      lifecycle.push({ role, decision: 'SPAWN_BLOCKED_BY_LIMIT' })
      continue
    }
    const runtime =
      role === 'operator'
        ? operatorRuntime(policy.roles.operator.default_profile, host)
        : roleRuntime('architect', host)
    // Where a role runs is a host fact, not a preference: a profile whose default mode is `thread`
    // creates the role as an independent task instead of an in-session child, because that is the
    // surface whose capacity it can actually predict.
    const hosting = host.role_hosting
    const declared = hosting?.default ?? 'collaboration'
    const entry = hosting?.modes?.[declared]
    // Only a wired mode is planned. A mode the host offers but this controller cannot drive end to
    // end would produce a create call with no usable arguments and then continue and wait through
    // the other mode's operations, which is worse than staying on the path that works.
    const usable = entry?.available === true && entry.wired === true
    const mode = usable ? declared : 'collaboration'
    const create = usable ? entry!.operations.create : 'spawn'
    calls.push(
      hostCall(
        host,
        create,
        {
          name: `${role}-${String(state.logical_round ?? 1)}`,
          prompt: handoff(sdd, role, state),
          model: runtime.spawn_model,
          effort: runtime.reasoning_effort,
          ...(create === 'spawn' ? runtime.spawn_args : {})
        },
        `no eligible ${role}: create at tier ${runtime.tier} in ${mode} mode${
          usable && entry?.requires?.length ? `; ${entry.requires.join(' ')}` : ''
        }`,
        'runtime-record spawn_result, then observe'
      )
    )
  }
  const grantHolders = new Set(
    [...leaseSlots(state), object(state.preparation)].map((grant) => grant.agent_id).filter(Boolean)
  )
  const hostCapacity = events
    .filter(
      (event) => event.type === 'runtime_record' && object(event.payload).action === 'capacity'
    )
    .map((event) => object(object(event.payload).capacity))
    .at(-1)
  return {
    protocol: 'runtime-plan/v1',
    host: host.id,
    phase: state.phase,
    obligations,
    calls,
    lifecycle,
    expired_leases: deadlines
      .filter(
        (deadline) => deadline.seconds_remaining === null || Number(deadline.seconds_remaining) <= 0
      )
      .map((deadline) => deadline.lease_id),
    // Counts come from grants and recorded close facts; host slots are unknown until observed.
    capacity: {
      executing: candidates.filter((candidate) => grantHolders.has(candidate.agent_id)).length,
      reusable: candidates.filter(
        (candidate) =>
          !grantHolders.has(candidate.agent_id) &&
          candidate.eligible === true &&
          REUSABLE.has(String(candidate.host_status))
      ).length,
      release_unconfirmed: [...decisions.values()].filter((decision) =>
        ['CLOSE', 'CLOSE_UNAVAILABLE', 'RETRY_BLOCKED', 'RELEASE_UNCONFIRMED'].includes(decision)
      ).length,
      host_slots_available: hostCapacity ? (hostCapacity.available_slots ?? 'unknown') : 'unknown',
      host_slots_observed_at: hostCapacity?.observed_at ?? null,
      config_key: host.concurrency.config_key
    },
    executes: false,
    brief_fingerprint: brief.brief_fingerprint
  }
}
