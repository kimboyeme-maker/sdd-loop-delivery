import { createHash, createHmac } from 'node:crypto'
import { canonicalJson } from './wire/canonical-json'
import { rolePublicKey, signRoleEvent, verifyRoleEvent } from './role-signature'
import type { JournalSecurity } from './store/sidecar-transaction'
type Item = Record<string, unknown>

/**
 * Authenticate only a pending first-authority transaction while its state still
 * has no credential. This exception cannot rotate authority or alter product facts.
 */
export function verifyPendingBootstrap(
  stateBytes: Uint8Array,
  journalBytes: Uint8Array,
  token: string
): boolean {
  try {
    const state = JSON.parse(Buffer.from(stateBytes).toString('utf8')) as Item
    if (
      Object.hasOwn(state, 'coordinator_token_hash') ||
      state.phase !== 'DISCOVER' ||
      state.active_lease != null ||
      state.preparation != null ||
      !Number.isSafeInteger(state.authority_epoch) ||
      Number(state.authority_epoch) < 1 ||
      Number(state.authority_epoch) >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(state.revision) ||
      Number(state.revision) < 1 ||
      Number(state.revision) >= Number.MAX_SAFE_INTEGER
    )
      return false
    const journal = JSON.parse(Buffer.from(journalBytes).toString('utf8')) as Item
    const { proof, ...unsigned } = journal
    const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
    if (
      journal.protocol !== 'control-transaction/v2' ||
      journal.beforeState !== hash(stateBytes) ||
      proof !== createHmac('sha256', token).update(JSON.stringify(unsigned)).digest('hex') ||
      typeof journal.afterStateBytes !== 'string' ||
      typeof journal.appendedEventsBytes !== 'string'
    )
      return false
    const nextBytes = Buffer.from(journal.afterStateBytes, 'base64')
    const eventsBytes = Buffer.from(journal.appendedEventsBytes as string, 'base64')
    if (hash(nextBytes) !== journal.afterState || hash(eventsBytes) !== journal.appendedEvents)
      return false
    const epoch = Number(state.authority_epoch) + 1
    // The event-log binding is written by the commit itself; every other field is fixed.
    const { event_log: _prior, ...current } = state
    const expected = {
      ...current,
      coordinator_event_keys: { [String(epoch)]: rolePublicKey(token) },
      coordinator_token_hash: hash(token),
      authority_epoch: epoch,
      revision: Number(state.revision) + 1
    }
    const { event_log: _next, ...next } = JSON.parse(nextBytes.toString('utf8')) as Item
    if (canonicalJson(next) !== canonicalJson(expected)) return false
    const events = eventsBytes.toString('utf8')
    if (!events.endsWith('\n')) return false
    // The journal appends exactly the one authority event.
    if (events.indexOf('\n') !== events.length - 1) return false
    const event = JSON.parse(events) as Item
    const { signature, ...body } = event
    const payload = event.payload as Item | undefined
    return (
      event.role === 'coordinator' &&
      event.type === 'user_decision' &&
      event.state === state.phase &&
      event.contract_revision === state.contract_revision &&
      event.authority_epoch === epoch &&
      payload?.action === 'coordinator_auth_bootstrap' &&
      payload.user_authorized === true &&
      signature === createHmac('sha256', token).update(JSON.stringify(body)).digest('hex')
    )
  } catch {
    return false
  }
}

/** Verify a frozen transaction against the authority that approved it before rotation. */
export function verifyCoordinatorTransaction(
  state: Item,
  bytes: Uint8Array,
  proof: string
): boolean {
  try {
    const receipt = JSON.parse(proof) as Item
    if (
      receipt.protocol !== 'coordinator-transaction/v1' ||
      receipt.journal_sha256 !== createHash('sha256').update(bytes).digest('hex')
    )
      return false
    return verifyCoordinatorProof(state, receipt)
  } catch {
    return false
  }
}

/** Keep a takeover journal verifiable before and after the private credential changes. */
export function coordinatorTransactionSecurity(state: Item, token: string): JournalSecurity {
  const epoch = state.authority_epoch
  const keys = state.coordinator_event_keys as Item | undefined
  if (
    !Number.isSafeInteger(epoch) ||
    Number(epoch) < 1 ||
    keys?.[String(epoch)] !== rolePublicKey(token)
  )
    throw Error('COORDINATOR_TRANSACTION_KEY_MISMATCH')
  return {
    sign: (bytes) => {
      const body = {
        protocol: 'coordinator-transaction/v1',
        role: 'coordinator',
        authority_epoch: epoch,
        journal_sha256: createHash('sha256').update(bytes).digest('hex')
      }
      return JSON.stringify({ ...body, coordinator_proof: coordinatorProof(body, token) })
    },
    verify: (bytes, proof) => verifyCoordinatorTransaction(state, bytes, proof)
  }
}

/** Attach publicly verifiable evidence before the existing transaction signature is computed. */
export function coordinatorProof(body: Item, token: string): Item {
  if (
    body.role !== 'coordinator' ||
    Object.hasOwn(body, 'coordinator_proof') ||
    Object.hasOwn(body, 'signature')
  )
    throw Error('COORDINATOR_PROOF_BODY_INVALID')
  const signed = signRoleEvent(body, token)
  return { signature_algorithm: signed.signature_algorithm, signature: signed.signature }
}

/** Verify a decision against its frozen epoch key without exposing the signing credential. */
export function verifyCoordinatorProof(state: Item, event: Item): boolean {
  const epoch = event.authority_epoch
  if (event.role !== 'coordinator' || !Number.isSafeInteger(epoch) || Number(epoch) < 1)
    return false
  const keys = state.coordinator_event_keys
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return false
  const key = (keys as Item)[String(epoch)]
  const proof = event.coordinator_proof
  if (typeof key !== 'string' || !proof || typeof proof !== 'object' || Array.isArray(proof))
    return false
  const { signature: _transactionSignature, coordinator_proof: _proof, ...body } = event
  const signature = proof as Item
  if (Object.keys(signature).sort().join() !== 'signature,signature_algorithm') return false
  return verifyRoleEvent(
    { ...body, signature_algorithm: signature.signature_algorithm, signature: signature.signature },
    key
  )
}
