import { createHmac } from 'node:crypto'
import { test, expect } from 'bun:test'
import { assertDesignResolution } from '../scripts/helpers/design-resolution'
import { rolePublicKey, signRoleEvent } from '../scripts/resource/role-signature'
import { designProposalFixture, designResolutionFixture } from './fixtures/design-proposal'

test('design decision requires real current proposal and full independent review coverage', () => {
  const state = {
    contract_revision: 'v1',
    sdd_fingerprint: 'source',
    authority_epoch: 1,
    issued_leases: {
      ar: {
        role: 'architect',
        agent_id: 'architect',
        authority_epoch: 1,
        contract_revision: 'v1',
        event_public_key: rolePublicKey('ar')
      }
    }
  }
  const proposal = signRoleEvent(
    {
      event_id: 'EVT-proposal',
      role: 'architect',
      type: 'design_proposal',
      actor: { agent_id: 'architect', lease_id: 'ar', authority_epoch: 1 },
      contract_revision: 'v1',
      sdd_fingerprint: 'source',
      payload: designProposalFixture()
    },
    'ar'
  )
  const good = designResolutionFixture()
  expect(() => assertDesignResolution(state, good, [proposal], 'coordinator')).not.toThrow()
  for (const patch of [
    { proposal_event_id: 'missing' },
    { review_coverage: [] },
    { selected_route_id: 'unknown' },
    { unknowns: ['unresolved'] },
    { authority_classification: 'USER_AUTHORITY_REQUIRED' },
    { review_coverage: good.review_coverage.map((item) => ({ ...item, result: 'FAIL' })) }
  ])
    expect(() =>
      assertDesignResolution(state, { ...good, ...patch }, [proposal], 'coordinator')
    ).toThrow()
  for (const events of [
    [proposal, proposal],
    [{ ...proposal, signature: 'forged' }],
    [proposal, { type: 'contract_amendment' }]
  ])
    expect(() => assertDesignResolution(state, good, events, 'coordinator')).toThrow()
  const challenge = {
    ...good,
    decision: 'CHALLENGE',
    counterexamples: ['early release'],
    required_revisions: ['move completion after release'],
    challenged_claim_ids: ['CL01'],
    review_coverage: good.review_coverage.map((item, index) => ({
      ...item,
      result: index === 0 ? 'FAIL' : 'PASS'
    }))
  }
  expect(() => assertDesignResolution(state, challenge, [proposal], 'coordinator')).not.toThrow()
  expect(() =>
    assertDesignResolution(
      state,
      { ...challenge, challenged_claim_ids: ['unknown'] },
      [proposal],
      'coordinator'
    )
  ).toThrow('DESIGN_CHALLENGE_CLAIM_REFERENCE_INVALID')
})

