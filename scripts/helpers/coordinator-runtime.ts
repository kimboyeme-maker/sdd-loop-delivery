import { roleRuntime, runtimeMatches } from '../config/host'
import { parseHostSpawnReceipt } from '../schemas/host'

/**
 * Bind a Coordinator authority change to the actual isolated host spawn result.
 * A requested task name or a self-described model never substitutes for this receipt;
 * the controller still cannot attest host provenance beyond the submitted facts.
 * Model and isolation expectations come from the active host profile, never from host literals.
 */
export function coordinatorRuntimeReceipt(
  input: unknown,
  agentId: string
): Readonly<Record<string, string>> {
  const receipt = parseHostSpawnReceipt(input)
  if (receipt.agent_id !== agentId) throw new Error('COORDINATOR_RUNTIME_IDENTITY_MISMATCH')
  const expected = roleRuntime('coordinator')
  if (!runtimeMatches(expected, receipt)) throw new Error('COORDINATOR_RUNTIME_SELECTION_INVALID')
  // The Coordinator runs without inherited conversation turns.
  if (!expected.isolation_values.includes(receipt.isolation))
    throw new Error('COORDINATOR_RUNTIME_LINEAGE_INVALID')
  const effort = receipt.reasoning_effort ?? expected.reasoning_effort
  return {
    agent_id: receipt.agent_id,
    runtime: receipt.runtime,
    model: receipt.model,
    ...(effort === null ? {} : { reasoning_effort: effort }),
    isolation: receipt.isolation
  }
}
