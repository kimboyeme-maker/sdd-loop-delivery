import { eventsOfType, eventsWithId } from '../utils/event-index'
import { shardLeases } from '../helpers/lease-slots'
import { assertRoleEvidence } from '../helpers/role-evidence'
import { assertRoleReceipt } from '../schemas/role-receipt'
import { verifyCoordinatorProof } from '../resource/coordinator-evidence'
import { creditLedger } from '../helpers/credit-ledger'
import { correlateEvent } from '../context/command-context'
import { createHmac, randomUUID } from 'node:crypto'
import {
  COORDINATOR_TOKEN_ENV,
  commitControl,
  openCoordinatorCommand,
  signCoordinatorEvent
} from '../services/control-kernel'

const TOKEN_ENV = COORDINATOR_TOKEN_ENV

/** Apply explicit Coordinator-mediated pause, resume, or cancellation. */
export function userControl(
  sdd: string,
  role: string,
  expectedState: string,
  expectedRevision: string,
  action: string,
  reason: string,
  authorized: string,
  writerStopped?: string,
  checkpoint?: string,
  token = process.env[TOKEN_ENV],
  creditAmount?: number
): Readonly<{ protocol: 'user-control/v1'; eventId: string; action: string; state: string }> {
  if (role !== 'coordinator') throw new Error('ROLE_USER_CONTROL_FORBIDDEN')
  if (authorized !== 'yes') throw new Error('USER_CONTROL_REQUIRES_USER_AUTHORIZATION')
  if (!reason.trim()) throw new Error('USER_CONTROL_REASON_REQUIRED')
  if (!token) throw new Error('COORDINATOR_AUTH_REQUIRED')
  if (!new Set(['pause', 'resume', 'cancel', 'extend-credit']).has(action))
    throw new Error('USER_CONTROL_ACTION_INVALID')
  // Pause, resume and cancel are the only writers allowed on a paused loop: no mutable guard.
  const control = openCoordinatorCommand(sdd, token, expectedState, expectedRevision, {
    mutable: false
  })
  const { state } = control
  const before = String(state.phase ?? '')
  const lease = state.active_lease
  const preparation = state.preparation as Record<string, unknown> | null | undefined
  if (action === 'pause') {
    if (['SHIP', 'CANCELLED', 'PAUSED', 'BLOCKED'].includes(before))
      throw new Error('USER_CONTROL_PAUSE_STATE_INVALID')
    if (lease != null && (writerStopped !== 'yes' || !checkpoint?.trim()))
      throw new Error('USER_CONTROL_SAFE_CHECKPOINT_REQUIRED')
    if (lease != null) {
      const active = lease as Record<string, unknown>
      const matches = eventsWithId(control.events(), checkpoint)
      const receipt = matches[0]
      const actor = receipt?.actor as Record<string, unknown> | undefined
      const payload = receipt?.payload as Record<string, unknown> | undefined
      if (
        matches.length !== 1 ||
        !receipt ||
        receipt.type !== 'checkpoint' ||
        receipt.state !== before ||
        receipt.contract_revision !== state.contract_revision ||
        receipt.role !== active.role ||
        actor?.lease_id !== active.lease_id ||
        actor?.agent_id !== active.agent_id ||
        payload?.status !== 'SAFE_TO_RESUME'
      )
        throw new Error('USER_CONTROL_SAFE_CHECKPOINT_REQUIRED')
      // An ID alone is not recovery evidence: authenticate the exact role receipt before revocation.
      assertRoleEvidence(state, receipt, String(active.role))
      assertRoleReceipt('checkpoint', payload)
    } else if (checkpoint) throw new Error('USER_CONTROL_CHECKPOINT_WITHOUT_ACTIVE_LEASE')
    // Concurrent final-verification shards write no product files but must be stopped too.
    if (Object.keys(shardLeases(state)).length && writerStopped !== 'yes')
      throw new Error('USER_CONTROL_WRITER_STOP_REQUIRED')
    state.paused_from = before
    state.pause_checkpoint_id = checkpoint ?? null
    state.active_lease = null
    state.shard_leases = {}
    state.phase = 'PAUSED'
  } else if (action === 'resume') {
    if (before !== 'PAUSED' || lease != null || Object.keys(shardLeases(state)).length)
      throw new Error('USER_CONTROL_RESUME_STATE_INVALID')
    const target = state.paused_from
    if (typeof target !== 'string' || !target || target === 'PAUSED')
      throw new Error('USER_CONTROL_RESUME_TARGET_INVALID')
    // The saved target is a cache, not permission to choose a new phase. Recover
    // only the phase attested by the most recent authenticated pause decision.
    const decisions = eventsOfType(control.events(), 'user_decision')
    const pause = decisions.at(-1)
    if (!pause) throw new Error('USER_CONTROL_PAUSE_EVIDENCE_REQUIRED')
    const { signature, ...body } = pause
    const decision = pause.payload as Record<string, unknown> | undefined
    if (
      pause.role !== 'coordinator' ||
      decision?.action !== 'pause' ||
      decision.to !== 'PAUSED' ||
      decision.from !== target ||
      !(Object.hasOwn(pause, 'coordinator_proof')
        ? verifyCoordinatorProof(state, pause)
        : signature === createHmac('sha256', token).update(JSON.stringify(body)).digest('hex'))
    )
      throw new Error('USER_CONTROL_PAUSE_EVIDENCE_INVALID')
    state.phase = target
    state.paused_from = null
  } else if (action === 'extend-credit') {
    // Only the user can raise the spend ceiling; the phase and any active lease are untouched.
    if (['SHIP', 'CANCELLED', 'BLOCKED'].includes(before))
      throw new Error('USER_CONTROL_CREDIT_STATE_INVALID')
    if (!Number.isSafeInteger(creditAmount) || Number(creditAmount) < 1)
      throw new Error('USER_CONTROL_CREDIT_AMOUNT_INVALID')
    const ledger = creditLedger(state)
    if (!ledger) throw new Error('CREDIT_LEDGER_ABSENT')
    state.credit_ledger = { ...ledger, budget: ledger.budget + Number(creditAmount) }
  } else {
    if (['SHIP', 'CANCELLED'].includes(before)) throw new Error('USER_CONTROL_CANCEL_STATE_INVALID')
    if ((lease != null || Object.keys(shardLeases(state)).length) && writerStopped !== 'yes')
      throw new Error('USER_CONTROL_WRITER_STOP_REQUIRED')
    state.active_lease = null
    state.shard_leases = {}
    state.phase = 'CANCELLED'
    state.paused_from = null
    state.pause_checkpoint_id = null
  }
  const revokes = !['resume', 'extend-credit'].includes(action)
  if (revokes) state.preparation = null
  if (
    !Number.isSafeInteger(state.revision) ||
    Number(state.revision) < 0 ||
    Number(state.revision) >= Number.MAX_SAFE_INTEGER
  )
    throw new Error('CONTROL_REVISION_INVALID')
  state.revision = Number(state.revision) + 1
  const eventId = `EVT-${randomUUID()}`
  const decisionBody = correlateEvent({
    event_id: eventId,
    role: 'coordinator',
    type: 'user_decision',
    authority_epoch: state.authority_epoch,
    contract_revision: state.contract_revision,
    payload: {
      action,
      from: before,
      to: state.phase,
      reason,
      user_authorized: true,
      writer_stopped: writerStopped === 'yes',
      checkpoint_id: checkpoint ?? null,
      revoked_prepared_id: revokes ? (preparation?.prepared_id ?? null) : null,
      ...(action === 'extend-credit' ? { credit_amount: creditAmount } : {})
    }
  })
  // A pause can outlive its Coordinator. Keep epoch-verifiable evidence when the
  // transaction credential rotates.
  const event = signCoordinatorEvent(state, decisionBody, token, {
    proof: true,
    requireKeyBinding: false
  })
  commitControl(control, state, event, token)
  return { protocol: 'user-control/v1', eventId, action, state: String(state.phase) }
}
