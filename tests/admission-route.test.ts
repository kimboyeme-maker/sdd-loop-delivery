import { expect, test } from 'bun:test'
import { assertAdmissionRoute } from '../scripts/domain/policies/admission-route'

test('admission selects exactly one evidenced route and keeps containment explicit', () => {
  const route = { id: 'RT01', disposition: 'SELECTED', evidence: 'owner state trace' }
  const payload = {
    round_outcome: 'close race',
    rollback_or_containment: 'preserve cleanup',
    top_failure_mode: 'callback sees open state',
    early_falsifier: 'cancel before callback',
    problem_evidence: ['race trace'],
    downstream_impacts: ['callback observes closed state'],
    conventional_route: {
      summary: 'close before notify',
      applicability: 'FIT',
      evidence: 'owner trace'
    },
    selected_route_id: 'RT01',
    route_options: [route]
  }
  expect(() => assertAdmissionRoute(payload)).not.toThrow()
  expect(() =>
    assertAdmissionRoute({
      ...payload,
      route_options: [
        route,
        { id: 'RT02', disposition: 'REJECTED', evidence: 'allows double close' }
      ]
    })
  ).not.toThrow()
  for (const patch of [
    { selected_route_id: 'missing' },
    { route_options: [route, route] },
    { route_options: [route, { ...route, id: 'RT02' }] },
    { route_options: [{ ...route, evidence: '' }] },
    { route_options: [{ ...route, disposition: 'REJECTED' }] },
    { rollback_or_containment: '' },
    { downstream_impacts: [] }
  ])
    expect(() => assertAdmissionRoute({ ...payload, ...patch })).toThrow()
})
