import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandPlannedPackets } from '../scripts/domain/planned-packets'
import { chargeCredit, creditLedger } from '../scripts/helpers/credit-ledger'
import { programStatus } from '../scripts/services/program-status'
import { initLoop } from '../scripts/controllers/init.controller'
import { admissionFixture } from './fixtures/admission'
import { COORDINATOR, createNativeChain } from './fixtures/native-chain'
import { userControl } from '../scripts/controllers/user-control.controller'
import { coordinatorBrief } from '../scripts/services/coordinator-brief'

type Item = Record<string, unknown>

test('admitted packets take their graph from the delivery plan and cannot restate it differently', () => {
  const budget = { minutes: 5, max_new_test_files: 0 }
  const contract = {
    delivery_plan: {
      protocol: 'delivery-plan/v1',
      batches: [
        {
          id: 'PC01',
          requirement_ids: ['XQ01'],
          acceptance_ids: ['YS01'],
          modification_packages: ['packages/a'],
          depends_on: [],
          test_budget: budget
        },
        {
          id: 'PC02',
          requirement_ids: ['XQ02'],
          acceptance_ids: ['YS02'],
          modification_packages: ['packages/b'],
          depends_on: ['PC01'],
          test_budget: budget
        }
      ]
    }
  }
  const guidance = (id: string) => ({
    id,
    outcome: `deliver ${id}`,
    preconditions: ['baseline frozen'],
    causal_scope: ['owned package'],
    stop_or_escalate: ['owner differs']
  })
  const expanded = expandPlannedPackets(contract, {
    decision: 'ADMIT',
    execution_packets: [guidance('PC01'), guidance('PC02')]
  }).execution_packets as Item[]
  expect(expanded[1]).toMatchObject({
    requirement_ids: ['XQ02'],
    modification_packages: ['packages/b'],
    test_budget: budget,
    depends_on_packet_ids: ['PC01']
  })
  // A dependency satisfied by an earlier admission is prior evidence, not a packet edge.
  const later = expandPlannedPackets(contract, { execution_packets: [guidance('PC02')] })
  expect((later.execution_packets as Item[])[0]!.depends_on_packet_ids).toBeUndefined()
  expect(() =>
    expandPlannedPackets(contract, {
      execution_packets: [{ ...guidance('PC01'), modification_packages: ['packages/b'] }]
    })
  ).toThrow('EXECUTION_PACKET_PLAN_RESTATEMENT_MISMATCH: PC01/modification_packages')
  expect(
    expandPlannedPackets(contract, {
      execution_packets: [
        { ...guidance('PC01'), test_budget: { max_new_test_files: 0, minutes: 5 } }
      ]
    })
  ).toBeTruthy()
  const unplanned = { execution_packets: [guidance('PC99')] }
  expect(expandPlannedPackets(contract, unplanned)).toEqual(unplanned)
  expect(expandPlannedPackets(null, unplanned)).toBe(unplanned)
})

test('the credit ledger stops new grants at its budget but records work that already ran', () => {
  const state = {
    credit_ledger: {
      protocol: 'credit-ledger/v1' as const,
      mode: 'enforce' as const,
      budget: 5,
      spent: 4
    }
  }
  expect(chargeCredit(state, 1)).toEqual({ ...state.credit_ledger, spent: 5 })
  // An observing ledger records spend past its budget instead of stopping.
  expect(
    chargeCredit({ credit_ledger: { ...state.credit_ledger, mode: 'observe' as const } }, 2)!.spent
  ).toBe(6)
  expect(() => chargeCredit(state, 2)).toThrow('CREDIT_BUDGET_EXHAUSTED')
  expect(chargeCredit(state, 2, { allowOverrun: true })!.spent).toBe(6)
  expect(chargeCredit({}, 3)).toBeUndefined()
  expect(() => creditLedger({ credit_ledger: { budget: -1, spent: 0 } })).toThrow(
    'CREDIT_LEDGER_INVALID'
  )
})

