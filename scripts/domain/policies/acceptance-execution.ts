import type { Contract } from '../contract'
import { semanticName } from '../../utils/semantic-name'
import { ACCEPTANCE_TIMEOUT_MAX_SECONDS } from '../../config/constants'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(text) && new Set(value).size === value.length

/**
 * Check declared execution boundaries before admitting a route. A timeout is an
 * integer number of seconds; a shared target needs explicit failure containment.
 * Graph validation is iterative so large valid inventories do not exhaust the stack.
 * This validates the plan, not actual command execution or successful isolation.
 */
export function assertAcceptanceExecution(contract: Contract): void {
  if (!Array.isArray(contract.acceptance) || !contract.acceptance.length)
    throw new Error('CONTRACT_ACCEPTANCE_REQUIRED')
  const boundaries = new Set<string>()
  const independentTargets = new Set<string>()
  const dependencies = new Map<string, string[]>()
  for (const value of contract.acceptance) {
    const acceptance = record(value),
      execution = record(acceptance?.execution)
    if (!acceptance || !text(acceptance.id) || dependencies.has(acceptance.id))
      throw new Error('CONTRACT_ACCEPTANCE_INVALID')
    if (!execution) throw new Error('ACCEPTANCE_EXECUTION_REQUIRED')
    if (
      !Number.isSafeInteger(execution.timeout_seconds) ||
      Number(execution.timeout_seconds) < 1 ||
      (Number(execution.timeout_seconds) > ACCEPTANCE_TIMEOUT_MAX_SECONDS &&
        !text(execution.timeout_reason))
    )
      throw new Error('ACCEPTANCE_EXECUTION_TIMEOUT_INVALID')
    if (
      !['readiness_oracle', 'state_boundary', 'evidence_boundary'].every((key) =>
        text(execution[key])
      )
    )
      throw new Error('ACCEPTANCE_EXECUTION_BOUNDARY_REQUIRED')
    const boundary = semanticName(execution.evidence_boundary as string)
    if (boundaries.has(boundary)) throw new Error('ACCEPTANCE_EVIDENCE_BOUNDARY_DUPLICATE')
    boundaries.add(boundary)
    if (execution.isolation === 'INDEPENDENT') {
      if (!text(acceptance.method) || !text(acceptance.environment))
        throw new Error('CONTRACT_ACCEPTANCE_INVALID')
      const target = JSON.stringify([acceptance.method, acceptance.environment])
      if (independentTargets.has(target)) throw new Error('ACCEPTANCE_INDEPENDENT_TARGET_REUSED')
      independentTargets.add(target)
    } else if (execution.isolation === 'SHARED_SAFE') {
      if (!text(execution.failure_containment))
        throw new Error('ACCEPTANCE_FAILURE_CONTAINMENT_REQUIRED')
    } else throw new Error('ACCEPTANCE_EXECUTION_ISOLATION_INVALID')
    if (!strings(execution.blocking_acceptance_ids))
      throw new Error('ACCEPTANCE_EXECUTION_DEPENDENCIES_INVALID')
    dependencies.set(acceptance.id, execution.blocking_acceptance_ids)
    // A consumed artifact names its producer: another acceptance that blocks this one, or an
    // external source; either way it binds the candidate it must come from.
    if (execution.consumes !== undefined) {
      if (!Array.isArray(execution.consumes))
        throw new Error('ACCEPTANCE_ARTIFACT_CONSUMPTION_INVALID')
      for (const raw of execution.consumes) {
        const use = record(raw)
        if (!use || !text(use.artifact) || !text(use.produced_by) || !text(use.candidate_binding))
          throw new Error('ACCEPTANCE_ARTIFACT_CONSUMPTION_INVALID')
        if (use.produced_by === 'external') {
          if (!text(use.source)) throw new Error('ACCEPTANCE_ARTIFACT_CONSUMPTION_INVALID')
        } else if (!execution.blocking_acceptance_ids.includes(use.produced_by))
          throw new Error(
            `ACCEPTANCE_ARTIFACT_PRODUCER_NOT_BLOCKING: ${acceptance.id}/${use.produced_by}`
          )
      }
    }
    assertOracleSensitivity(acceptance.oracle_sensitivity)
  }
  const pending = new Map<string, number>(),
    consumers = new Map<string, string[]>()
  for (const [id, upstream] of dependencies) {
    if (upstream.some((dependency) => dependency === id || !dependencies.has(dependency)))
      throw new Error('ACCEPTANCE_EXECUTION_DEPENDENCY_SCOPE_INVALID')
    pending.set(id, upstream.length)
    for (const dependency of upstream)
      consumers.set(dependency, [...(consumers.get(dependency) ?? []), id])
  }
  const ready = [...pending].filter(([, count]) => count === 0).map(([id]) => id)
  for (let index = 0; index < ready.length; index++) {
    for (const consumer of consumers.get(ready[index]!) ?? []) {
      const remaining = pending.get(consumer)! - 1
      pending.set(consumer, remaining)
      if (remaining === 0) ready.push(consumer)
    }
  }
  if (ready.length !== dependencies.size) throw new Error('ACCEPTANCE_EXECUTION_DEPENDENCY_CYCLE')
}

