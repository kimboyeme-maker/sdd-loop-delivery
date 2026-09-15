import { assertPhaseTransition, type Phase } from '../policies/phase'

export type LoopState = Readonly<{ phase: Phase; revision: number }>

export function transitionPhase(state: LoopState, next: Phase): LoopState {
  assertPhaseTransition(state.phase, next)
  return Object.freeze({ phase: next, revision: state.revision + 1 })
}
