import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentRecord } from '../scripts/controllers/agent-record.controller'
import { agentStartReceipt } from '../scripts/controllers/agent-start-receipt.controller'
import { runBootstrapProcesses } from '../scripts/controllers/bootstrap-process'
import { dispatch, type DispatchOptions } from '../scripts/controllers/dispatch.controller'
import { contextRead } from '../scripts/controllers/read-only.controller'
import { admissionFixture } from './fixtures/admission'
import { COORDINATOR, createNativeChain } from './fixtures/native-chain'

type Item = Record<string, unknown>
const REQUIREMENTS = ['XQ01', 'XQ02']
const ACCEPTANCE = ['YS01', 'YS02']
/** Shard ID → the requirement and acceptance it verifies. */
const SHARDS = { FV01: ['XQ01', 'YS01'], FV02: ['XQ02', 'YS02'] } as const

/** The single-requirement fixture widened to two Must-Ship requirements planned as two shards. */
function shardedFixture(): { contract: Item; admission: Item } {
  const { contract: base, payload } = admissionFixture('.')
  const contract = structuredClone(base) as unknown as Item
  const admission = structuredClone(payload) as unknown as Item
  const first = (contract.acceptance as Item[])[0]!
  contract.requirements = [
    { id: 'XQ01', kind: 'must-ship', title: 'Return two', acceptance: ['YS01'] },
    { id: 'XQ02', kind: 'must-ship', title: 'Keep the value stable', acceptance: ['YS02'] }
  ]
  contract.acceptance = [
    first,
    {
      ...first,
      id: 'YS02',
      requirement_ids: ['XQ02'],
      environment: 'isolated fixture copy',
      claim: { ...(first.claim as Item), id: 'CL02' },
      execution: { ...(first.execution as Item), evidence_boundary: 'fixture-result-stable' }
    }
  ]
  contract.delivery_plan = {
    protocol: 'delivery-plan/v1',
    batches: [
      {
        id: 'B01',
        lane: 'core',
        requirement_ids: REQUIREMENTS,
        acceptance_ids: ACCEPTANCE,
        modification_packages: ['.'],
        depends_on: [],
        estimated_minutes: 12,
        test_budget: { minutes: 4, max_new_test_files: 1 }
      }
    ],
    final_verification_shards: Object.entries(SHARDS).map(([id, [, acceptance]]) => ({
      id,
      acceptance_ids: [acceptance]
    }))
  }
  const widen = (item: Item) => ({
    ...item,
    requirement_ids: REQUIREMENTS,
    acceptance_ids: ACCEPTANCE
  })
  const closure = admission.fact_closure as Item
  const scope = admission.verification_scope as Item
  const ownership = admission.semantic_ownership as Item
  const disposition = (admission.claim_dispositions as Item[])[0]!
  Object.assign(admission, {
    requirement_ids: REQUIREMENTS,
    acceptance_ids: ACCEPTANCE,
    execution_packets: (admission.execution_packets as Item[]).map(widen),
    fact_closure: {
      ...closure,
      facts: (closure.facts as Item[]).map((fact) => ({
        ...widen(fact),
        claim_ids: ['CL01', 'CL02']
      }))
    },
    early_falsifier_result: widen(admission.early_falsifier_result as Item),
    claim_dispositions: [disposition, { ...disposition, claim_id: 'CL02' }],
    verification_scope: { ...scope, surfaces: (scope.surfaces as Item[]).map(widen) },
    semantic_ownership: {
      ...ownership,
      items: (ownership.items as Item[]).map((item) => ({ ...item, requirement_ids: REQUIREMENTS }))
    },
    must_ship_decision_closure: {
      ...(admission.must_ship_decision_closure as Item),
      requirement_ids: REQUIREMENTS
    },
    sdd_convergence_review: {
      ...(admission.sdd_convergence_review as Item),
      reviewed_acceptance_ids: ACCEPTANCE
    }
  })
  return { contract, admission }
}

