import { expect, test } from 'bun:test'
import { assertAdmissionScope } from '../scripts/domain/policies/admission-scope'
import type { Contract } from '../scripts/domain/contract'

test('packet acceptance cannot be swapped between unrelated requirements despite identical totals', () => {
  const contract: Contract = {
    revision: 'v1',
    requirements: [
      { id: 'XQ01', kind: 'must-ship', title: 'cancel', acceptance: ['YS01'] },
      { id: 'XQ02', kind: 'must-ship', title: 'release', acceptance: ['YS02'] }
    ]
  }
  const base = {
    outcome: 'implement and verify',
    preconditions: ['owner exists'],
    causal_scope: ['owner lifecycle'],
    stop_or_escalate: ['unexpected owner'],
    test_budget: { minutes: 5, max_new_test_files: 0 }
  }
  const first = { ...base, id: 'PC01', requirement_ids: ['XQ01'], acceptance_ids: ['YS01'] }
  const second = { ...base, id: 'PC02', requirement_ids: ['XQ02'], acceptance_ids: ['YS02'] }
  const check = (packets: unknown) =>
    assertAdmissionScope(contract, {
      requirement_ids: ['XQ01', 'XQ02'],
      acceptance_ids: ['YS01', 'YS02'],
      execution_packets: packets
    })
  expect(() => check([first, second])).not.toThrow()
  expect(() =>
    check([
      { ...first, acceptance_ids: ['YS02'] },
      { ...second, acceptance_ids: ['YS01'] }
    ])
  ).toThrow('EXECUTION_PACKET_REQUIREMENT_ACCEPTANCE_MISMATCH')
  expect(() => check([{ ...first, requirement_ids: ['XQ01', 'XQ02'] }, second])).toThrow(
    'EXECUTION_PACKET_REQUIREMENT_ACCEPTANCE_MISMATCH'
  )
  expect(() =>
    check([{ ...first, requirement_ids: ['XQ01', 'XQ02'], acceptance_ids: ['YS01', 'YS02'] }])
  ).not.toThrow()
  const shared: Contract = {
    ...contract,
    requirements: contract.requirements.map((req) => ({ ...req, acceptance: ['YS01', 'YS02'] }))
  }
  expect(() =>
    assertAdmissionScope(shared, {
      requirement_ids: ['XQ01', 'XQ02'],
      acceptance_ids: ['YS01', 'YS02'],
      execution_packets: [first, second]
    })
  ).not.toThrow()
})

test('packet order preserves admitted requirement dependencies directly or transitively', () => {
  const contract: Contract = {
    revision: 'v1',
    requirements: [
      { id: 'XQ01', kind: 'must-ship', title: 'producer', acceptance: ['YS01'] },
      {
        id: 'XQ02',
        kind: 'must-ship',
        title: 'consumer',
        dependencies: ['XQ01'],
        acceptance: ['YS02']
      },
      { id: 'XQ03', kind: 'must-ship', title: 'middle', acceptance: ['YS03'] }
    ]
  }
  const packet = (
    id: string,
    requirement: string,
    acceptance: string,
    dependencies: string[] = []
  ) => ({
    id,
    requirement_ids: [requirement],
    acceptance_ids: [acceptance],
    depends_on_packet_ids: dependencies,
    outcome: 'implement',
    preconditions: ['contract'],
    causal_scope: ['flow'],
    stop_or_escalate: ['counterexample'],
    test_budget: { minutes: 5, max_new_test_files: 0 }
  })
  const producer = packet('PC01', 'XQ01', 'YS01')
  const consumer = packet('PC02', 'XQ02', 'YS02')
  const middle = packet('PC03', 'XQ03', 'YS03')
  const check = (execution_packets: unknown) =>
    assertAdmissionScope(contract, {
      requirement_ids: ['XQ01', 'XQ02', 'XQ03'],
      acceptance_ids: ['YS01', 'YS02', 'YS03'],
      execution_packets
    })
  expect(() => check([producer, consumer, middle])).toThrow(
    'EXECUTION_PACKET_REQUIREMENT_ORDER_INVALID'
  )
  expect(() => check([{ ...producer, depends_on_packet_ids: ['PC02'] }, consumer, middle])).toThrow(
    'EXECUTION_PACKET_REQUIREMENT_ORDER_INVALID'
  )
  expect(() =>
    check([producer, { ...consumer, depends_on_packet_ids: ['PC01'] }, middle])
  ).not.toThrow()
  expect(() =>
    check([
      producer,
      { ...consumer, depends_on_packet_ids: ['PC03'] },
      { ...middle, depends_on_packet_ids: ['PC01'] }
    ])
  ).not.toThrow()
  expect(() =>
    check([
      { ...producer, requirement_ids: ['XQ01', 'XQ02'], acceptance_ids: ['YS01', 'YS02'] },
      middle
    ])
  ).not.toThrow()
  const extra = packet('PC04', 'XQ01', 'YS01')
  expect(() =>
    check([producer, extra, { ...consumer, depends_on_packet_ids: ['PC01'] }, middle])
  ).toThrow('EXECUTION_PACKET_REQUIREMENT_ORDER_INVALID')
  expect(() =>
    check([producer, extra, { ...consumer, depends_on_packet_ids: ['PC01', 'PC04'] }, middle])
  ).not.toThrow()
})
