import { assertVerificationReviewer } from '../scripts/helpers/verification-reviewer'
import { hasProgressEvidence } from '../scripts/helpers/progress-evidence'
import { test, expect } from 'bun:test'
import { assertDesignIndependence } from '../scripts/helpers/design-independence'
import { rolePublicKey, signRoleEvent } from '../scripts/resource/role-signature'
import { designProposalFixture } from './fixtures/design-proposal'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatch } from '../scripts/controllers/dispatch.controller'
import { createNativeChain } from './fixtures/native-chain'
import { bindEventLog, eventLogBinding } from '../scripts/resource/store/event-log-binding'

const lease = {
  lease_id: 'design',
  role: 'architect',
  agent_id: 'author',
  authority_epoch: 1,
  contract_revision: 'v1',
  event_public_key: rolePublicKey('author')
}
const proposal = (materiality = 'MATERIAL') =>
  signRoleEvent(
    {
      event_id: 'DP-event',
      role: 'architect',
      type: 'design_proposal',
      contract_revision: 'v1',
      actor: { agent_id: 'author', lease_id: 'design', authority_epoch: 1 },
      payload: { ...designProposalFixture(), materiality }
    },
    'author'
  )
const resolution = {
  event_id: 'DR-event',
  role: 'coordinator',
  type: 'design_resolution',
  payload: { decision: 'CONVERGED', proposal_event_id: 'DP-event' }
}
test('material design author exclusion survives epoch and contract changes without excluding bounded advice', () => {
  const state = { authority_epoch: 4, contract_revision: 'v3', issued_leases: { design: lease } }
  expect(() => assertDesignIndependence(state, [proposal(), resolution], 'author')).toThrow(
    'ARCHITECT_ADOPTED_MATERIAL_DESIGN_AUTHOR'
  )
  expect(() =>
    assertDesignIndependence(state, [proposal(), resolution], 'independent')
  ).not.toThrow()
  expect(() =>
    assertDesignIndependence(state, [proposal('BOUNDED'), resolution], 'author')
  ).not.toThrow()
  expect(() => assertDesignIndependence(state, [proposal()], 'author')).not.toThrow()
  expect(() => assertDesignIndependence(state, [resolution], 'author')).toThrow(
    'DESIGN_AUTHOR_HISTORY_UNVERIFIABLE'
  )
  expect(() =>
    assertDesignIndependence(state, [{ ...proposal(), signature: 'forged' }, resolution], 'author')
  ).toThrow('ROLE_EVIDENCE_PROVENANCE_INVALID')
})
test('dispatch refuses the adopted author without writes and accepts an independent Architect', () => {
  const root = mkdtempSync(join(tmpdir(), 'design-independent-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    chain.toArchitectVerify()
    // Adopted MATERIAL design history is appended after a real READY handoff.
    const state = chain.state()
    state.issued_leases = { ...(state.issued_leases as Record<string, unknown>), design: lease }
    const log =
      readFileSync(chain.sdd + '.events.jsonl', 'utf8') +
      [proposal(), resolution].map((event) => JSON.stringify(event)).join('\n') +
      '\n'
    // Rebind the fixture history so the case tests design independence, not log integrity.
    const before = bindEventLog(
      Buffer.from(JSON.stringify(state)),
      eventLogBinding(Buffer.from(log))
    ).toString()
    writeFileSync(chain.sdd + '.loop.json', before)
    writeFileSync(chain.sdd + '.events.jsonl', log)
    const call = (id: string) =>
      dispatch(
        chain.sdd,
        'coordinator',
        'ARCHITECT_VERIFY',
        'v1',
        'architect',
        id,
        1,
        5,
        ['.'],
        'verify candidate',
        'coordinator'
      )
    expect(() => call('author')).toThrow('ARCHITECT_ADOPTED_MATERIAL_DESIGN_AUTHOR')
    expect(readFileSync(chain.sdd + '.loop.json', 'utf8')).toBe(before)
    expect(readFileSync(chain.sdd + '.events.jsonl', 'utf8')).toBe(log)
    expect(call('independent').agentId).toBe('independent')
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test("verification and progress consumers reject a material author's verification while independent review remains valid", () => {
  const candidate = {
    candidate_id: 'c1',
    environment_fingerprint: 'env',
    manifest_sha256: 'manifest',
    worktree_fingerprint: 'tree'
  }
  const op = {
    lease_id: 'op',
    role: 'operator',
    agent_id: 'operator',
    authority_epoch: 1,
    contract_revision: 'v1',
    event_public_key: rolePublicKey('op')
  }
  const state = {
    contract_revision: 'v1',
    requirements: { XQ01: 'verified' },
    issued_leases: {
      design: lease,
      op,
      independent: {
        ...lease,
        lease_id: 'independent',
        agent_id: 'independent',
        event_public_key: rolePublicKey('independent')
      }
    }
  }
  const implementation = signRoleEvent(
    {
      event_id: 'IM',
      role: 'operator',
      type: 'implementation',
      actor: { agent_id: 'operator', lease_id: 'op', authority_epoch: 1 },
      payload: { candidate }
    },
    'op'
  )
  const verdict = (id: string) =>
    signRoleEvent(
      {
        event_id: 'VE',
        role: 'architect',
        type: 'verification',
        actor: {
          agent_id: id,
          lease_id: id === 'author' ? 'design' : 'independent',
          authority_epoch: 1
        },
        payload: {
          ...candidate,
          result: 'PASS',
          requirement_ids: ['XQ01'],
          acceptance_ids: ['YS01']
        }
      },
      id
    )
  const bad = [proposal(), resolution, implementation, verdict('author')]
  expect(() => assertVerificationReviewer(state, bad, bad.at(-1)!)).toThrow(
    'ARCHITECT_ADOPTED_MATERIAL_DESIGN_AUTHOR'
  )
  expect(hasProgressEvidence(state, { requirement_ids: ['XQ01'], evidence: ['VE'] }, bad)).toBe(
    false
  )
  const good = [proposal(), resolution, implementation, verdict('independent')]
  expect(() => assertVerificationReviewer(state, good, good.at(-1)!)).not.toThrow()
  expect(hasProgressEvidence(state, { requirement_ids: ['XQ01'], evidence: ['VE'] }, good)).toBe(
    true
  )
  const counsel = {
    ...state,
    issued_leases: {
      ...state.issued_leases,
      independent: { ...state.issued_leases.independent, verification_mode: 'design-counsel' }
    }
  }
  expect(() => assertVerificationReviewer(counsel, good, good.at(-1)!)).toThrow(
    'DESIGN_COUNSEL_CANNOT_VERIFY_PRODUCT'
  )
  expect(hasProgressEvidence(counsel, { requirement_ids: ['XQ01'], evidence: ['VE'] }, good)).toBe(
    false
  )
})
