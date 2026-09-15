import { eventsWithId } from '../utils/event-index'
import { currentAdmission } from '../helpers/admission-authority'
import { currentCandidate, assertCandidateBinding } from '../helpers/candidate-evidence'
import { assertRoleEvidence } from '../helpers/role-evidence'
import { assertPacketCoverage, assertSemanticCoverage } from '../helpers/role-coverage'
import { assertCandidateReceipt } from '../schemas/role-receipt'
import { readContractDocument } from './contract-document'

type Item = Record<string, unknown>

/** Consume the latest direct READY self-check before handing product work to Architect.
 * An aggregate self-check may have a different lease from the last packet's
 * implementation. Candidate fingerprints and current workspace bytes establish
 * applicability; a matching lease ID alone cannot establish product readiness.
 */
export function assertOperatorHandoff(
  sdd: string,
  state: Item,
  events: readonly Item[],
  token: string | undefined
): Item {
  const checkId = (state.last_role_events as Item | undefined)?.self_check
  const checks = eventsWithId(events, checkId)
  const check = checks[0]
  if (
    checks.length !== 1 ||
    !check ||
    check.type !== 'self_check' ||
    check.state !== 'OPERATOR_SELF_CHECK'
  )
    throw new Error('HANDOFF_SELF_CHECK_REQUIRED')
  assertRoleEvidence(state, check, 'operator')
  const payload = check.payload as Item
  if (payload.result !== 'PASS' || payload.handoff_status !== 'READY_FOR_ARCHITECT')
    throw new Error('ARCHITECT_DISPATCH_REQUIRES_READY_OPERATOR_SELF_CHECK')
  const { event: implementation, candidate } = currentCandidate(sdd, state, events)
  if (events.indexOf(check) <= events.indexOf(implementation))
    throw new Error('HANDOFF_SELF_CHECK_REQUIRED')
  assertCandidateBinding(payload, candidate)
  const admission = currentAdmission(state, events, token).payload as Item
  assertSemanticCoverage(state, admission, check)
  assertPacketCoverage(state, admission, events, check)
  assertCandidateReceipt(payload.candidate_receipt)
  const receipt = payload.candidate_receipt as Item
  const oracle = receipt.oracle_sensitivity as Item
  const contract = readContractDocument(sdd)
  if (!contract) throw new Error('OPERATOR_CANDIDATE_ADMISSION_MISSING')
  const admitted = new Set(admission.acceptance_ids as string[])
  const required = (contract.acceptance as Item[])
    .filter(
      (item) =>
        admitted.has(String(item.id)) &&
        (item.oracle_sensitivity as Item | undefined)?.applicability === 'REQUIRED'
    )
    .map((item) => String(item.id))
  const equal = (a: readonly string[], b: readonly string[]) => {
    const left = new Set(a),
      right = new Set(b)
    return left.size === right.size && [...left].every((id) => right.has(id))
  }
  if (required.length) {
    if (oracle.status !== 'PASS' || !equal(required, oracle.acceptance_ids as string[]))
      throw new Error('OPERATOR_ORACLE_SENSITIVITY_COVERAGE_INVALID')
  } else if (oracle.status !== 'NOT_APPLICABLE' || (oracle.acceptance_ids as string[]).length)
    throw new Error('OPERATOR_ORACLE_SENSITIVITY_NOT_APPLICABLE_INVALID')
  // Aggregate only authenticated implementations from this entry into IMPLEMENTING.
  const entered = events.findLastIndex(
    (event) => event.type === 'state_transition' && (event.payload as Item)?.to === 'IMPLEMENTING'
  )
  const changed = events
    .slice(entered + 1)
    .filter((event) => {
      if (
        event.type !== 'implementation' ||
        event.role !== 'operator' ||
        event.contract_revision !== state.contract_revision
      )
        return false
      assertRoleEvidence(state, event, 'operator')
      return true
    })
    .flatMap((event) => (event.payload as Item).changed_packages as string[])
  if (!equal(changed, (receipt.modification_scope as Item).changed_packages as string[]))
    throw new Error('OPERATOR_CANDIDATE_SCOPE_IMPLEMENTATION_MISMATCH')
  // The receipt's path list must be the candidate's actual manifest, including renames.
  const manifestPaths = ((candidate.changes as Item[] | undefined) ?? []).flatMap((change) =>
    change.action === 'RENAMED' ? [change.from_path, change.to_path] : [change.path]
  ) as string[]
  if (!equal(manifestPaths, (receipt.modification_scope as Item).changed_paths as string[]))
    throw new Error('OPERATOR_WORKTREE_MANIFEST_INCOMPLETE')
  return check
}
