import { eventsOfType } from '../utils/event-index'
import { leaseSlots } from './lease-slots'
import { coordinatorHistory } from '../domain/policies/coordinator-history'
import policy from '../../agents/roles.json'
import { operatorRuntime, roleRuntime, runtimeMatches } from '../config/host'
type Item = Record<string, unknown>
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)

/** Retirement preserves evidence and follows revocation; host closure and released capacity are distinct facts. */
export function assertRuntimeLifecycle(state: Item, events: readonly Item[], input: Item): void {
  const records = events
    .filter(
      (event) =>
        event.type === 'runtime_record' &&
        (event.payload as Item | undefined)?.agent_id === input.agent_id
    )
    .map((event) => event.payload as Item)
  const retired = records.some((record) => record.action === 'retire')
  const observation = records.findLast((record) => record.action === 'observe')
  if (input.action === 'observe') {
    const host = input.host as Item | undefined
    const role = input.agent_role
    const knownRole = (state.agent_roles as Item | undefined)?.[String(input.agent_id)]
    // A historical Coordinator is observed only as a host resource, never as a product role; the
    // current Coordinator is not a runtime-record subject.
    const historicalCoordinator =
      role === 'coordinator' &&
      coordinatorHistory(state).includes(String(input.agent_id)) &&
      input.agent_id !== state.coordinator_agent_id
    if (
      (!['operator', 'architect'].includes(String(role)) && !historicalCoordinator) ||
      (role !== 'coordinator' && coordinatorHistory(state).includes(String(input.agent_id))) ||
      (knownRole !== undefined && knownRole !== role) ||
      (observation && observation.agent_role !== role)
    )
      throw new Error('RUNTIME_ROLE_INVALID')
    const runtimes =
      role === 'operator'
        ? Object.keys(policy.roles.operator.profiles).map((name) => operatorRuntime(name))
        : [roleRuntime(role === 'coordinator' ? 'coordinator' : 'architect')]
    if (
      !host ||
      // A controllable runtime must match its tier; a lost or uncontrollable one may not know it.
      ((host.controllable === true || host.model !== undefined) &&
        !runtimes.some((runtime) => runtimeMatches(runtime, host))) ||
      !['healthy', 'idle', 'completed', 'stopped', 'lost', 'interrupted', 'unknown'].includes(
        String(host.status)
      ) ||
      // Negative and unknown (null) facts are recorded as observed; eligibility decides reuse.
      ['controllable', 'writer_stopped', 'commands_stopped', 'close_available'].some(
        (key) => host[key] !== null && typeof host[key] !== 'boolean'
      ) ||
      !text(host.conversation_id) ||
      !texts(host.ancestor_ids) ||
      !host.ancestor_ids.length ||
      host.confirmed_by === input.agent_id ||
      !host.ancestor_ids.includes(String(host.confirmed_by))
    )
      throw new Error('RUNTIME_HOST_CONFIRMATION_INVALID')
    const conversations = events
      .filter(
        (event) => event.type === 'runtime_record' && (event.payload as Item)?.action === 'observe'
      )
      .map((event) => ((event.payload as Item).host as Item)?.conversation_id)
    if (conversations.length && !conversations.includes(host.conversation_id))
      throw new Error('RUNTIME_CONVERSATION_MISMATCH')
    if (
      !historicalCoordinator &&
      state.coordinator_agent_id &&
      !host.ancestor_ids.includes(String(state.coordinator_agent_id))
    ) {
      const known =
        observation ||
        Object.values((state.issued_leases ?? {}) as Item).some(
          (lease) => (lease as Item).agent_id === input.agent_id
        )
      if (
        !known ||
        !host.ancestor_ids.some((id) => coordinatorHistory(state).includes(id)) ||
        host.writer_stopped !== true ||
        host.commands_stopped !== true ||
        [...leaseSlots(state), state.preparation].some(
          (grant) => (grant as Item | null)?.agent_id === input.agent_id
        )
      )
        throw new Error('RUNTIME_TRANSFER_REQUIRES_KNOWN_STOPPED_REVOKED_RUNTIME')
    }
  }
  if (input.action === 'retire') {
    const roles = state.agent_roles as Item | undefined
    const coordinatorResource = coordinatorHistory(state).includes(String(input.agent_id))
    if (
      (!roles?.[String(input.agent_id)] && !observation) ||
      input.agent_id === state.coordinator_agent_id ||
      (coordinatorResource && observation?.agent_role !== 'coordinator')
    )
      throw new Error('RUNTIME_RETIRE_UNKNOWN_ROLE')
    // Closing a host runtime can take its descendants with it: every recorded descendant must be
    // retired first, so a subtree still in use is never wound down by accident.
    const payloads = eventsOfType(events, 'runtime_record').map((event) => event.payload as Item)
    const retiredIds = new Set(
      payloads.filter((payload) => payload.action === 'retire').map((payload) => payload.agent_id)
    )
    if (
      payloads.some(
        (payload) =>
          payload.action === 'observe' &&
          payload.agent_id !== input.agent_id &&
          texts((payload.host as Item | undefined)?.ancestor_ids) &&
          ((payload.host as Item).ancestor_ids as string[]).includes(String(input.agent_id)) &&
          !retiredIds.has(payload.agent_id)
      )
    )
      throw new Error('RUNTIME_RETIRE_SUBTREE_IN_USE')
    if (
      input.writer_stopped !== true ||
      input.commands_stopped !== true ||
      !texts(input.preserved_evidence) ||
      !input.preserved_evidence.length ||
      !text(input.next_action)
    )
      throw new Error('RUNTIME_RETIRE_STOP_AND_PRESERVATION_REQUIRED')
    if (
      [...leaseSlots(state), state.preparation].some(
        (grant) => (grant as Item | null)?.agent_id === input.agent_id
      )
    )
      throw new Error('RUNTIME_RETIRE_REVOKE_REQUIRED')
    if (retired) throw new Error('RUNTIME_ALREADY_RETIRED')
  }
  // 3. Host capacity seen by the current Coordinator, bound to its observation time and source.
  if (input.action === 'capacity') {
    const capacity = input.capacity as Item | undefined
    if (
      input.agent_id !== state.coordinator_agent_id ||
      !capacity ||
      !text(capacity.source) ||
      !Number.isFinite(Date.parse(String(capacity.observed_at))) ||
      !(
        capacity.available_slots === null ||
        (Number.isSafeInteger(capacity.available_slots) && Number(capacity.available_slots) >= 0)
      )
    )
      throw new Error('RUNTIME_CAPACITY_OBSERVATION_INVALID')
  }
  if (input.action === 'close_result') {
    if (!retired || !['CLOSED', 'FAILED', 'UNKNOWN', 'UNAVAILABLE'].includes(String(input.result)))
      throw new Error('RUNTIME_CLOSE_RETIRED_REQUIRED')
    if (
      !Object.hasOwn(input, 'capacity_released') ||
      (input.capacity_released !== null && typeof input.capacity_released !== 'boolean')
    )
      throw new Error('RUNTIME_CAPACITY_INVALID')
    const host = observation?.host as Item | undefined
    if (
      input.result === 'CLOSED' &&
      (!host ||
        host.close_available !== true ||
        !Array.isArray(host.ancestor_ids) ||
        !host.ancestor_ids.includes(input.confirmed_by) ||
        !text(input.host_receipt))
    )
      throw new Error('RUNTIME_CLOSE_HOST_RECEIPT_REQUIRED')
    if (
      input.capacity_released === true &&
      (input.result !== 'CLOSED' || !text(input.capacity_evidence))
    )
      throw new Error('RUNTIME_CAPACITY_EVIDENCE_REQUIRED')
    if (
      records.some((record) => record.action === 'close_result' && record.result === 'CLOSED') &&
      input.result !== 'CLOSED'
    )
      throw new Error('RUNTIME_CLOSURE_CANNOT_REGRESS')
    if (
      records.some(
        (record) => record.action === 'close_result' && record.capacity_released === true
      ) &&
      input.capacity_released !== true
    )
      throw new Error('RUNTIME_CAPACITY_CANNOT_REGRESS')
  }
  if (
    input.action === 'spawn_result' &&
    (!['CREATED', 'LIMIT', 'UNKNOWN', 'FAILED'].includes(String(input.result)) ||
      !text(input.attempt_id) ||
      !texts(input.reuse_exclusions) ||
      !text(input.reason))
  )
    throw new Error('RUNTIME_SPAWN_RESULT_INVALID')
}
