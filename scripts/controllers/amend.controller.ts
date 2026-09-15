import { leaseSlots } from '../helpers/lease-slots'
import { normativeSourceBinding } from '../helpers/source-binding'
import { nextControlRevision } from '../domain/policies/control-revision'
import { correlateEvent } from '../context/command-context'
import { createHash, randomUUID } from 'node:crypto'
import {
  COORDINATOR_TOKEN_ENV,
  commitControl,
  openCoordinatorCommand,
  signCoordinatorEvent
} from '../services/control-kernel'
import { amendedRequirementState } from '../domain/policies/amend-requirements'
import { requireAttemptConvergence } from '../helpers/attempt-convergence'
import { contractLineageFingerprint } from '../helpers/contract-scope'
import { collectLineageObligations } from '../services/lineage-obligations'
import { canonicalJson } from '../resource/wire/canonical-json'
import {
  contractScopeSnapshot,
  contractScopeDelta,
  requirementFingerprints
} from '../helpers/contract-scope'
import { readContractDocument } from '../services/contract-document'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TOKEN_ENV = COORDINATOR_TOKEN_ENV

/** Apply an explicitly identified contract amendment at an inactive safe point. */
export function amendContract(
  sdd: string,
  role: string,
  expectedState: string,
  expectedRevision: string,
  newDocument: string,
  newContractRevision: string,
  reason: string,
  token = process.env[TOKEN_ENV],
  options: {
    scopeChangeAuthorized?: boolean
    scopeChangeReason?: string | undefined
    lineageCorrection?: boolean
  } = {}
): Readonly<{ protocol: 'amend/v1'; eventId: string; contractRevision: string }> {
  if (role !== 'coordinator') throw new Error('AMEND_COORDINATOR_ONLY')
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  if (!reason.trim()) throw new Error('AMEND_REASON_REQUIRED')
  if (!newContractRevision.trim()) throw new Error('AMEND_CONTRACT_REVISION_REQUIRED')
  if (!existsSync(newDocument)) throw new Error('AMEND_DOCUMENT_NOT_FOUND')
  if (resolve(newDocument) !== resolve(sdd)) throw new Error('AMEND_DOCUMENT_BINDING_INVALID')
  // Terminal phases are rejected below with an amendment-specific code, so no mutable guard here.
  const control = openCoordinatorCommand(sdd, token, expectedState, expectedRevision, {
    mutable: false
  })
  const { state } = control
  const currentState = String(state.phase ?? '')
  if (leaseSlots(state as Record<string, unknown>).length > 0)
    throw new Error('AMEND_REQUIRES_NO_ACTIVE_LEASE')
  const events = control.events()
  requireAttemptConvergence(state, events, token)
  if (['SHIP', 'CANCELLED', 'BLOCKED'].includes(currentState))
    throw new Error('AMEND_TERMINAL_STATE_FORBIDDEN')
  const source = readFileSync(resolve(newDocument))
  const contract = readContractDocument(sdd, source.toString('utf8'))
  if (state.contract && !contract) throw new Error('AMEND_CONTRACT_REQUIRED')
  if (contract && contract.revision !== newContractRevision)
    throw new Error('AMEND_CONTRACT_REVISION_MISMATCH')
  if (!contract) throw new Error('AMEND_CONTRACT_REQUIRED')
  const nextLineage = contractLineageFingerprint(contract)
  const lineageObligations = collectLineageObligations(sdd, contract)
  const lineageChanged =
    state.lineage_fingerprint != null && state.lineage_fingerprint !== nextLineage
  const emptyLedger = (value: unknown) =>
    value == null ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
  const correctionAllowed =
    options.lineageCorrection === true &&
    ['DISCOVER', 'CONTRACT_DRAFT', 'CONTRACT_AMENDED'].includes(currentState) &&
    ['issued_leases', 'requirement_evidence', 'findings', 'last_role_events'].every((field) =>
      emptyLedger(state[field])
    ) &&
    [
      'completed_attempts',
      'operator_invocations',
      'architect_invocations',
      'design_counsel_invocations'
    ].every((field) => (state[field] ?? 0) === 0)
  if (lineageChanged && !correctionAllowed) throw new Error('LINEAGE_IMMUTABLE_AFTER_INIT')
  const nextScope = contractScopeSnapshot(contract)
  const scopeDelta = contractScopeDelta(state.contract_scope_snapshot, nextScope)
  if (
    Object.keys(scopeDelta).length &&
    (options.scopeChangeAuthorized !== true || !options.scopeChangeReason?.trim())
  )
    throw new Error('SCOPE_CHANGE_REQUIRES_USER_AUTHORIZATION')
  const fingerprint = createHash('sha256').update(source).digest('hex')
  if (fingerprint === state.sdd_fingerprint) throw new Error('AMEND_DOCUMENT_UNCHANGED')
  // Revision is part of historical role evidence. Reusing a previous label for
  // different bytes would make an old lease appear current again.
  if (state.protocol === 'control-plane/state-v2') {
    const leases =
      state.issued_leases && typeof state.issued_leases === 'object'
        ? Object.values(state.issued_leases)
        : []
    if (
      newContractRevision === state.contract_revision ||
      (Array.isArray(state.contract_revision_history) &&
        state.contract_revision_history.includes(newContractRevision)) ||
      leases.some(
        (lease) =>
          lease &&
          typeof lease === 'object' &&
          (lease as Record<string, unknown>).contract_revision === newContractRevision
      ) ||
      events.some(
        (event) =>
          event.type === 'contract_amendment' &&
          (event.payload as Record<string, unknown> | undefined)?.contract_revision ===
            newContractRevision
      )
    )
      throw new Error('AMEND_CONTRACT_REVISION_REUSED')
  }
  const contractVersion = state.contract_version ?? 0
  if (
    !Number.isSafeInteger(contractVersion) ||
    Number(contractVersion) < 0 ||
    Number(contractVersion) >= Number.MAX_SAFE_INTEGER
  )
    throw new Error('CONTRACT_VERSION_INVALID')
  const eventId = `EVT-${randomUUID()}`
  const body = correlateEvent({
    event_id: eventId,
    state: 'CONTRACT_AMENDED',
    authority_epoch: state.authority_epoch,
    contract_revision: newContractRevision,
    role: 'coordinator',
    type: 'contract_amendment',
    payload: {
      revoked_prepared_id:
        (state.preparation as Record<string, unknown> | undefined)?.prepared_id ?? null,
      from: state.contract_revision,
      to: newContractRevision,
      previous_fingerprint: state.sdd_fingerprint ?? null,
      new_fingerprint: fingerprint,
      contract_revision: newContractRevision,
      reason,
      lineage_correction: lineageChanged,
      lineage_correction_basis: lineageChanged
        ? 'pre-delivery; no role lease, invocation, attempt, finding, or requirement evidence'
        : null,
      scope_delta: scopeDelta,
      scope_change_user_authorized: Object.keys(scopeDelta).length > 0,
      scope_change_reason: Object.keys(scopeDelta).length ? options.scopeChangeReason : null
    }
  })
  const event = signCoordinatorEvent(state, body, token)
  const nextState = {
    ...state,
    // Frozen preparation belongs to the previous contract; revoke in the same transaction.
    preparation: null,
    sdd_fingerprint: fingerprint,
    normative_sources: normativeSourceBinding(sdd, source),
    contract_revision: newContractRevision,
    contract_version: Number(contractVersion) + 1,
    lineage_fingerprint: nextLineage,
    lineage_obligations: lineageObligations,
    lineage_evidence_fingerprint: createHash('sha256')
      .update(canonicalJson(lineageObligations))
      .digest('hex'),
    ...(lineageChanged ? { pending_user_decision: null } : {}),
    contract_scope_snapshot: nextScope,
    requirement_fingerprints: requirementFingerprints(contract),
    updated_at: new Date().toISOString(),
    contract_revision_history: [
      ...new Set(
        [
          ...(Array.isArray(state.contract_revision_history)
            ? state.contract_revision_history
            : []),
          state.contract_revision,
          newContractRevision
        ].filter((revision): revision is string => typeof revision === 'string')
      )
    ],
    phase: 'CONTRACT_AMENDED',
    ...(contract
      ? {
          contract,
          ...amendedRequirementState(state, contract),
          requirement_kinds: Object.fromEntries(
            contract.requirements.map((req) => [req.id, req.kind])
          )
        }
      : {}),
    revision: nextControlRevision(state.revision)
  }
  commitControl(control, nextState, event, token)
  return { protocol: 'amend/v1', eventId, contractRevision: newContractRevision }
}
