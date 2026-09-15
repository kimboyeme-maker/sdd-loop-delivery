import { expect, test } from 'bun:test'
import { assertExecutionPackets } from '../scripts/domain/policies/execution-packets'

test('bounded packets require complete scope and acyclic dependencies', () => {
  const packet = {
    id: 'PC01',
    outcome: 'close cancellation race',
    requirement_ids: ['XQ01'],
    acceptance_ids: ['YS01'],
    preconditions: ['owner exists'],
    causal_scope: ['terminal callback'],
    stop_or_escalate: ['owner mismatch']
  }
  const second = { ...packet, id: 'PC02', depends_on_packet_ids: ['PC01'] }
  const check = (packets: unknown) => assertExecutionPackets(packets, ['XQ01'], ['YS01'])
  expect(() => check([second, packet])).not.toThrow()
  for (const bad of [
    [],
    [packet, packet],
    [{ ...packet, outcome: '' }],
    [{ ...packet, preconditions: [] }],
    [{ ...packet, requirement_ids: ['XQ02'] }],
    [{ ...packet, acceptance_ids: ['YS02'] }],
    [{ ...packet, depends_on_packet_ids: ['missing'] }],
    [{ ...packet, depends_on_packet_ids: ['PC01'] }],
    [{ ...packet, depends_on_packet_ids: ['PC02'] }, second]
  ])
    expect(() => check(bad)).toThrow()
  expect(() =>
    check(
      Array.from({ length: 10000 }, (_, index) => ({
        ...packet,
        id: `packet-${index}`,
        depends_on_packet_ids: index ? [`packet-${index - 1}`] : []
      }))
    )
  ).not.toThrow()
})
