import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertDeliveryPlan } from '../scripts/domain/delivery-plan'
import { readContractText, type Contract } from '../scripts/domain/contract'
import { assertAdmissionScope } from '../scripts/domain/policies/admission-scope'
import { admissionDispatchScope } from '../scripts/helpers/admission-authority'
import { assertPreparedChecks } from '../scripts/helpers/prepared-checks'
import { assertExecutionBindings } from '../scripts/helpers/execution-bindings'
import { prepare } from '../scripts/controllers/prepare.controller'
import { prepareRecord } from '../scripts/controllers/prepare-record.controller'
import { admissionFixture } from './fixtures/admission'
import { COORDINATOR, createNativeChain } from './fixtures/native-chain'

type Item = Record<string, unknown>

/** Three requirements: R3 depends on R1; packages a/b let batches run side by side. */
function planContract(plan: Item): Item {
  const acceptance = (id: string, requirement: string, blocking: string[] = []) => ({
    id,
    requirement_ids: [requirement],
    packages: [requirement === 'R2' ? 'packages/b' : 'packages/a'],
    execution: { blocking_acceptance_ids: blocking }
  })
  return {
    protocol: 'sdd-loop-delivery/v1',
    revision: 'v1',
    requirements: [
      { id: 'R1', kind: 'must-ship', title: 'first', acceptance: ['A1'] },
      { id: 'R2', kind: 'must-ship', title: 'second', acceptance: ['A2'] },
      { id: 'R3', kind: 'must-ship', title: 'third', acceptance: ['A3'], dependencies: ['R1'] }
    ],
    acceptance: [acceptance('A1', 'R1'), acceptance('A2', 'R2'), acceptance('A3', 'R3')],
    delivery_plan: { protocol: 'delivery-plan/v1', ...plan }
  }
}
const batch = (id: string, requirement: string, packages: string[], extra: Item = {}) => ({
  id,
  lane: 'L1',
  requirement_ids: [requirement],
  acceptance_ids: [`A${requirement.slice(1)}`],
  modification_packages: packages,
  estimated_minutes: 30,
  test_budget: { minutes: 5, max_new_test_files: 0 },
  ...extra
})

