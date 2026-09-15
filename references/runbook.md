# Operator runbook (for people)

This page is for the person supervising a delivery when it looks stuck. Agents follow [recovery](recovery.md) and [coordinator](coordinator.md); this page tells you what to look at, which command to run and how to confirm it worked. Every command is:

```bash
LOOP="bun ~/.codex/skills/sdd-loop-delivery/scripts/main.ts"
SDD=/absolute/path/to/task.sdd.md
```

Run the controller on Bun `1.4.2` or newer. A repository may pin an older Bun for its own product (a workspace `mise.toml`, for example); every command then exits with `RUNTIME_BUN_TOO_OLD` naming both versions. Run the controller with your own Bun instead of the repository's pinned one.

Mutating commands authenticate with the Coordinator credential. Export it privately (`SDD_LOOP_COORDINATOR_TOKEN`, or the `capabilityFile` the controller minted) and never paste it into chats, receipts or tickets. Every mutation also needs the current `--expected-state` and `--expected-revision`; read them from `status` right before running it.

## First look

| Question | Command | What to read |
| --- | --- | --- |
| Where is the delivery? | `$LOOP status --sdd $SDD --compact` | `phase`, `contract_revision`, live leases |
| Is the history intact? | `$LOOP audit --sdd $SDD` | `valid`; any `EVENT_LOG_*` code |
| What should happen next? | `$LOOP coordinator-brief --sdd $SDD` | first `obligations` entry, `lease_deadlines`, `ship_gate` |
| Which agents should be closed, kept or started? | `$LOOP runtime-plan --sdd $SDD` | `lifecycle`, `capacity`, `expired_leases` |

Look up any error code in [error codes](error-codes.md). Rejected commands also append a line to `~/.cache/sdd-loop-delivery/<hash>.rejections.jsonl` (or `$SDD_LOOP_DIAGNOSTICS_DIR`); nothing is written next to the SDD.

Never delete or hand-edit `<SDD>.loop.json`, `<SDD>.events.jsonl` or `<SDD>.transaction.json`, and never start a replacement task to get around a gate.

## Symptoms

### Every command fails with `CONTROL_TRANSACTION_PENDING`

A commit was interrupted after its journal was written.

1. Confirm in the host that the previous Coordinator and its commands have stopped. An idle label or silence is not proof.
2. Run `$LOOP recover --kind transaction --sdd $SDD --role coordinator --expected-state <phase> --expected-revision <rev> --all-previous-writers-stopped yes`.
3. Verify: `status` succeeds and `audit` reports `valid: true`. Recovery finishes the original commit; it does not redo product work.

### Every command fails with `CONTROL_TRANSACTION_IN_PROGRESS` for minutes

A lock was left by a process that died.

1. Confirm the owner stopped (the lock file names its `pid` and `host`).
2. Hash the lock: `shasum -a 256 $SDD.loop.lock`.
3. Run `$LOOP recover --kind lock --sdd $SDD --expected-lock-hash <sha256> --owner-stopped yes --user-authorized yes`. `LOCK_OWNER_STILL_ACTIVE` or `LOCK_OWNER_POSSIBLY_ACTIVE` means the process is alive: stop it first.
4. If a journal remains, continue with the previous section. Verify with `status`.

### A test command hangs, or an agent disappeared while its tests were running

`test-run` starts every command in its own process group and records it.

1. Find the agent id from `status` (`active_lease.agent_id`, a shard lease, or the preparation grant).
2. Run `$LOOP process-reclaim --sdd $SDD --agent-id <agent id>`.
3. Read `runs`: `KILLED` groups belonged to a live `test-run`, which registers its result as `INCONCLUSIVE` with `reclaimed: true`; `STALE_RECORD_REMOVED` means its supervisor was already gone, and the group was killed only if it still ran the recorded executable.
4. Verify: `ps -A -o pgid,comm | grep <pgid>` shows nothing. The acceptance must be measured again; an inconclusive run never counts as a pass.

A timed-out command is killed together with its children automatically; you only need reclamation for runs you want to stop early or that lost their agent.

