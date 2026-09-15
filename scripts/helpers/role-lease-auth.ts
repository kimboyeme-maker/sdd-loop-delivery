import { createHash } from 'node:crypto'
import { assertActiveLease } from '../domain/policies/active-lease'
import { roleCapabilityToken } from '../resource/role-capability'
import { rolePublicKey } from '../resource/role-signature'
import { findLease } from './lease-slots'
import { assertStartedEvidence } from './started-evidence'

type Item = Record<string, unknown>

/** Event types a runtime may record before its read-backed start. */
const PRE_START_TYPES = new Set(['capability_probe', 'checkpoint'])

/**
 * Complete role authority for one lease-bound action, checked before the action takes effect:
 * the lease, its credential, a proven start, an unexpired deadline and the signing key. Every
 * entry that acts for a role (evidence recording and controller-timed execution) uses this one
 * check, so an action is never performed first and authorized afterwards.
 */
export function authorizeRoleLease(
  state: Item,
  events: readonly Item[],
  input: Readonly<{
    agent: string
    agentId: string
    leaseId: string
    agentToken: string | undefined
    type: string
  }>
): Readonly<{ lease: Item; credential: string }> {
  const lease = findLease(state, input.leaseId)
  if (!lease || lease.agent_id !== input.agentId || lease.role !== input.agent)
    throw new Error('AGENT_LEASE_MISMATCH')
  // CLI roles authenticate through their private capability file; callers may pass it directly.
  const credential = input.agentToken ?? roleCapabilityToken(lease)
  if (lease.agent_token_hash !== createHash('sha256').update(credential).digest('hex'))
    throw new Error('AGENT_TOKEN_INVALID')
  const started = !PRE_START_TYPES.has(input.type)
  if (started && !lease.started_event_id) throw new Error('AGENT_NOT_STARTED')
  assertActiveLease(state, lease)
  if (started) assertStartedEvidence(state, lease, events)
  if (lease.repair_probe_root) throw new Error('PIPELINE_PROBE_REQUIRES_BOOTSTRAP')
  // Native leases always bind an Ed25519 key; never downgrade evidence to HMAC.
  if (typeof lease.event_public_key !== 'string' || !lease.event_public_key)
    throw new Error('AGENT_EVENT_KEY_REQUIRED')
  if (lease.event_public_key !== rolePublicKey(credential))
    throw new Error('AGENT_EVENT_KEY_MISMATCH')
  return { lease, credential }
}

/** Whole seconds left before the lease's hard deadline; never negative. */
export function leaseSecondsRemaining(lease: Item, now = Date.now()): number {
  const issued = Date.parse(String(lease.issued_at))
  const minutes = Number(lease.hard_deadline_minutes)
  return Math.max(0, Math.floor((issued + minutes * 60_000 - now) / 1000))
}
