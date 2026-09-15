import { admissionFixture } from './fixtures/admission'
import { initLoop } from '../scripts/controllers/init.controller'
import { authBootstrap } from '../scripts/controllers/auth-bootstrap.controller'
import { transition } from '../scripts/controllers/transition.controller'
import { dispatch } from '../scripts/controllers/dispatch.controller'
import { runBootstrapProcesses } from '../scripts/controllers/bootstrap-process'
import { agentStartReceipt } from '../scripts/controllers/agent-start-receipt.controller'
import { contextDocumentPage } from '../scripts/services/context-document'
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertDesignProposal } from '../scripts/domain/policies/design-proposal'
import { agentRecord } from '../scripts/controllers/agent-record.controller'
import { assertRoleEvidence } from '../scripts/helpers/role-evidence'
import { designProposalFixture } from './fixtures/design-proposal'

test('design proposal checks review lenses, routes and user boundaries', () => {
  const good = designProposalFixture()
  expect(() => assertDesignProposal(good)).not.toThrow()
  for (const patch of [
    { claims: good.claims.slice(1) },
    { claims: good.claims.map(() => good.claims[0]) },
    { recommended_route_id: 'missing' },
    { unknowns: null },
    { root_cause: '' },
    { contract_preservation: {} },
    {
      contract_preservation: {
        ...good.contract_preservation,
        objective: { status: 'CHANGE_REQUIRES_USER', evidence: ['new objective'] }
      }
    }
  ])
    expect(() => assertDesignProposal({ ...good, ...patch })).toThrow()
  expect(() =>
    assertDesignProposal({
      ...good,
      authority_classification: 'USER_AUTHORITY_REQUIRED',
      contract_preservation: {
        ...good.contract_preservation,
        objective: { status: 'CHANGE_REQUIRES_USER', evidence: ['new objective'] }
      }
    })
  ).not.toThrow()
})
test('Architect directly signs a proposal after actual startup without attesting product PASS', () => {
  const root = mkdtempSync(join(tmpdir(), 'design-proposal-')),
    sdd = join(root, 'task.md')
  const saved = [process.env.SDD_LOOP_AGENT_TOKEN_FILE, process.env.SDD_LOOP_CAPABILITY_DIR]
  process.env.SDD_LOOP_CAPABILITY_DIR = join(root, 'capabilities')
  try {
    writeFileSync(sdd, admissionFixture().source)
    initLoop(sdd, 4)
    authBootstrap(sdd, 'DISCOVER', 'v1', 'yes', 'coordinator')
    transition(sdd, 'coordinator', 'DISCOVER', 'v1', 'ARCHITECT', 'coordinator')
    transition(sdd, 'coordinator', 'ARCHITECT', 'v1', 'CONTRACT_DRAFT', 'coordinator')
    const lease = dispatch(
      sdd,
      'coordinator',
      'CONTRACT_DRAFT',
      'v1',
      'architect',
      'architect',
      1,
      5,
      ['packages/app'],
      'Review fixture design',
      'coordinator',
      { verificationMode: 'design-counsel' }
    )
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = lease.capabilityFile
    const ar = readFileSync(lease.capabilityFile, 'utf8')
    runBootstrapProcesses(sdd, 'architect', 'CONTRACT_DRAFT', 'v1')
    const pages = join(root, 'pages.json')
    writeFileSync(pages, JSON.stringify(contextDocumentPage(sdd, { role: 'architect' }, 0, 65536)))
    agentStartReceipt(
      sdd,
      'architect',
      'architect',
      lease.leaseId,
      pages,
      'Trace the fixture route, check the counterexample and stop on an unsupported premise.',
      'CONTRACT_DRAFT',
      'v1',
      'coordinator'
    )
    const before = readFileSync(sdd + '.loop.json', 'utf8')
    const log = readFileSync(sdd + '.events.jsonl', 'utf8')
    const state = JSON.parse(before)
    const call = (payload: unknown) =>
      agentRecord(
        sdd,
        'architect',
        'architect',
        lease.leaseId,
        'CONTRACT_DRAFT',
        'v1',
        'design_proposal',
        payload,
        ar,
        'coordinator'
      )
    expect(() => call({ ...designProposalFixture(), claims: [] })).toThrow(
      'DESIGN_PROPOSAL_CLAIMS_INCOMPLETE'
    )
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(before)
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(log)
    expect(() =>
      agentRecord(
        sdd,
        'operator',
        'architect',
        lease.leaseId,
        'CONTRACT_DRAFT',
        'v1',
        'design_proposal',
        designProposalFixture(),
        ar,
        'coordinator'
      )
    ).toThrow('AGENT_EVENT_ROLE_FORBIDDEN')
    expect(readFileSync(sdd + '.loop.json', 'utf8')).toBe(before)
    expect(readFileSync(sdd + '.events.jsonl', 'utf8')).toBe(log)
    call(designProposalFixture())
    const after = JSON.parse(readFileSync(sdd + '.loop.json', 'utf8'))
    const events = readFileSync(sdd + '.events.jsonl', 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const event = events.at(-1)!
    expect(after).toEqual({
      ...state,
      active_lease: null,
      // A completed lease records its end time for estimate calibration.
      issued_leases: {
        ...state.issued_leases,
        [lease.leaseId]: {
          ...state.issued_leases[lease.leaseId],
          ended_at: after.issued_leases[lease.leaseId].ended_at
        }
      },
      revision: state.revision + 1,
      updated_at: after.updated_at,
      event_log: after.event_log,
      last_role_events: { ...state.last_role_events, design_proposal: event.event_id }
    })
    expect(event.type).toBe('design_proposal')
    expect(event.contract_revision).toBe('v1')
    expect(event.sdd_fingerprint).toBe(state.sdd_fingerprint)
    expect(() => assertRoleEvidence(after, event, 'architect')).not.toThrow()
    expect(events.some((event) => event.type === 'verification')).toBe(false)
  } finally {
    ;['SDD_LOOP_AGENT_TOKEN_FILE', 'SDD_LOOP_CAPABILITY_DIR'].forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key]
      else process.env[key] = saved[index]
    })
    rmSync(root, { recursive: true, force: true })
  }
})