test('program status aggregates independent SDD controllers and flags overlapping write sets', () => {
  const root = mkdtempSync(join(tmpdir(), 'program-status-'))
  try {
    const foundation = join(root, 'foundation.sdd.md')
    writeFileSync(foundation, admissionFixture('packages/api').source)
    initLoop(foundation, 2)
    const program = join(root, 'session.program.md')
    writeFileSync(
      program,
      [
        '# Session program',
        '',
        '| ID | description | role | sdd | write_set | depends_on |',
        '| --- | --- | --- | --- | --- | --- |',
        '| PG01 | Freeze interfaces | FOUNDATION | foundation.sdd.md | packages/api | |',
        '| PG02 | Storage child | CHILD | storage.sdd.md | packages/storage | PG01 |',
        '| PG03 | Storage cache child | CHILD | cache.sdd.md | packages/storage/cache | PG01 |',
        '| PG04 | Unrelated docs child | CHILD | docs.sdd.md | docs/session | |',
        ''
      ].join('\n')
    )
    const status = programStatus(program)
    expect((status.sdds as Item[]).map((entry) => entry.status)).toEqual([
      'STARTED',
      'NOT_STARTED',
      'NOT_STARTED',
      'NOT_STARTED'
    ])
    expect((status.sdds as Item[])[0]!.phase).toBe('DISCOVER')
    expect((status.sdds as Item[])[0]!.credit).toMatchObject({ budget: 120, spent: 0 })
    // Children wait for the foundation to SHIP; the independent child may start now.
    expect(status.ready_to_start).toEqual(['PG04'])
    expect(status.write_set_conflicts).toEqual(['PG02/PG03'])
    expect(() => programStatus(join(root, 'missing.program.md'))).toThrow('PROGRAM_PLAN_NOT_FOUND')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an exhausted credit ledger stops new grants until the user extends it', () => {
  const root = mkdtempSync(join(tmpdir(), 'credit-ledger-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    chain.admit()
    chain.advance('CONTRACT_ADMITTED', 'OPERATOR_READBACK')
    const statePath = chain.sdd + '.loop.json'
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    // New ledgers only observe; a hard ceiling is an explicit enforce choice.
    expect(state.credit_ledger.mode).toBe('observe')
    const exhausted = { ...state.credit_ledger, spent: state.credit_ledger.budget, mode: 'enforce' }
    writeFileSync(statePath, JSON.stringify({ ...state, credit_ledger: exhausted }))
    expect(() => chain.start('operator')).toThrow('CREDIT_BUDGET_EXHAUSTED')
    expect(coordinatorBrief(chain.sdd).obligations).toContain('REQUEST_CREDIT_EXTENSION')
    // Only an explicit user decision raises the ceiling; phase and history are unchanged.
    userControl(
      chain.sdd,
      'coordinator',
      'OPERATOR_READBACK',
      'v1',
      'extend-credit',
      'user approved ten more units',
      'yes',
      undefined,
      undefined,
      COORDINATOR,
      10
    )
    expect(chain.state()).toMatchObject({
      phase: 'OPERATOR_READBACK',
      credit_ledger: { budget: exhausted.budget + 10, spent: exhausted.spent }
    })
    chain.start('operator')
    expect((chain.state().credit_ledger as Item).spent).toBe(exhausted.spent + 3)
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the Coordinator brief is a compact projection that tracks obligations and staleness', () => {
  const root = mkdtempSync(join(tmpdir(), 'coordinator-brief-'))
  const chain = createNativeChain(root)
  try {
    chain.setup()
    const draft = coordinatorBrief(chain.sdd)
    expect(draft).toMatchObject({
      protocol: 'coordinator-brief/v1',
      phase: 'CONTRACT_DRAFT',
      admission: null,
      obligations: ['RECORD_CONTRACT_ADMISSION']
    })
    chain.admit()
    const admitted = coordinatorBrief(chain.sdd)
    expect(admitted.brief_fingerprint).not.toBe(draft.brief_fingerprint)
    expect(admitted.obligations).toEqual(['TRANSITION_CONTRACT_ADMITTED'])
    const lease = chain.readback()
    chain.advance('READBACK_APPROVED', 'IMPLEMENTING')
    expect(coordinatorBrief(chain.sdd).obligations).toEqual(['SUPERVISE_ACTIVE_LEASE'])
    chain.implement(lease, 'export const value = 2;')
    const implemented = coordinatorBrief(chain.sdd)
    expect((implemented.admission as Item).packets).toEqual([
      expect.objectContaining({ id: 'PC01', implemented: true, packet_checks: 0 })
    ])
    // Identifiers only: no payload, verdict text or diff enters the Coordinator's working memory.
    expect(JSON.stringify(implemented)).not.toContain('export const value')
    expect(JSON.stringify(implemented).length).toBeLessThan(6000)
  } finally {
    chain.restore()
    rmSync(root, { recursive: true, force: true })
  }
})
