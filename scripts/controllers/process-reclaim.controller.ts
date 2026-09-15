import { reclaimProcesses, type ReclaimedRun } from '../resource/process-group'

/**
 * Kill the process groups `test-run` started for one agent, on a person's request or after an
 * abandoned session. Each live run then registers as INCONCLUSIVE with `reclaimed: true`; no
 * delivery state changes here.
 */
export function processReclaim(
  sdd: string,
  agentId: string
): Readonly<{ protocol: 'process-reclaim/v1'; agent_id: string; runs: ReclaimedRun[] }> {
  if (!agentId.trim()) throw new Error('PROCESS_RECLAIM_AGENT_REQUIRED')
  return { protocol: 'process-reclaim/v1', agent_id: agentId, runs: reclaimProcesses(sdd, agentId) }
}
