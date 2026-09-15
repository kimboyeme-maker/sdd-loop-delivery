import { leaseSlots } from '../helpers/lease-slots'
import { publicLease } from '../helpers/public-lease'
import { nextControlRevision } from '../domain/policies/control-revision'
import { correlateEvent } from '../context/command-context'
import { randomUUID } from 'node:crypto'
import {
  COORDINATOR_TOKEN_ENV,
  commitControl,
  openCoordinatorCommand,
  signCoordinatorEvent
} from '../services/control-kernel'

const TOKEN_ENV = COORDINATOR_TOKEN_ENV

/** Record a product or control-plane failure without fabricating role evidence. */
export function failure(
  kind: 'execution' | 'pipeline',
  sdd: string,
  role: string,
  expectedState: string,
  expectedRevision: string,
  agent: string,
  reason: string,
  rootCause: string,
  token = process.env[TOKEN_ENV]
): Readonly<{ protocol: 'failure/v1'; eventId: string; kind: string }> {
  if (role !== 'coordinator') throw new Error('ROLE_FAILURE_FORBIDDEN')
  if (!agent.trim() || !reason.trim() || !rootCause.trim())
    throw new Error('FAILURE_METADATA_REQUIRED')
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  const control = openCoordinatorCommand(sdd, token, expectedState, expectedRevision)
  const { state } = control
  const current = String(state.phase ?? '')
  const lease = state.active_lease ?? leaseSlots(state)[0] ?? null
  if (
    lease != null &&
    (typeof lease !== 'object' || (lease as Record<string, unknown>).role !== agent)
  )
    throw new Error('FAILED_LEASE_ROLE_MISMATCH')
  const failedLease = lease as Record<string, unknown> | null | undefined
  if (kind === 'execution' && !failedLease) throw new Error('ACTIVE_AGENT_LEASE_REQUIRED')
  const probeRoot = failedLease?.repair_probe_root
  if (kind === 'execution' && probeRoot) throw new Error('PIPELINE_FAILURE_COMMAND_REQUIRED')
  const root = kind === 'pipeline' && typeof probeRoot === 'string' ? probeRoot : rootCause
  const increment = (value: unknown): number => {
    const count = value === undefined ? 0 : value
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('FAILURE_COUNT_INVALID')
    return count + 1
  }
  const countKey = kind === 'execution' ? 'total_execution_failures' : 'pipeline_incidents'
  const rootsKey = kind === 'execution' ? 'execution_failure_roots' : 'pipeline_incident_roots'
  const priorRoots = state[rootsKey]
  if (
    priorRoots !== undefined &&
    (!priorRoots || typeof priorRoots !== 'object' || Array.isArray(priorRoots))
  )
    throw new Error('FAILURE_ROOTS_INVALID')
  const roots = { ...(priorRoots as Record<string, unknown> | undefined) }
  const sameRootCount = increment(Object.hasOwn(roots, root) ? roots[root] : undefined)
  roots[root] = sameRootCount
  const nextState: Record<string, unknown> = {
    ...state,
    active_lease: null,
    shard_leases: {},
    final_shard_verdicts: null,
    preparation: null,
    [countKey]: increment(state[countKey]),
    [rootsKey]: roots,
    updated_at: new Date().toISOString(),
    revision: nextControlRevision(state.revision)
  }
  if (kind === 'execution') {
    nextState.consecutive_execution_failures =
      state.last_execution_failure_root === root
        ? increment(state.consecutive_execution_failures)
        : 1
    nextState.last_execution_failure_root = root
    nextState.pending_execution_failure = {
      agent,
      reason,
      root_cause_key: root,
      failed_lease_id: failedLease!.lease_id
    }
    nextState.phase = 'CONTRACT_DRAFT'
  } else {
    if (root.startsWith('ENVIRONMENT_'))
      nextState.execution_substrate_required = { trigger: 'ENVIRONMENT_INCIDENT', reason: root }
    if (probeRoot) {
      const pending = state.pending_pipeline_repair as Record<string, unknown> | undefined
      if (!pending || pending.root_cause_key !== root)
        throw new Error('PIPELINE_REPAIR_ROOT_MISMATCH')
      const retained = { ...pending, probe_failures: increment(pending.probe_failures) }
      delete (retained as Record<string, unknown>).candidate
      delete (retained as Record<string, unknown>).candidate_hash
      nextState.pending_pipeline_repair = retained
    } else
      nextState.pending_pipeline_repair = {
        agent,
        reason,
        root_cause_key: root,
        incident_count: sameRootCount
      }
  }
  const eventId = `EVT-${randomUUID()}`
  const body = correlateEvent({
    event_id: eventId,
    role: 'coordinator',
    type: kind === 'execution' ? 'timeout_decision' : 'pipeline_incident',
    payload: {
      agent,
      reason,
      action: kind === 'execution' ? 'execution_failure' : 'pipeline_failure',
      root_cause_key: root,
      same_root_count: sameRootCount,
      failed_lease: publicLease(failedLease),
      ...(kind === 'execution'
        ? {
            count: nextState.total_execution_failures,
            consecutive_same_root_count: nextState.consecutive_execution_failures,
            failed_state: current
          }
        : {
            incident_count: nextState.pipeline_incidents,
            repair_probe_failure: !!probeRoot,
            product_state_preserved: current
          }),
      state_after: nextState.phase,
      revoked_prepared_id:
        (state.preparation as Record<string, unknown> | undefined)?.prepared_id ?? null
    }
  })
  commitControl(control, nextState, signCoordinatorEvent(state, body, token), token)
  return { protocol: 'failure/v1', eventId, kind }
}
