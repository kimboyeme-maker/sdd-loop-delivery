import { ACCEPTANCE_TIMEOUT_MAX_SECONDS } from '../config/constants'
import { currentCandidateEventId } from './candidate-source'
import { assertMeasuredCheck } from './measured-check'

type Item = Record<string, unknown>
const texts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim())

/**
 * Every verification check is one controller-measured run of this lease on the current candidate:
 * its method, oracle and environment are the contract's, its outcome and duration are the run's,
 * nothing observed later contradicts it, and it stayed within the acceptance timeout. Results are
 * never carried over from another run or process; a check that is not executed now is refused.
 */
export function assertExecutionBindings(
  state: Item,
  contract: Item,
  lease: Item,
  payload: Item,
  events: readonly Item[],
  _admission: Item
): void {
  const checks = payload.checks
  if (
    !Array.isArray(checks) ||
    checks.some((check) => !check || typeof check !== 'object' || Array.isArray(check))
  )
    throw new Error('VERIFICATION_CHECK_SCHEMA_INVALID')
  const candidateEventId = currentCandidateEventId(state, events)
  for (const check of checks as Item[]) {
    if (
      !texts(check.acceptance_ids) ||
      !check.acceptance_ids.length ||
      !Array.isArray(contract.acceptance)
    )
      throw new Error('VERIFICATION_CHECK_ACCEPTANCE_SCOPE_INVALID')
    for (const id of check.acceptance_ids) {
      const definitions = (contract.acceptance as Item[]).filter((item) => item.id === id)
      if (definitions.length !== 1) throw new Error('VERIFICATION_CHECK_ACCEPTANCE_SCOPE_INVALID')
      for (const field of ['method', 'oracle', 'environment']) {
        if (typeof definitions[0]![field] !== 'string' || check[field] !== definitions[0]![field])
          throw new Error('VERIFICATION_CHECK_CONTRACT_BINDING_MISMATCH:' + id + '/' + field)
      }
    }
    if ((check.execution ?? 'EXECUTED') !== 'EXECUTED' || Object.hasOwn(check, 'origin_event_id'))
      throw new Error('VERIFICATION_EXECUTION_MODE_INVALID')
    assertMeasuredCheck(
      state,
      events,
      check,
      { lease_id: String(lease.lease_id) },
      { candidateEventId }
    )
    const limit = Math.min(
      ...(check.acceptance_ids as string[]).map((id) =>
        Number(
          (
            (contract.acceptance as Item[]).find((item) => item.id === id)?.execution as
              | Item
              | undefined
          )?.timeout_seconds ?? ACCEPTANCE_TIMEOUT_MAX_SECONDS
        )
      )
    )
    if (Number(check.duration_seconds) > limit)
      throw new Error('VERIFICATION_CHECK_TIMEOUT_EXCEEDED')
  }
}