### `TEST_RUN_RESULT_UNREGISTERED`

The command ran, but authority changed before its result could be recorded (revision changed, lease revoked or consumed). The message carries the measured summary for your information. Nothing was counted: rerun under current authority.

### Brief shows `HANDLE_EXPIRED_LEASE:<lease>` or a lease past its deadline

1. Stop the agent in the host, then `process-reclaim` its test processes.
2. Operator lease with work in the worktree: `$LOOP operator-reconcile --sdd $SDD --expected-state <phase> --expected-revision <rev> --lease-id <lease> --agent-id <id> --observation-json '<json>'` with `next_action` `continue` (healthy runtime, unexpired, unchanged source) or `replace`. See [coordinator](coordinator/dispatch.md).
3. Otherwise let the Coordinator dispatch a fresh lease. Close the old runtime through `runtime-record` as `runtime-plan` lists it.
4. Verify: the obligation is gone from `coordinator-brief`.

`LEASE_DEADLINE_UNVERIFIABLE:<lease>` means the lease has no usable issue time or deadline. Treat it as expired.

### The Coordinator is gone, looping or no longer trustworthy

1. Stop it and every command it started. Recover any pending transaction first.
2. Spawn the new Coordinator and save the host's spawn receipt to a file.
3. Before delivery started: `$LOOP recover --kind bootstrap --sdd $SDD --expected-state <phase> --expected-revision <rev> --reason '<why>' --all-previous-writers-stopped yes --coordinator-agent-id <new id> --runtime-receipt-file <receipt>`.
4. Later: `$LOOP recover --kind takeover` with the same flags plus `--user-authorized yes`.
5. The command returns a new `capabilityFile`; give it only to the new Coordinator. Verify with `audit` (new epoch) and `coordinator-brief`.

### `CREDIT_BUDGET_EXHAUSTED`

Only with `--credit-mode enforce`. Decide whether the work deserves more effort, then `$LOOP user-control --sdd $SDD --role coordinator --expected-state <phase> --expected-revision <rev> --action extend-credit --credit-amount <units> --reason '<why>' --user-authorized yes`.

### `TEST_BUDGET_EXHAUSTED` or `TEST_BUDGET_EXCEEDED`

The packet's test time is spent. Do not raise limits by editing files: the Operator records an implementation escalation and the Coordinator re-plans or amends the contract.

### Brief shows `RESOLVE_SHIP_GATE:<code>`

The real SHIP gate refused. `ship_gate.message` names the reason; look the code up in [error codes](error-codes.md). `RECORD_REQUIREMENT_STATUS_THEN_SHIP` only needs requirement statuses recorded from the current PASS verdict.

### `EVENT_LOG_TAIL_AHEAD` or `EVENT_LOG_HISTORY_MISMATCH`

Commands inside a round check only the current round's lines; `audit` checks the whole history. Run `audit` after any manual copy, restore or edit near the sidecars.

- Tail ahead: an interrupted commit left extra events. Recover the transaction, or adopt the tail through `recover --kind takeover`.
- History mismatch: committed events were changed. No command repairs this. Preserve all files, report the incident and restore the sidecars from an intact copy only if you decide to.

### Agents cannot be spawned (host thread limit)

A host limit is a pipeline observation, not a product blocker. Close agents that `runtime-plan` lists under `lifecycle` as closable, then have the Coordinator record the freed capacity with `runtime-record` action `capacity` ([hosts](hosts.md)). Each new observation allows one spawn attempt.

### Pause, resume or cancel

Each command below also takes `--sdd $SDD --role coordinator --expected-state <phase> --expected-revision <rev>`.

- Pause: stop the running agent, find its signed `SAFE_TO_RESUME` checkpoint, then `user-control --action pause --checkpoint <id> --writer-stopped yes --user-authorized yes --reason '<why>'`.
- Resume: `user-control --action resume --user-authorized yes --reason '<why>'`, then dispatch normally; old leases are not restored.
- Cancel: `user-control --action cancel --user-authorized yes --reason '<why>'`. Cancelled deliveries are immutable.
