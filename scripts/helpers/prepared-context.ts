import { eventsWithId } from '../utils/event-index'
import { preparationBootstrapCount } from './preparation-bootstrap'
import { verifyRoleEvent } from '../resource/role-signature'
import { canonicalJson } from '../resource/wire/canonical-json'
import { createHash } from 'node:crypto'
type Item = Record<string, unknown>

/** Preparation is an optional optimization: invalid evidence falls back to ordinary startup. */
export function preparedContext(
  sdd: string,
  state: Item,
  events: readonly Item[],
  agentId: string,
  preparedId: string | undefined,
  admissionId: unknown
): Item | null {
  if (!preparedId) return null
  try {
    const grant = state.preparation as Item | null
    if (
      !grant ||
      grant.prepared_id !== preparedId ||
      grant.agent_id !== agentId ||
      grant.role !== 'architect' ||
      grant.authority_epoch !== state.authority_epoch ||
      grant.contract_revision !== state.contract_revision ||
      grant.source_sha256 !== state.sdd_fingerprint ||
      grant.admission_event_id !== admissionId ||
      typeof grant.capability_file !== 'string'
    )
      return null
    if (preparationBootstrapCount(state, grant, events) !== 3) return null
    const matches = eventsWithId(events, grant.ready_event_id)
    const event = matches[0]
    const actor = event?.actor as Item | undefined
    const payload = event?.payload as Item | undefined
    if (
      matches.length !== 1 ||
      !event ||
      event.type !== 'context_ready' ||
      event.role !== 'architect' ||
      actor?.agent_id !== agentId ||
      actor?.prepared_id !== preparedId ||
      actor?.authority_epoch !== state.authority_epoch ||
      event.contract_revision !== state.contract_revision ||
      !verifyRoleEvent(event, String(grant.event_public_key)) ||
      typeof payload?.read_result !== 'string'
    )
      return null
    const reading = payload.reading as Item | undefined
    const snapshot = grant.context_snapshot as Item | undefined
    if (
      !reading ||
      !snapshot ||
      typeof snapshot.text !== 'string' ||
      reading.protocol !== 'context-read-evidence/v1' ||
      reading.context_fingerprint !== snapshot.fingerprint ||
      reading.content_sha256 !== createHash('sha256').update(snapshot.text).digest('hex') ||
      canonicalJson(reading.sources) !== canonicalJson(snapshot.sources)
    )
      return null
    // The prepared runtime keeps the capability it already holds; formal dispatch
    // transfers it to the lease in the same commit that retires the grant.
    return {
      capability_file: grant.capability_file,
      agent_token_hash: grant.agent_token_hash,
      event_public_key: grant.event_public_key,
      prepared_id: preparedId,
      prepared_event_id: event.event_id,
      prepared_read_result: payload.read_result,
      prepared_grant: {
        prepared_id: preparedId,
        agent_id: agentId,
        authority_epoch: grant.authority_epoch,
        contract_revision: grant.contract_revision,
        event_public_key: grant.event_public_key,
        admission_event_id: grant.admission_event_id,
        ready_event_id: event.event_id
      }
    }
  } catch {
    return null
  }
}
