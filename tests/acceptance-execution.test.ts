import { expect, test } from 'bun:test'
import {
  assertAcceptanceExecution,
  assertOracleSensitivity
} from '../scripts/domain/policies/acceptance-execution'
import type { Contract } from '../scripts/domain/contract'

function fixture(): Contract & { acceptance: Record<string, unknown>[] } {
  return {
    revision: 'v1',
    requirements: [],
    acceptance: ['YS01', 'YS02'].map((id) => ({
      id,
      method: `run ${id}`,
      environment: 'local isolated fixture',
      execution: {
        isolation: 'INDEPENDENT',
        timeout_seconds: 30,
        readiness_oracle: 'fixture ready',
        state_boundary: 'one fixture instance',
        evidence_boundary: `result-${id}`,
        blocking_acceptance_ids: []
      }
    }))
  }
}

test('execution uses bounded numeric timeouts, explicit readiness and separate evidence', () => {
  // Acceptance executions are capped at 15 minutes so tests cannot absorb long gates.
  for (const invalid of [undefined, null, true, '30', 0, -1, 0.5, 901, Infinity, NaN]) {
    const contract = fixture()
    ;(contract.acceptance[0]!.execution as Record<string, unknown>).timeout_seconds = invalid
    expect(() => assertAcceptanceExecution(contract)).toThrow(
      'ACCEPTANCE_EXECUTION_TIMEOUT_INVALID'
    )
  }
  for (const timeout of [1, 900]) {
    const contract = fixture()
    ;(contract.acceptance[0]!.execution as Record<string, unknown>).timeout_seconds = timeout
    expect(() => assertAcceptanceExecution(contract)).not.toThrow()
  }
  for (const field of ['readiness_oracle', 'state_boundary', 'evidence_boundary']) {
    const contract = fixture()
    ;(contract.acceptance[0]!.execution as Record<string, unknown>)[field] = ' '
    expect(() => assertAcceptanceExecution(contract)).toThrow(
      'ACCEPTANCE_EXECUTION_BOUNDARY_REQUIRED'
    )
  }
  const contract = fixture()
  ;(contract.acceptance[1]!.execution as Record<string, unknown>).evidence_boundary =
    ' RESULT-ys01 '
  expect(() => assertAcceptanceExecution(contract)).toThrow(
    'ACCEPTANCE_EVIDENCE_BOUNDARY_DUPLICATE'
  )
})

test('shared execution cannot claim independence or omit failure containment', () => {
  const contract = fixture()
  contract.acceptance[1]!.method = contract.acceptance[0]!.method
  expect(() => assertAcceptanceExecution(contract)).toThrow('ACCEPTANCE_INDEPENDENT_TARGET_REUSED')
  for (const acceptance of contract.acceptance) {
    const execution = acceptance.execution as Record<string, unknown>
    execution.isolation = 'SHARED_SAFE'
    execution.failure_containment = 'restore fixture after check failure'
  }
  expect(() => assertAcceptanceExecution(contract)).not.toThrow()
  delete (contract.acceptance[0]!.execution as Record<string, unknown>).failure_containment
  expect(() => assertAcceptanceExecution(contract)).toThrow(
    'ACCEPTANCE_FAILURE_CONTAINMENT_REQUIRED'
  )
})

test('acceptance dependency graph rejects missing, repeated, self and cyclic edges', () => {
  const run = (first: unknown, second: unknown) => {
    const contract = fixture()
    ;(contract.acceptance[0]!.execution as Record<string, unknown>).blocking_acceptance_ids = first
    ;(contract.acceptance[1]!.execution as Record<string, unknown>).blocking_acceptance_ids = second
    return () => assertAcceptanceExecution(contract)
  }
  expect(run([], ['YS01'])).not.toThrow()
  expect(run(['YS02'], [])).not.toThrow()
  expect(run(['YS02'], ['YS01'])).toThrow('ACCEPTANCE_EXECUTION_DEPENDENCY_CYCLE')
  expect(run(['YS01'], [])).toThrow('ACCEPTANCE_EXECUTION_DEPENDENCY_SCOPE_INVALID')
  expect(run([], ['YS99'])).toThrow('ACCEPTANCE_EXECUTION_DEPENDENCY_SCOPE_INVALID')
  expect(run([], ['YS01', 'YS01'])).toThrow('ACCEPTANCE_EXECUTION_DEPENDENCIES_INVALID')
  expect(run([], undefined)).toThrow('ACCEPTANCE_EXECUTION_DEPENDENCIES_INVALID')
})