test('a delivery plan exposes parallel waves and rejects unsafe or oversized batching', () => {
  const valid = [
    batch('B1', 'R1', ['packages/a'], { estimated_minutes: 20 }),
    batch('B2', 'R2', ['packages/b'], { lane: 'L2' }),
    batch('B3', 'R3', ['packages/a'], { depends_on: ['B1'], estimated_minutes: 25 })
  ]
  expect(
    assertDeliveryPlan(
      planContract({
        batches: valid,
        final_verification_shards: [
          { id: 'S1', acceptance_ids: ['A1', 'A3'] },
          { id: 'S2', acceptance_ids: ['A2'] }
        ]
      })
    )
  ).toEqual({
    protocol: 'delivery-plan/v1',
    waves: [['B1', 'B2'], ['B3']],
    lanes: { L1: ['B1', 'B3'], L2: ['B2'] },
    serial_minutes: 75,
    critical_path_minutes: 45,
    final_verification_shards: 2,
    test_minutes: 15
  })
  expect(assertDeliveryPlan({ requirements: [] })).toBeNull()
  const cases: [Item[], string][] = [
    // Nested roots written by unordered batches can touch the same bytes.
    [[valid[0]!, batch('B2', 'R2', ['packages/a/sub']), valid[2]!], 'DELIVERY_PLAN_WRITE_CONFLICT'],
    // R3 needs R1, so its batch must be scheduled after B1.
    [
      [valid[0]!, valid[1]!, batch('B3', 'R3', ['packages/c'])],
      'DELIVERY_PLAN_REQUIREMENT_ORDER_INVALID'
    ],
    [
      [valid[0]!, batch('B2', 'R2', ['packages/b'], { estimated_minutes: 61 }), valid[2]!],
      'DELIVERY_PLAN_BATCH_TOO_LARGE'
    ],
    [[valid[0]!, valid[2]!], 'DELIVERY_PLAN_REQUIREMENT_COVERAGE_INCOMPLETE'],
    // Test effort stays a small, bounded share of the batch: ceil(20 / 3) = 7 minutes.
    [
      [
        batch('B1', 'R1', ['packages/a'], {
          estimated_minutes: 20,
          test_budget: { minutes: 8, max_new_test_files: 0 }
        }),
        valid[1]!,
        valid[2]!
      ],
      'DELIVERY_PLAN_TEST_BUDGET_JUSTIFICATION_REQUIRED'
    ],
    [
      [
        batch('B1', 'R1', ['packages/a'], { test_budget: { minutes: 5, max_new_test_files: 2 } }),
        valid[1]!,
        valid[2]!
      ],
      'DELIVERY_PLAN_TEST_BUDGET_JUSTIFICATION_REQUIRED'
    ],
    [
      [batch('B1', 'R1', ['packages/a'], { test_budget: undefined }), valid[1]!, valid[2]!],
      'DELIVERY_PLAN_TEST_BUDGET_INVALID'
    ],
    [
      [valid[0]!, valid[1]!, batch('B3', 'R3', ['packages/a'], { depends_on: ['B3'] })],
      'DELIVERY_PLAN_DEPENDENCY_UNKNOWN'
    ]
  ]
  for (const [batches, error] of cases)
    expect(() => assertDeliveryPlan(planContract({ batches }))).toThrow(error)
  const blocked = planContract({
    batches: valid,
    final_verification_shards: [
      { id: 'S1', acceptance_ids: ['A1', 'A3'] },
      { id: 'S2', acceptance_ids: ['A2'] }
    ]
  })
  ;(blocked.acceptance as Item[])[1]!.execution = { blocking_acceptance_ids: ['A1'] }
  expect(() => assertDeliveryPlan(blocked)).toThrow('DELIVERY_PLAN_SHARD_BLOCKING_EDGE')
  expect(() =>
    assertDeliveryPlan(
      planContract({
        batches: valid,
        final_verification_shards: [{ id: 'S1', acceptance_ids: ['A1'] }]
      })
    )
  ).toThrow('DELIVERY_PLAN_SHARD_COVERAGE_INVALID')
  // The execution parser applies the same rule, so an unsafe plan never initializes.
  const unsafe = planContract({ batches: [valid[0]!, batch('B2', 'R2', ['.']), valid[2]!] })
  expect(() =>
    readContractText(
      `<!-- sdd-contract:start -->\n\`\`\`json\n${JSON.stringify(unsafe)}\n\`\`\`\n<!-- sdd-contract:end -->`
    )
  ).toThrow('DELIVERY_PLAN_WRITE_CONFLICT')
})

test('packets may narrow their write set, and dispatch and the plan both bound it', () => {
  const fixture = admissionFixture('packages/app')
  const payload = structuredClone(fixture.payload) as Item
  const packet = (payload.execution_packets as Item[])[0]!
  payload.modification_packages = ['packages/app', 'packages/lib']
  packet.modification_packages = ['packages/lib']
  const contract = fixture.contract as unknown as Contract
  expect(() => assertAdmissionScope(contract, payload)).not.toThrow()
  const event = { payload }
  expect(() =>
    admissionDispatchScope(event, 'operator', ['packages/lib/value.ts'], String(packet.id))
  ).not.toThrow()
  expect(() =>
    admissionDispatchScope(event, 'operator', ['packages/app/value.ts'], String(packet.id))
  ).toThrow('ADMISSION_DISPATCH_SCOPE_INVALID')
  packet.modification_packages = ['packages/elsewhere']
  expect(() => assertAdmissionScope(contract, payload)).toThrow(
    'EXECUTION_PACKET_MODIFICATION_PACKAGES_INVALID'
  )
  packet.modification_packages = ['packages/lib']
  const planned = {
    ...contract,
    delivery_plan: {
      batches: [
        { id: packet.id, requirement_ids: ['XQ99'], modification_packages: ['packages/lib'] }
      ]
    }
  } as unknown as Contract
  expect(() => assertAdmissionScope(planned, payload)).toThrow('EXECUTION_PACKET_PLAN_MISMATCH')
})

