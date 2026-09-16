import { assertRuntimeRecordPhase } from '../domain/policies/phase'
import { coordinatorProof, verifyCoordinatorProof } from '../resource/coordinator-evidence'
import { nextControlRevision } from '../domain/policies/control-revision'
import { assertRuntimeLifecycle } from '../helpers/runtime-lifecycle'
import { assertRuntimeGuidance } from '../helpers/runtime-guidance'
import { assertProgramExecution } from '../services/program-execution'
import { assertRuntimeSupervision } from '../helpers/runtime-supervision'
import { correlateEvent } from '../context/command-context'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  COORDINATOR_TOKEN_ENV,
  assertCoordinatorToken,
  assertExpected,
  commitControl,
  loadControl
} from '../services/control-kernel'
import { isDeepStrictEqual } from 'node:util'
import { resolve } from 'node:path'

const TOKEN_ENV = COORDINATOR_TOKEN_ENV
const ACTIONS = new Set([
  'observe',
  'guidance',
  'retire',
  'close_result',
  'spawn_result',
  'supervision',
  // Host usage accounting from the `usage_read` operation; calibrates relative credit.
  'usage',
  // Host capacity observed by the current Coordinator (slots, time, source).
  'capacity',
  // A role's turn was interrupted. On a host without `close` this is the only thing that can free
  // execution capacity, so it is recorded as what it is - a turn ended - and never as a release:
  // `ended_turn` says the turn stopped, and nothing here claims the runtime went away.
  'interrupt_result'
])
// `coordinator` names a historical Coordinator recorded as a host resource, never a product role.
const ROLES = new Set(['operator', 'architect', 'coordinator'])

/** Record authenticated host facts; this never claims the controller stopped a process. */
export function runtimeRecord(
  sdd: string,
  role: string,
  expectedState: string | undefined,
  expectedRevision: string,
  payload: unknown,
  token = process.env[TOKEN_ENV]
): Readonly<{ protocol: 'runtime-record/v1'; eventId: string; id: string; action: string }> {
  if (role !== 'coordinator') throw new Error('RUNTIME_COORDINATOR_ONLY')
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('RUNTIME_PAYLOAD_INVALID')
  const input = payload as Record<string, unknown>
  if (
    typeof input.id !== 'string' ||
    !input.id.trim() ||
    typeof input.agent_id !== 'string' ||
    !input.agent_id.trim() ||
    typeof input.action !== 'string' ||
    !ACTIONS.has(input.action) ||
    typeof input.evidence !== 'string' ||
    !input.evidence.trim()
  )
    throw new Error('RUNTIME_PAYLOAD_INVALID')
  if (
    input.agent_role !== undefined &&
    (typeof input.agent_role !== 'string' || !ROLES.has(input.agent_role))
  )
    throw new Error('RUNTIME_ROLE_INVALID')
  const control = loadControl(sdd)
  const { paths, state } = control
  assertRuntimeRecordPhase(state.phase, input.action)
  // Host facts may be recorded without naming a phase; the revision is always bound.
  assertExpected(state, expectedState ?? String(state.phase ?? ''), expectedRevision)
  assertCoordinatorToken(state, token)
  if (
    input.controller !== resolve(sdd) ||
    input.coordinator_agent_id !== state.coordinator_agent_id
  )
    throw new Error('RUNTIME_BINDING_INVALID')
  if (input.authority_epoch !== state.authority_epoch) throw new Error('RUNTIME_BINDING_INVALID')
  const events = control.events()
  if (input.action === 'guidance') {
    const programContext = assertProgramExecution(sdd, state, input.packet_id, 'read')
    if (programContext) input.program_context = programContext
  }
  if (existsSync(paths.journal)) throw new Error('CONTROL_TRANSACTION_PENDING')
  const matches = events.filter(
    (event) =>
      event.type === 'runtime_record' &&
      (event.payload as Record<string, unknown> | undefined)?.id === input.id
  )
  if (matches.length > 1) throw new Error('RUNTIME_OBSERVATION_AMBIGUOUS')
  const prior = matches[0]
  if (prior) {
    const { signature, ...body } = prior
    if (
      prior.role !== 'coordinator' ||
      signature !== createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
    )
      throw new Error('RUNTIME_OBSERVATION_SIGNATURE_INVALID')
    const old = prior.payload as Record<string, unknown>
    if (!isDeepStrictEqual(old, input)) throw new Error('RUNTIME_OBSERVATION_ID_CONFLICT')
    return {
      protocol: 'runtime-record/v1',
      eventId: String(prior.event_id),
      id: input.id,
      action: input.action
    }
  }
  {
    const records = events.filter(
      (event) =>
        event.type === 'runtime_record' &&
        (event.payload as Record<string, unknown> | undefined)?.agent_id === input.agent_id
    )
    if (input.previous_record_id !== (records.at(-1)?.event_id ?? null))
      throw new Error('RUNTIME_OBSERVATION_STALE')
  }
  const usage = input.action === 'usage' ? assertUsage(input) : null
  if (!usage) assertRuntimeLifecycle(state, events, input)
  assertRuntimeGuidance(sdd, state, events, input, token)
  assertRuntimeSupervision(state, events, input, token)
  const eventId = `EVT-${randomUUID()}`
  // Host observations do not prove process termination. Revocation and work
  // preservation must already be complete before a retirement is recorded.
  const body = correlateEvent({
    event_id: eventId,
    state: state.phase,
    authority_epoch: state.authority_epoch,
    contract_revision: state.contract_revision,
    role: 'coordinator',
    type: 'runtime_record',
    payload: input
  })
  const attested = { ...body, coordinator_proof: coordinatorProof(body, token) }
  if (!verifyCoordinatorProof(state, attested)) throw Error('COORDINATOR_EVENT_KEY_BINDING_INVALID')
  const event = `${JSON.stringify({ ...attested, signature: createHmac('sha256', token).update(JSON.stringify(attested)).digest('hex') })}\n`
  const nextState = {
    ...state,
    ...(usage ? { token_ledger: nextTokenLedger(state, usage) } : {}),
    revision: nextControlRevision(state.revision)
  }
  commitControl(control, nextState, event, token)
  return { protocol: 'runtime-record/v1', eventId, id: input.id, action: input.action }
}

type Usage = Readonly<{ input_tokens: number; output_tokens: number; total_tokens: number }>

/** A usage record cites the host usage operation and non-negative integer token counts. */
function assertUsage(input: Record<string, unknown>): Usage {
  const usage = input.usage as Record<string, unknown> | undefined
  const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
  if (
    !usage ||
    usage.operation !== 'usage_read' ||
    !count(usage.input_tokens) ||
    !count(usage.output_tokens) ||
    !count(usage.total_tokens) ||
    Number(usage.total_tokens) < Number(usage.input_tokens) + Number(usage.output_tokens)
  )
    throw new Error('RUNTIME_USAGE_INVALID')
  return usage as Usage
}

/** Observed tokens per agent and in total; tokens per spent credit unit is derived, not configured. */
function nextTokenLedger(state: Record<string, unknown>, usage: Usage): Record<string, unknown> {
  const prior = (state.token_ledger ?? {}) as Record<string, unknown>
  const total = Number(prior.observed_total_tokens ?? 0) + usage.total_tokens
  const spent = Number((state.credit_ledger as Record<string, unknown> | undefined)?.spent ?? 0)
  return {
    protocol: 'token-ledger/v1',
    observed_total_tokens: total,
    records: Number(prior.records ?? 0) + 1,
    tokens_per_credit_unit: spent > 0 ? Math.round(total / spent) : null
  }
}