test('revised proposal must resolve the outstanding challenge before convergence', () => {
  const state = {
    contract_revision: 'v1',
    sdd_fingerprint: 'source',
    authority_epoch: 1,
    issued_leases: {
      ar: {
        role: 'architect',
        agent_id: 'architect',
        authority_epoch: 1,
        contract_revision: 'v1',
        event_public_key: rolePublicKey('ar')
      }
    }
  }
  const proposal = (id: string) =>
    signRoleEvent(
      {
        event_id: id,
        role: 'architect',
        type: 'design_proposal',
        actor: { agent_id: 'architect', lease_id: 'ar', authority_epoch: 1 },
        contract_revision: 'v1',
        sdd_fingerprint: 'source',
        payload: designProposalFixture()
      },
      'ar'
    )
  const first = proposal('DP-first'),
    revised = proposal('DP-revised')
  const review = {
    ...designResolutionFixture('DP-first'),
    decision: 'CHALLENGE',
    counterexamples: ['early completion'],
    required_revisions: ['wait for release'],
    challenged_claim_ids: ['CL01'],
    review_coverage: designResolutionFixture().review_coverage.map((item, index) => ({
      ...item,
      result: index === 0 ? 'FAIL' : 'PASS'
    }))
  }
  const body = {
    event_id: 'CH',
    type: 'design_resolution',
    role: 'coordinator',
    authority_epoch: 1,
    contract_revision: 'v1',
    sdd_fingerprint: 'source',
    payload: review
  }
  const challenge = {
    ...body,
    signature: createHmac('sha256', 'coordinator').update(JSON.stringify(body)).digest('hex')
  }
  const events = [first, challenge, revised],
    good = designResolutionFixture('DP-revised')
  expect(() => assertDesignResolution(state, good, events, 'coordinator')).toThrow(
    'DESIGN_CHALLENGE_RESOLUTION_REQUIRED'
  )
  expect(() =>
    assertDesignResolution(
      state,
      { ...good, resolved_challenge_event_id: 'CH', challenge_resolutions: [] },
      events,
      'coordinator'
    )
  ).toThrow('DESIGN_CHALLENGE_RESOLUTION_INCOMPLETE')
  const resolved = {
    ...good,
    resolved_challenge_event_id: 'CH',
    challenge_resolutions: [
      {
        required_revision: 'wait for release',
        disposition: 'RESOLVED',
        evidence: ['completion trace follows release']
      }
    ]
  }
  expect(() => assertDesignResolution(state, resolved, events, 'coordinator')).not.toThrow()
  const secondBody = {
    ...body,
    event_id: 'CH-second',
    payload: {
      ...review,
      proposal_event_id: 'DP-revised',
      required_revisions: ['retain cancellation']
    }
  }
  const second = {
    ...secondBody,
    signature: createHmac('sha256', 'coordinator').update(JSON.stringify(secondBody)).digest('hex')
  }
  const cumulativeEvents = [...events, second, proposal('DP-third')]
  const cumulative = {
    ...designResolutionFixture('DP-third'),
    resolved_challenge_event_id: 'CH-second',
    challenge_resolutions: [
      {
        required_revision: 'retain cancellation',
        disposition: 'RESOLVED',
        evidence: ['cancel trace']
      }
    ]
  }
  expect(() => assertDesignResolution(state, cumulative, cumulativeEvents, 'coordinator')).toThrow(
    'DESIGN_CHALLENGE_RESOLUTION_INCOMPLETE'
  )
  cumulative.challenge_resolutions.push(...resolved.challenge_resolutions)
  expect(() =>
    assertDesignResolution(state, cumulative, cumulativeEvents, 'coordinator')
  ).not.toThrow()
  const closedBody = { ...body, event_id: 'CLOSED', payload: cumulative }
  const closed = {
    ...closedBody,
    signature: createHmac('sha256', 'coordinator').update(JSON.stringify(closedBody)).digest('hex')
  }
  expect(() =>
    assertDesignResolution(
      state,
      designResolutionFixture('DP-next'),
      [...cumulativeEvents, closed, proposal('DP-next')],
      'coordinator'
    )
  ).not.toThrow()
  // A fresh Architect inherits contract objections without inheriting credentials.
  const replacementState = {
    ...state,
    issued_leases: {
      ...state.issued_leases,
      replacement: {
        ...state.issued_leases.ar,
        agent_id: 'replacement',
        event_public_key: rolePublicKey('replacement-token')
      }
    }
  }
  const replacement = signRoleEvent(
    {
      event_id: 'DP-replacement',
      role: 'architect',
      type: 'design_proposal',
      actor: { agent_id: 'replacement', lease_id: 'replacement', authority_epoch: 1 },
      contract_revision: 'v1',
      sdd_fingerprint: 'source',
      payload: designProposalFixture()
    },
    'replacement-token'
  )
  const replacementEvents = [first, challenge, replacement]
  expect(() =>
    assertDesignResolution(
      replacementState,
      designResolutionFixture('DP-replacement'),
      replacementEvents,
      'coordinator'
    )
  ).toThrow('DESIGN_CHALLENGE_RESOLUTION_REQUIRED')
  expect(() =>
    assertDesignResolution(
      replacementState,
      { ...resolved, proposal_event_id: 'DP-replacement' },
      replacementEvents,
      'coordinator'
    )
  ).not.toThrow()
  expect(() =>
    assertDesignResolution(
      state,
      {
        ...resolved,
        challenge_resolutions: [
          { required_revision: 'different work', disposition: 'RESOLVED', evidence: ['trace'] }
        ]
      },
      events,
      'coordinator'
    )
  ).toThrow('DESIGN_CHALLENGE_RESOLUTION_INCOMPLETE')
})
