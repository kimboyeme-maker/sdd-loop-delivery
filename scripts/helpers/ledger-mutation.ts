import { nextControlRevision } from '../domain/policies/control-revision'
import { phaseTransitions } from '../domain/policies/phase'
/** Requirement and Finding updates share the same mutable lifecycle boundary.
 * Pause and terminal phases are rejected once by the caller's central mutability guard;
 * this only refuses phases the controller does not know. Return the next revision only
 * after proving integer increment remains exact.
 */
export function ledgerNextRevision(
  state: Record<string, unknown>,
  ledger: 'REQUIREMENT' | 'FINDING'
): number {
  if (!Object.hasOwn(phaseTransitions(), String(state.phase)))
    throw new Error(ledger + '_PHASE_FORBIDDEN')
  return nextControlRevision(state.revision)
}