test('final verification shards run concurrently on distinct Architects and SHIP only on every shard verdict', () => {
  const root = mkdtempSync(join(tmpdir(), 'parallel-final-'))
  const chain = createNativeChain(root, shardedFixture())
  const tokens = new Map<string, string>()
  const assign = (agentId: string, options: DispatchOptions) =>
    dispatch(
      chain.sdd,
      'coordinator',
      chain.phase(),
      'v1',
      'architect',
      agentId,
      1,
      5,
      ['.'],
      'verify shard',
      COORDINATOR,
      options
    )
  /** Dispatch, bootstrap and start one shard Architect exactly as a host runtime would. */
  const startShard = (agentId: string, options: DispatchOptions) => {
    const current = chain.phase()
    const lease = assign(agentId, options)
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = lease.capabilityFile
    tokens.set(lease.leaseId, readFileSync(lease.capabilityFile, 'utf8'))
    runBootstrapProcesses(chain.sdd, agentId, current, 'v1')
    const pages = join(root, `${agentId}-pages.json`)
    writeFileSync(pages, JSON.stringify(contextRead(chain.sdd, 0, 65536)))
    agentStartReceipt(
      chain.sdd,
      'architect',
      agentId,
      lease.leaseId,
      pages,
      'Verify only this shard acceptance and stop on a failing oracle.',
      current,
      'v1',
      COORDINATOR
    )
    return lease.leaseId
  }
  const verdict = (agentId: string, leaseId: string, shard: keyof typeof SHARDS) => {
    const [requirement, acceptance] = SHARDS[shard]
    chain.architectRun(leaseId, [acceptance], agentId, tokens.get(leaseId))
    const full = chain.verificationPayload()
    return agentRecord(
      chain.sdd,
      'architect',
      agentId,
      leaseId,
      chain.phase(),
      'v1',
      'verification',
      {
        ...full,
        requirement_ids: [requirement],
        acceptance_ids: [acceptance],
        checks: (full.checks as Item[]).filter((check) =>
          (check.acceptance_ids as string[]).includes(acceptance)
        )
      },
      tokens.get(leaseId),
      COORDINATOR
    ).eventId
  }
  const second: DispatchOptions = {
    verificationShard: 'FV02',
    verificationMode: 'fresh-independent',
    freshReason: 'parallel-final-verification-shard'
  }
  try {
    chain.setup()
    chain.toArchitectVerify()
    chain.verify()
    chain.advance('COORDINATOR_TRIAGE', 'FINAL_CANDIDATE', 'FINAL_VERIFY')

    const firstLease = startShard('architect', { verificationShard: 'FV01' })
    // Only another shard may join: an unsharded lease or the same shard is still exclusive.
    expect(() =>
      assign('architect-3', {
        verificationMode: 'fresh-independent',
        freshReason: 'prior-architect-unavailable-or-timed-out'
      })
    ).toThrow('ACTIVE_AGENT_LEASE_EXISTS')
    expect(() => assign('architect-2', { ...second, verificationShard: 'FV01' })).toThrow(
      'ACTIVE_AGENT_LEASE_EXISTS'
    )
    const secondLease = startShard('architect-2', second)
    expect(chain.state().active_lease).toMatchObject({
      lease_id: firstLease,
      verification_shard: 'FV01'
    })
    expect(Object.keys(chain.state().shard_leases as Item)).toEqual([secondLease])

    // The later shard finishes first; SHIP waits for the live shard.
    const secondVerdict = verdict('architect-2', secondLease, 'FV02')
    expect(() => chain.advance('SHIP')).toThrow('FINAL_VERIFICATION_SHARDS_ACTIVE')
    const firstVerdict = verdict('architect', firstLease, 'FV01')
    expect(chain.state().final_shard_verdicts).toEqual({ FV02: secondVerdict, FV01: firstVerdict })
    expect(chain.state().active_lease).toBeNull()
    expect(chain.state().shard_leases).toEqual({})

    chain.markVerified(firstVerdict, 'XQ01')
    chain.markVerified(secondVerdict, 'XQ02')
    chain.advance('SHIP')
    expect(chain.phase()).toBe('SHIP')
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})