test('prepared checks bind the contract and never stand in for a verification check', () => {
  const contract = {
    acceptance: [{ id: 'A1', method: 'm', oracle: 'o', environment: 'e', packages: ['packages/a'] }]
  }
  const check = {
    acceptance_ids: ['A1'],
    method: 'm',
    oracle: 'o',
    environment: 'e',
    packages: ['packages/a'],
    outcome: 'PASS',
    evidence: ['ran on an isolated copy']
  }
  expect(() => assertPreparedChecks(contract, ['A1'], [check])).not.toThrow()
  for (const [bad, error] of [
    [{ ...check, method: 'other' }, 'PREPARED_CHECK_CONTRACT_BINDING_MISMATCH'],
    [{ ...check, packages: ['packages/b'] }, 'PREPARED_CHECK_PACKAGES_MISMATCH'],
    [{ ...check, execution: 'PRE_VERIFIED' }, 'PREPARED_CHECK_INVALID']
  ] as const)
    expect(() => assertPreparedChecks(contract, ['A1'], [bad])).toThrow(error)
  expect(() => assertPreparedChecks(contract, ['A2'], [check])).toThrow(
    'PREPARED_CHECK_SCOPE_INVALID'
  )
  // An unmeasured prepared PASS copied into a verdict is not an execution mode.
  expect(() =>
    assertExecutionBindings(
      { authority_epoch: 1, contract_revision: 'v1' },
      contract,
      { lease_id: 'L1' },
      { checks: [{ ...check, execution: 'PRE_VERIFIED', origin_event_id: 'CHK-1' }] },
      [],
      {}
    )
  ).toThrow('VERIFICATION_EXECUTION_MODE_INVALID')
})

test('the eventual Architect can prepare as soon as a route is admitted, before any Operator', () => {
  const root = mkdtempSync(join(tmpdir(), 'overlap-prepare-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    expect(() =>
      prepare(
        chain.sdd,
        'coordinator',
        'CONTRACT_DRAFT',
        'v1',
        'architect-early',
        false,
        false,
        COORDINATOR
      )
    ).toThrow('PREPARATION_STATE_INVALID')
    chain.admit()
    chain.advance('CONTRACT_ADMITTED')
    const granted = prepare(
      chain.sdd,
      'coordinator',
      'CONTRACT_ADMITTED',
      'v1',
      'architect-early',
      false,
      false,
      COORDINATOR
    )
    expect((chain.state().preparation as Item).operator_lease_id).toBeNull()
    process.env.SDD_LOOP_AGENT_TOKEN_FILE = granted.capabilityFile
    const before = readFileSync(chain.sdd + '.loop.json', 'utf8')
    // Checks wait for completed reading; the rejection writes nothing.
    expect(() =>
      prepareRecord(
        chain.sdd,
        'architect-early',
        granted.preparedId,
        'baseline_check',
        { baseline_fingerprint: 'x', checks: [], isolated_copy: 'git worktree copy' },
        'CONTRACT_ADMITTED',
        'v1',
        COORDINATOR
      )
    ).toThrow('PREPARATION_READINESS_REQUIRED')
    expect(readFileSync(chain.sdd + '.loop.json', 'utf8')).toBe(before)
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

import { assertSharedMechanismWrites } from '../scripts/domain/policies/delivery-graph'

test('shared-mechanism writes name managers and write points owned inside the planned scope', () => {
  const contract = (write: Item) =>
    ({
      ...planContract({ batches: [batch('PC01', 'R1', ['packages/a', '.'])] }),
      shared_mechanism_writes: [
        {
          mechanism: 'workspace lockfile',
          target: 'packages/a dependencies',
          managers: ['root workspace'],
          write_points: ['lockfile importer packages/a'],
          owners: ['.'],
          ...write
        }
      ]
    }) as unknown as Contract
  expect(() => assertSharedMechanismWrites(contract({}))).not.toThrow()
  expect(() => assertSharedMechanismWrites(contract({ owners: ['packages/b'] }))).toThrow(
    'SHARED_MECHANISM_OWNER_UNAUTHORIZED: packages/b'
  )
  expect(() => assertSharedMechanismWrites(contract({ managers: [] }))).toThrow(
    'SHARED_MECHANISM_WRITE_INVALID'
  )
})