test('oracle sensitivity needs a reversible perturbation plan and honest evidence timing', () => {
  const valid = {
    applicability: 'REQUIRED',
    fault_model: 'duplicate completion',
    perturbation_method: 'inject second callback',
    restoration_method: 'remove injected callback and reset fixture',
    expected_flip: 'PASS_TO_FAIL_TO_PASS',
    implementation_timing: 'IMPLEMENTATION_REQUIRED'
  }
  expect(() => assertOracleSensitivity(undefined)).not.toThrow()
  expect(() =>
    assertOracleSensitivity({
      applicability: 'NOT_APPLICABLE',
      reason: 'pure enumeration with no runtime oracle'
    })
  ).not.toThrow()
  expect(() => assertOracleSensitivity({ applicability: 'NOT_APPLICABLE' })).toThrow(
    'ORACLE_SENSITIVITY_REASON_REQUIRED'
  )
  expect(() => assertOracleSensitivity(valid)).not.toThrow()
  for (const field of ['fault_model', 'perturbation_method', 'restoration_method', 'expected_flip'])
    expect(() => assertOracleSensitivity({ ...valid, [field]: '' })).toThrow(
      'ORACLE_SENSITIVITY_PROCEDURE_REQUIRED'
    )
  expect(() => assertOracleSensitivity({ ...valid, implementation_timing: 'LATER' })).toThrow(
    'ORACLE_SENSITIVITY_TIMING_INVALID'
  )
  expect(() =>
    assertOracleSensitivity({ ...valid, implementation_timing: 'DESIGN_PROVEN' })
  ).toThrow('ORACLE_SENSITIVITY_EVIDENCE_REQUIRED')
  expect(() =>
    assertOracleSensitivity({
      ...valid,
      implementation_timing: 'DESIGN_PROVEN',
      evidence: ['independent fault-injection result']
    })
  ).not.toThrow()
  const contract = fixture()
  contract.acceptance[0]!.oracle_sensitivity = { applicability: 'REQUIRED' }
  expect(() => assertAcceptanceExecution(contract)).toThrow('ORACLE_SENSITIVITY_PROCEDURE_REQUIRED')
})

test('a consumed artifact names a blocking producer or an external source bound to the candidate', () => {
  const consuming = (use: Record<string, unknown>, blocking: string[] = []) => {
    const contract = fixture()
    Object.assign(contract.acceptance[1]!.execution as Record<string, unknown>, {
      blocking_acceptance_ids: blocking,
      consumes: [
        {
          artifact: 'static site build',
          candidate_binding: 'current candidate fingerprint',
          ...use
        }
      ]
    })
    return contract
  }
  expect(() =>
    assertAcceptanceExecution(consuming({ produced_by: 'YS01' }, ['YS01']))
  ).not.toThrow()
  expect(() => assertAcceptanceExecution(consuming({ produced_by: 'YS01' }))).toThrow(
    'ACCEPTANCE_ARTIFACT_PRODUCER_NOT_BLOCKING'
  )
  expect(() =>
    assertAcceptanceExecution(
      consuming({ produced_by: 'external', source: 'registry release 1.2.3' })
    )
  ).not.toThrow()
  expect(() => assertAcceptanceExecution(consuming({ produced_by: 'external' }))).toThrow(
    'ACCEPTANCE_ARTIFACT_CONSUMPTION_INVALID'
  )
  expect(() =>
    assertAcceptanceExecution(consuming({ produced_by: 'YS01', candidate_binding: ' ' }, ['YS01']))
  ).toThrow('ACCEPTANCE_ARTIFACT_CONSUMPTION_INVALID')
})
