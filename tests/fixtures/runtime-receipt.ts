import { roleRuntime } from "../../scripts/config/host";

/** Synthetic host spawn receipt for the configured Coordinator runtime; not host provenance. */
export function coordinatorReceipt(agentId: string) {
  return {
    protocol: "host-spawn-receipt/v1",
    agent_id: agentId,
    runtime: "fixture-host",
    model: roleRuntime("coordinator").spawn_model ?? "host-default",
    reasoning_effort: roleRuntime("coordinator").reasoning_effort ?? "medium",
    isolation: "none",
  };
}
