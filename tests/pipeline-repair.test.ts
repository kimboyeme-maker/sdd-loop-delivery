import { expect, test } from 'bun:test'
import { stagePipelineRepair } from '../scripts/helpers/pipeline-repair'

test('repair candidate binds incident and rejects unchanged hypotheses without closing it', () => {
  const state = {
    pending_pipeline_repair: { root_cause_key: 'host', reason: 'failure' },
    active_lease: null,
    completed_attempts: 2
  }
  const payload = {
    root_cause_key: 'host',
    mechanism: 'refresh host receipt',
    falsifier: 'authenticated three-stage probe fails'
  }
  expect(() => stagePipelineRepair({}, payload)).toThrow('PIPELINE_REPAIR_NOT_PENDING')
  expect(() => stagePipelineRepair(state, { ...payload, root_cause_key: 'other' })).toThrow(
    'PIPELINE_REPAIR_ROOT_MISMATCH'
  )
  expect(() => stagePipelineRepair(state, { ...payload, falsifier: ' ' })).toThrow(
    'PIPELINE_REPAIR_CANDIDATE_INVALID'
  )
  const next = stagePipelineRepair(state, payload)
  for (const history of [null, false, 0, '', [], { other: null }, { host: ['bad-hash'] }]) {
    const corrupted = { ...state, pipeline_repair_candidate_hashes: history }
    const before = JSON.stringify(corrupted)
    expect(() => stagePipelineRepair(corrupted, payload)).toThrow('PIPELINE_REPAIR_HISTORY_INVALID')
    expect(JSON.stringify(corrupted)).toBe(before)
  }
  for (const root of [undefined, null, '', ' ']) {
    expect(() =>
      stagePipelineRepair(
        { ...state, pending_pipeline_repair: { root_cause_key: root } },
        { ...payload, root_cause_key: root }
      )
    ).toThrow('PIPELINE_REPAIR_ROOT_INVALID')
  }
  expect(next).toMatchObject({
    completed_attempts: 2,
    pending_pipeline_repair: {
      root_cause_key: 'host',
      candidate: { mechanism: payload.mechanism, falsifier: payload.falsifier }
    }
  })
  expect(state.pending_pipeline_repair).toEqual({ root_cause_key: 'host', reason: 'failure' })
  expect(() => stagePipelineRepair(next, payload)).toThrow('PIPELINE_REPAIR_CANDIDATE_MUST_CHANGE')
  expect(() =>
    stagePipelineRepair(next, { ...payload, mechanism: 'replace broken transport' })
  ).not.toThrow()
})
