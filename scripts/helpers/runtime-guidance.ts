import { eventsWithId } from '../utils/event-index'
import { findLease } from './lease-slots'
import { createHmac } from 'node:crypto'
import { canonicalJson } from '../resource/wire/canonical-json'
import { assertCurrentSource } from './source-binding'
import { assertProductRoleHistory } from '../domain/policies/role-history'
import { assertRoleEvidence } from './role-evidence'
import { currentAdmission } from './admission-authority'
import roles from '../../agents/roles.json'
type Item = Record<string, unknown>
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : undefined

/** Validate actionable guidance without letting it redefine design, scope or role authority. */
export function assertRuntimeGuidance(
  sdd: string,
  state: Item,
  events: readonly Item[],
  input: Item,
  token: string
): void {
  if (input.action !== 'guidance') return
  assertCurrentSource(state, sdd)
  if (!['operator', 'architect'].includes(String(input.agent_role)))
    throw new Error('RUNTIME_ROLE_INVALID')
  if (
    ['SHIP', 'BLOCKED', 'CANCELLED', 'PAUSED'].includes(String(state.phase)) ||
    state.paused_from != null
  )
    throw new Error('GUIDANCE_PRODUCT_NOT_ACTIVE')
  assertProductRoleHistory(
    state,
    events,
    String(input.agent_id),
    input.agent_role as 'operator' | 'architect'
  )
  if (
    input.contract_revision !== state.contract_revision ||
    input.sdd_fingerprint !== state.sdd_fingerprint ||
    !text(input.work_item)
  )
    throw new Error('GUIDANCE_BINDING_INVALID')
  const active = input.lease_id
    ? findLease(state, String(input.lease_id))
    : object(state.active_lease)
  if (
    input.lease_id &&
    (!active ||
      active.lease_id !== input.lease_id ||
      active.agent_id !== input.agent_id ||
      (active.packet_id ?? null) !== (input.packet_id ?? null) ||
      active.work_item !== input.work_item ||
      active.role !== input.agent_role)
  )
    throw new Error('GUIDANCE_ACTIVE_LEASE_MISMATCH')
  const guidance = object(input.guidance)
  if (
    !guidance ||
    !text(guidance.outcome) ||
    ['steps', 'checks', 'checkpoint_triggers', 'stop_conditions'].some(
      (key) => !texts(guidance[key]) || !guidance[key].length
    ) ||
    ['preserve', 'basis_event_ids', 'finding_ids', 'modification_packages'].some(
      (key) => !texts(guidance[key])
    )
  )
    throw new Error('GUIDANCE_CONTENT_INVALID')
  if (input.agent_role === 'operator') {
    const profile = input.operator_profile ?? roles.roles.operator.default_profile
    if (
      input.lease_id &&
      profile !== (active?.operator_profile ?? roles.roles.operator.default_profile)
    )
      throw new Error('OPERATOR_PROFILE_GUIDANCE_MISMATCH')
    if (!Object.hasOwn(roles.roles.operator.profiles, String(profile)))
      throw new Error('OPERATOR_PROFILE_INVALID')
    const basis = object(input.profile_basis)
    if (profile === 'bounded') {
      if (
        !basis ||
        basis.route !== 'BOUNDED_MECHANICAL' ||
        ['exact_write_paths', 'deterministic_checks', 'evidence'].some(
          (key) => !texts(basis[key]) || !basis[key].length
        ) ||
        !Array.isArray(basis.disqualifiers) ||
        basis.disqualifiers.length
      )
        throw new Error('BOUNDED_OPERATOR_PROFILE_BASIS_REQUIRED')
    } else if (input.profile_basis != null)
      throw new Error('STANDARD_OPERATOR_PROFILE_BASIS_UNEXPECTED')
  } else if (Object.hasOwn(input, 'operator_profile') || Object.hasOwn(input, 'profile_basis'))
    throw new Error('ARCHITECT_OPERATOR_PROFILE_FORBIDDEN')
  const scope =
    input.agent_role === 'architect'
      ? []
      : input.lease_id
        ? active?.scope
        : (currentAdmission(state, events, token).payload as Item).modification_packages
  if (
    !texts(scope) ||
    canonicalJson([...(guidance.modification_packages as string[])].sort()) !==
      canonicalJson([...scope].sort())
  )
    throw new Error('GUIDANCE_MODIFICATION_SCOPE_MISMATCH')
  for (const id of guidance.basis_event_ids as string[]) {
    const matches = eventsWithId(events, id)
    const event = matches[0]
    if (matches.length !== 1 || !event) throw new Error('GUIDANCE_BASIS_INVALID')
    if (event.role === 'coordinator') {
      const { signature, ...body } = event
      if (signature !== createHmac('sha256', token).update(JSON.stringify(body)).digest('hex'))
        throw new Error('GUIDANCE_BASIS_INVALID')
    } else assertRoleEvidence(state, event, String(event.role))
  }
  if (
    (guidance.finding_ids as string[]).some(
      (id) => !Object.hasOwn(object(state.findings) ?? {}, id)
    )
  )
    throw new Error('GUIDANCE_FINDING_UNKNOWN')
}
