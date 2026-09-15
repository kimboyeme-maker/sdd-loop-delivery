import { eventsWithId } from '../utils/event-index'
import { verifyRoleEvent } from '../resource/role-signature'
import { assertRoleEvidence } from './role-evidence'

type Item = Record<string, unknown>

/** Who a measured run must belong to: a formal lease, or a preparation grant and its key. */
export type RunOwner = Readonly<
  { lease_id: string } | { prepared_id: string; event_public_key: string }
>

/**
 * A reported check is exactly one controller-measured `test_run` of its owner: same revision,
 * authenticated, inputs frozen by the controller when it started (optionally the expected
 * candidate), acceptance inside the run, and outcome and duration equal to the measurement.
 * Verification checks and measured prepared checks use this one rule.
 */
export function assertMeasuredCheck(
  state: Item,
  events: readonly Item[],
  check: Item,
  owner: RunOwner,
  expectations: Readonly<{ candidateEventId?: string | null }> = {}
): Item {
  if (typeof check.test_run_event_id !== 'string')
    throw new Error('VERIFICATION_TEST_RUN_REQUIRED: run the check through test-run')
  const runs = eventsWithId(events, check.test_run_event_id)
  const run = runs[0]
  const measured = run?.payload as Item | undefined
  const actor = run?.actor as Item | undefined
  const owned =
    'lease_id' in owner
      ? actor?.lease_id === owner.lease_id
      : actor?.prepared_id === owner.prepared_id
  if (
    runs.length !== 1 ||
    !run ||
    !measured ||
    !owned ||
    run.type !== 'test_run' ||
    run.role !== 'architect' ||
    run.contract_revision !== state.contract_revision ||
    measured.controller_measured !== true ||
    (measured.inputs as Item | undefined)?.protocol !== 'execution-inputs/v1' ||
    (expectations.candidateEventId !== undefined &&
      (measured.inputs as Item).candidate_event_id !== expectations.candidateEventId) ||
    !Array.isArray(check.acceptance_ids) ||
    !Array.isArray(measured.acceptance_ids) ||
    (check.acceptance_ids as unknown[]).some(
      (id) => !(measured.acceptance_ids as unknown[]).includes(id)
    )
  )
    throw new Error('VERIFICATION_TEST_RUN_BINDING_INVALID')
  if ('lease_id' in owner) assertRoleEvidence(state, run, 'architect')
  else if (!verifyRoleEvent(run, owner.event_public_key))
    throw new Error('VERIFICATION_TEST_RUN_BINDING_INVALID')
  if (check.outcome !== measured.outcome || check.duration_seconds !== measured.duration_seconds)
    throw new Error('VERIFICATION_CHECK_MEASUREMENT_MISMATCH')
  if (check.outcome === 'PASS')
    assertNoCounterevidence(events, run, check.acceptance_ids as string[])
  return run
}

/** Control events after which no earlier observation may stand for current evidence. */
const INVALIDATING = [
  'pipeline_incident',
  'recovery',
  'verification_revoked',
  'contract_amendment',
  'timeout_decision',
  'coordinator_takeover'
]

/**
 * A PASS observation stands only if nothing after it contradicts it: no invalidating control event
 * and no later non-PASS verdict, verification or prepared check, or measured run of the same
 * acceptance. A later passing run after a fix is new evidence and is judged from its own position.
 */
export function assertNoCounterevidence(
  events: readonly Item[],
  from: Item,
  acceptanceIds: readonly string[]
): void {
  const acceptance = new Set(acceptanceIds)
  const failing = (value: unknown) => {
    const item = value as Item | undefined
    return (
      Array.isArray(item?.acceptance_ids) &&
      (item.acceptance_ids as string[]).some((id) => acceptance.has(id)) &&
      item.outcome !== 'PASS'
    )
  }
  const start = events.indexOf(from)
  for (const later of events.slice(start < 0 ? events.length : start + 1)) {
    const data = later.payload as Item | undefined
    if (
      INVALIDATING.includes(String(later.type)) ||
      (later.type === 'verification' &&
        data?.result !== 'PASS' &&
        Array.isArray(data?.acceptance_ids) &&
        (data.acceptance_ids as string[]).some((id) => acceptance.has(id))) ||
      (['verification', 'baseline_check', 'packet_check'].includes(String(later.type)) &&
        Array.isArray(data?.checks) &&
        (data.checks as unknown[]).some(failing)) ||
      (later.type === 'test_run' && failing(data))
    )
      throw new Error('VERIFICATION_EVIDENCE_SUPERSEDED')
  }
}
