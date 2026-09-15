import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { assertProductRoleHistory } from '../domain/policies/role-history'
import { roleCapabilityToken } from '../resource/role-capability'
import { currentAdmission } from './admission-authority'
import { assertDesignIndependence } from './design-independence'
import { preparationBootstrapCount } from './preparation-bootstrap'

type Item = Record<string, unknown>

/**
 * Complete authority of one Architect preparation grant, checked before it records or runs
 * anything: the grant and runtime, the current admission, role history and design independence,
 * the authority epoch, a live phase, the unchanged source, and the minted credential.
 */
export function authorizePreparation(
  sdd: string,
  state: Item,
  events: readonly Item[],
  input: Readonly<{
    agentId: string
    preparedId: string
    expectedState: string
    coordinatorToken: string | undefined
  }>
): Readonly<{ grant: Item; agentToken: string }> {
  const grant = state.preparation as Item | null | undefined
  if (
    !grant ||
    typeof grant !== 'object' ||
    grant.prepared_id !== input.preparedId ||
    grant.agent_id !== input.agentId
  )
    throw new Error('PREPARATION_GRANT_INVALID')
  if (grant.admission_event_id !== currentAdmission(state, events, input.coordinatorToken).event_id)
    throw new Error('PREPARATION_ADMISSION_STALE')
  assertProductRoleHistory(state, events, input.agentId, 'architect')
  assertDesignIndependence(state, events, input.agentId)
  // Phase advancement alone does not expire preparation, but authority changes do.
  if (
    !Number.isSafeInteger(grant.authority_epoch) ||
    Number(grant.authority_epoch) < 1 ||
    grant.authority_epoch !== state.authority_epoch
  )
    throw new Error('PREPARATION_EPOCH_STALE')
  if (['PAUSED', 'CANCELLED', 'SHIP', 'BLOCKED'].includes(input.expectedState))
    throw new Error('PREPARATION_STATE_INVALID')
  if (
    grant.contract_revision !== (state.contract_revision ?? null) ||
    grant.source_sha256 !== createHash('sha256').update(readFileSync(sdd)).digest('hex')
  )
    throw new Error('PREPARATION_SOURCE_STALE')
  let agentToken: string | undefined
  try {
    agentToken = roleCapabilityToken(grant)
  } catch {
    agentToken = undefined
  }
  if (
    typeof grant.agent_token_hash !== 'string' ||
    !agentToken ||
    createHash('sha256').update(agentToken).digest('hex') !== grant.agent_token_hash
  )
    throw new Error('PREPARATION_AGENT_AUTH_REQUIRED')
  return { grant, agentToken }
}

/** Prepared checks and runs need the authenticated three-process bootstrap and completed reading. */
export function assertPreparationReady(state: Item, grant: Item, events: readonly Item[]): void {
  if (
    preparationBootstrapCount(state, grant, events) !== 3 ||
    typeof grant.ready_event_id !== 'string'
  )
    throw new Error('PREPARATION_READINESS_REQUIRED')
}
