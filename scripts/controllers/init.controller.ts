import { normativeSourceBinding } from '../helpers/source-binding'
import { correlateEvent } from '../context/command-context'
import { readProgramBinding } from '../resource/program-store'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { decodeState, sidecarPaths } from '../resource/state'
import { resolve } from 'node:path'
import { dirname } from 'node:path'
import { readContractDocument } from '../services/contract-document'
import { contractLineageFingerprint } from '../helpers/contract-scope'
import { collectLineageObligations } from '../services/lineage-obligations'
import { canonicalJson } from '../resource/wire/canonical-json'
import { eventLogBinding } from '../resource/store/event-log-binding'
import { acquireControlLock } from '../resource/store/control-lock'
import { DEFAULT_CREDIT_BUDGET_PER_ROUND } from '../config/constants'
import { contractScopeSnapshot, requirementFingerprints } from '../helpers/contract-scope'

/** Publish one private initialization file durably. The initial_event marker coordinates
 * the state/event pair across crashes; this primitive alone is not a two-file transaction.
 */
function atomic(path: string, value: string): void {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  const file = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(file, value)
    fsyncSync(file)
  } finally {
    closeSync(file)
  }
  renameSync(temporary, path)
  const directory = openSync(dirname(path), 'r')
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

/** Finish only the initial publication; never replay authenticated delivery work. */
function finishInitialization(
  paths: ReturnType<typeof sidecarPaths>,
  state: Record<string, unknown>
): Record<string, unknown> {
  const pending = state.initial_event
  if (pending === undefined) return state
  if (
    typeof pending !== 'string' ||
    state.phase !== 'DISCOVER' ||
    state.revision !== 1 ||
    state.active_lease !== null ||
    state.coordinator_token_hash !== undefined
  )
    throw new Error('INIT_PENDING_STATE_INVALID')
  const event = JSON.parse(pending)
  if (
    event.type !== 'project_context' ||
    event.payload?.action !== 'init' ||
    event.role !== 'coordinator'
  )
    throw new Error('INIT_PENDING_EVENT_INVALID')
  const existing = existsSync(paths.events) ? readFileSync(paths.events, 'utf8') : ''
  if (existing && existing !== pending) throw new Error('INIT_EVENT_LOG_CONFLICT')
  if (!existing) atomic(paths.events, pending)
  const { initial_event: _pending, ...unbound } = state
  // The first committed state already binds the event log it was published with.
  const complete = { ...unbound, event_log: eventLogBinding(Buffer.from(pending)) }
  atomic(paths.state, JSON.stringify(complete))
  return complete
}

/** Publish an unprivileged initial state and its event with restartable progress.
 * Existing native state is resumed, never reset. Design-declared completion is not
 * imported as runtime evidence; auth-bootstrap establishes authority separately.
 * maxRounds limits rounds (1..20), not the six attempts allowed within each round.
 */
export function initLoop(
  sdd: string,
  maxRounds: number,
  creditBudget = maxRounds * DEFAULT_CREDIT_BUDGET_PER_ROUND,
  creditMode: 'observe' | 'enforce' = 'observe'
): Readonly<Record<string, unknown>> {
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 20)
    throw new Error('MAX_ROUNDS_INVALID')
  if (creditMode !== 'observe' && creditMode !== 'enforce')
    throw new Error('INIT_CREDIT_MODE_INVALID')
  if (!Number.isSafeInteger(creditBudget) || creditBudget < 1)
    throw new Error('CREDIT_BUDGET_INVALID')
  if (!existsSync(sdd)) throw new Error('SDD_NOT_FOUND')
  const paths = sidecarPaths(sdd)
  const canonicalSdd = resolve(sdd)
  const lock = acquireControlLock(paths.lock)
  try {
    if (existsSync(paths.state))
      return finishInitialization(
        paths,
        decodeState(JSON.parse(readFileSync(paths.state, 'utf8')), true)
      )
    if (existsSync(paths.events) && readFileSync(paths.events, 'utf8'))
      throw new Error('INIT_EVENT_LOG_WITHOUT_STATE_INVALID')
    const source = readFileSync(canonicalSdd)
    const contract = readContractDocument(canonicalSdd, source.toString('utf8'))
    const lineageObligations = contract ? collectLineageObligations(canonicalSdd, contract) : []
    const programBinding = readProgramBinding(canonicalSdd)
    const state = {
      protocol: 'control-plane/state-v2',
      ...(programBinding ? { program_binding: programBinding } : {}),
      sdd: canonicalSdd,
      normative_sources: normativeSourceBinding(canonicalSdd, source),
      sdd_fingerprint: createHash('sha256').update(source).digest('hex'),
      ...(contract
        ? {
            contract,
            contract_revision: contract.revision,
            lineage_fingerprint: contractLineageFingerprint(contract),
            contract_scope_snapshot: contractScopeSnapshot(contract),
            requirement_fingerprints: requirementFingerprints(contract),
            // Design-declared status is not implementation or independent verification evidence.
            requirements: Object.fromEntries(
              contract.requirements.map((req) => [req.id, 'pending'])
            ),
            requirement_kinds: Object.fromEntries(
              contract.requirements.map((req) => [req.id, req.kind])
            )
          }
        : {}),
      phase: 'DISCOVER',
      lineage_obligations: lineageObligations,
      lineage_evidence_fingerprint: createHash('sha256')
        .update(canonicalJson(lineageObligations))
        .digest('hex'),
      logical_round: 1,
      max_rounds: maxRounds,
      authority_epoch: 1,
      revision: 1,
      active_lease: null,
      completed_attempts: 0,
      round_completed_attempts: 0,
      contract_version: 0,
      operator_invocations: 0,
      architect_invocations: 0,
      design_counsel_invocations: 0,
      pipeline_repair_probe_invocations: 0,
      consecutive_stagnant_attempts: 0,
      consecutive_architect_rejections: 0,
      consecutive_execution_failures: 0,
      total_execution_failures: 0,
      last_execution_failure_root: null,
      pending_execution_failure: null,
      execution_failure_roots: {},
      pipeline_incidents: 0,
      pipeline_incident_roots: {},
      pipeline_repair_candidate_hashes: {},
      pending_pipeline_repair: null,
      execution_substrate_required: null,
      last_execution_substrate_receipt: null,
      preparation: null,
      agent_roles: {},
      issued_leases: {},
      last_role_events: {},
      requirement_evidence: {},
      findings: {},
      pending_user_decision: null,
      credit_ledger: {
        protocol: 'credit-ledger/v1',
        budget: creditBudget,
        spent: 0,
        mode: creditMode
      },
      paused_from: null,
      pause_checkpoint_id: null,
      updated_at: new Date().toISOString()
    }
    const event =
      JSON.stringify(
        correlateEvent({
          protocol: 'control-plane/event-v2',
          role: 'coordinator',
          type: 'project_context',
          payload: { action: 'init' }
        })
      ) + '\n'
    // Before authentication exists, persist the exact initial event with state.
    // A restart can finish publication without guessing or deleting event history.
    const pending = { ...state, initial_event: event }
    atomic(paths.state, JSON.stringify(pending))
    return finishInitialization(paths, pending)
  } finally {
    closeSync(lock)
    unlinkSync(paths.lock)
  }
}