/**
 * A PASS covering a REQUIRED sensitive oracle carries exactly one executed perturbation
 * result per such acceptance. Declared plans at admission are not execution evidence.
 */
export function assertOracleSensitivityResults(
  requiredIds: readonly string[],
  value: unknown
): void {
  if (!requiredIds.length) {
    if (value !== undefined && (!Array.isArray(value) || value.length))
      throw new Error('ORACLE_SENSITIVITY_RESULT_SCOPE_INVALID')
    return
  }
  if (!Array.isArray(value)) throw new Error('ORACLE_SENSITIVITY_RESULTS_REQUIRED')
  const seen = new Set<string>()
  for (const item of value) {
    const result = record(item)
    if (
      !result ||
      typeof result.acceptance_id !== 'string' ||
      !text(result.perturbation) ||
      result.result !== 'PASS_TO_FAIL_TO_PASS' ||
      !strings(result.evidence) ||
      !result.evidence.length
    )
      throw new Error('ORACLE_SENSITIVITY_RESULT_INVALID')
    if (!requiredIds.includes(result.acceptance_id) || seen.has(result.acceptance_id))
      throw new Error('ORACLE_SENSITIVITY_RESULT_SCOPE_INVALID')
    seen.add(result.acceptance_id)
  }
  if (seen.size !== new Set(requiredIds).size)
    throw new Error('ORACLE_SENSITIVITY_RESULTS_REQUIRED')
}

/**
 * A sensitive oracle must specify how a deliberate fault flips PASS to FAIL and
 * how restoration returns PASS. IMPLEMENTATION_REQUIRED describes future work;
 * DESIGN_PROVEN additionally requires evidence, never an inferred success.
 * Absence remains valid for ordinary checks; runtime removal requires it separately.
 */
export function assertOracleSensitivity(value: unknown): void {
  if (value === undefined || value === null) return
  const sensitivity = record(value)
  if (!sensitivity) throw new Error('ORACLE_SENSITIVITY_INVALID')
  if (sensitivity.applicability === 'NOT_APPLICABLE') {
    if (!text(sensitivity.reason)) throw new Error('ORACLE_SENSITIVITY_REASON_REQUIRED')
    return
  }
  if (sensitivity.applicability !== 'REQUIRED') throw new Error('ORACLE_SENSITIVITY_INVALID')
  if (
    !['fault_model', 'perturbation_method', 'restoration_method'].every((key) =>
      text(sensitivity[key])
    ) ||
    sensitivity.expected_flip !== 'PASS_TO_FAIL_TO_PASS'
  )
    throw new Error('ORACLE_SENSITIVITY_PROCEDURE_REQUIRED')
  if (
    sensitivity.implementation_timing !== 'DESIGN_PROVEN' &&
    sensitivity.implementation_timing !== 'IMPLEMENTATION_REQUIRED'
  )
    throw new Error('ORACLE_SENSITIVITY_TIMING_INVALID')
  if (
    sensitivity.implementation_timing === 'DESIGN_PROVEN' &&
    (!strings(sensitivity.evidence) || !sensitivity.evidence.length)
  )
    throw new Error('ORACLE_SENSITIVITY_EVIDENCE_REQUIRED')
}
