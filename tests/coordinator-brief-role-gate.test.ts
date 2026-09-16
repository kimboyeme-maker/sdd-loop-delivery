import { expect, test } from 'bun:test'
import { STAGE_ROLE_EVIDENCE, phaseTransitions, type Phase } from '../scripts/domain/policies/phase'

test('every stage that consumes role evidence still lists that edge as legal', () => {
  // The brief reports both, so a gate naming an edge the transition table does not have would
  // promise the Coordinator an approval path that cannot exist.
  for (const [from, gate] of Object.entries(STAGE_ROLE_EVIDENCE)) {
    expect(phaseTransitions()[from as Phase]).toContain(gate!.to)
    expect(['operator', 'architect']).toContain(gate!.role)
  }
})
