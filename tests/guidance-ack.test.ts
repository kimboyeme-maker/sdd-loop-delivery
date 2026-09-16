import { expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { canonicalJson } from '../scripts/resource/wire/canonical-json'
import { currentGuidance, guidanceAck, requireGuidanceAck } from '../scripts/helpers/guidance-ack'

type Item = Record<string, unknown>
const TOKEN = 'coordinator-token'

const state: Item = { contract_revision: 'SDD-v1', sdd_fingerprint: 'fp-1' }
const lease: Item = {
  lease_id: 'L1',
  agent_id: 'A1',
  authority_epoch: 1,
  packet_id: 'PC01',
  work_item: 'implement',
  role: 'operator'
}

/** A Coordinator guidance event signed the way the controller signs one without an epoch proof. */
function guidance(overrides: Item = {}, id = 'EVT-1'): Item {
  const payload: Item = {
    action: 'guidance',
    lease_id: lease.lease_id,
    agent_id: lease.agent_id,
    authority_epoch: lease.authority_epoch,
    contract_revision: state.contract_revision,
    sdd_fingerprint: state.sdd_fingerprint,
    packet_id: lease.packet_id,
    work_item: lease.work_item,
    ...overrides
  }
  const body = { event_id: id, type: 'runtime_record', role: 'coordinator', payload }
  return {
    ...body,
    signature: createHmac('sha256', TOKEN).update(JSON.stringify(body)).digest('hex')
  }
}

/** The acknowledgment a role owes for one binding. */
const answer = {
  next_action: 'implement the admitted batch',
  check_method: 'run the acceptance command',
  stop_condition: 'the case passes or a Finding is recorded'
}

test('a lease with no guidance has no binding, and an acknowledgment is then unexpected', () => {
  const bare = { ...lease }
  delete bare.guidance_id
  expect(currentGuidance(state, [], bare, TOKEN)).toBeNull()
  expect(() => requireGuidanceAck(state, [], bare, TOKEN, { guidance_ack: answer })).toThrow(
    'GUIDANCE_ACK_UNEXPECTED'
  )
})

test('a bound guidance that cannot be authenticated is stale, not absent', () => {
  const bound = { ...lease, guidance_id: 'EVT-1' }
  expect(() => currentGuidance(state, [], bound, TOKEN)).toThrow('GUIDANCE_BINDING_STALE')
  // Present but signed with another token: still unauthenticated, so still stale.
  const forged = { ...guidance(), signature: 'wrong' }
  expect(() => currentGuidance(state, [forged], bound, TOKEN)).toThrow('GUIDANCE_BINDING_STALE')
})

test('guidance bound to another assignment is stale', () => {
  const bound = { ...lease, guidance_id: 'EVT-1' }
  for (const drift of [{ work_item: 'verify' }, { packet_id: 'PC02' }, { authority_epoch: 2 }])
    expect(() => currentGuidance(state, [guidance(drift)], bound, TOKEN)).toThrow(
      'GUIDANCE_BINDING_STALE'
    )
})

test('a response missing any of the three fields is rejected', () => {
  const binding = currentGuidance(state, [guidance()], { ...lease, guidance_id: 'EVT-1' }, TOKEN)!
  expect(binding.id).toBe('EVT-1')
  for (const bad of [undefined, {}, { ...answer, extra: 'x' }, { ...answer, next_action: ' ' }])
    expect(() => guidanceAck(binding, bad)).toThrow('GUIDANCE_RESPONSE_REQUIRED')
  expect(guidanceAck(binding, answer)).toMatchObject({ id: 'EVT-1', ...answer })
})

test('a bound assignment requires an acknowledgment, and a wrong one is invalid', () => {
  const events = [guidance()]
  const bound = { ...lease, guidance_id: 'EVT-1' }
  expect(() => requireGuidanceAck(state, events, bound, TOKEN)).toThrow('GUIDANCE_ACK_REQUIRED')
  const binding = currentGuidance(state, events, bound, TOKEN)!
  expect(() =>
    requireGuidanceAck(state, events, bound, TOKEN, {
      guidance_ack: { ...binding, ...answer, fingerprint: 'stale-fingerprint' }
    })
  ).toThrow('GUIDANCE_ACK_INVALID')
  expect(() =>
    requireGuidanceAck(state, events, bound, TOKEN, { guidance_ack: { ...binding, ...answer } })
  ).not.toThrow()
})

test('an event type that cannot carry an acknowledgment is exempt', () => {
  const events = [guidance()]
  const bound = { ...lease, guidance_id: 'EVT-1' }
  for (const type of [
    'capability_probe',
    'checkpoint',
    'implementation_escalation',
    'plan_challenge'
  ])
    expect(() => requireGuidanceAck(state, events, bound, TOKEN, {}, type)).not.toThrow()
})

test('the binding fingerprint is derived from the guidance payload itself', () => {
  const event = guidance()
  const binding = currentGuidance(state, [event], { ...lease, guidance_id: 'EVT-1' }, TOKEN)!
  const expected = createHash('sha256')
    .update(canonicalJson(event.payload as Item))
    .digest('hex')
  expect(binding.fingerprint).toBe(expected)
})
