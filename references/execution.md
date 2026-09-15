# Context, continuity and runtime supervision

Shared rules for Operator and Architect leases, and for Coordinator supervision of them. Operator-specific receipts are in [operator](operator.md).

## Leases and scheduling

- Exactly one formal `active_lease`, plus at most one read-only Architect preparation grant, available from `CONTRACT_ADMITTED` through self-check so the eventual Architect reads while Operator readback and implementation run.
- A prepared Architect that has recorded `context_ready` may also record prepared checks on an isolated copy (never the Operator's worktree): `baseline_check` against the frozen round baseline (`baseline_fingerprint`), and `packet_check` against a packet's latest implementation (`packet_id`, `implementation_event_id`). Each check copies the contract acceptance's exact `method`, `oracle`, `environment` and `packages`, plus `outcome` and `evidence`; `isolated_copy` names how the bytes were isolated.
- An execution packet may declare its own `modification_packages` (a subset of admitted authority); Operator dispatch for that packet is confined to them. Packets with disjoint write sets and no dependency path are the parallel-safe units a `delivery_plan` describes.
- Default deadlines: Operator 30/60 minutes, Architect 20/40. At the soft deadline request a safe checkpoint and decide continuation within the issued hard deadline, narrowing, or evidenced replacement. Continuation never extends the deadline.
- A new assignment gets a fresh lease; same-assignment continuation keeps its valid lease, token, deadline, epoch and completed bootstrap.
- Confirm the previous writer and its commands stopped before issuing any replacement lease.
- Long commands record command, environment, start, timeout, last output and `PASS | FAIL | COMMAND_TIMEOUT | INCONCLUSIVE`; retry a timed-out command once at most.
- Checkpoints are recovery metadata only: they never complete a requirement, close a Finding or replace verification.

## Startup

Within the exact dispatched runtime, with `SDD_LOOP_AGENT_TOKEN_FILE` set to the `capabilityFile` returned by dispatch or prepare (the controller rejects any other path, a symlink, or a file readable by others):

```bash
bun <skill>/scripts/main.ts agent-bootstrap --sdd <sdd> --agent-id <id> --expected-state <phase> --expected-revision <rev>
bun <skill>/scripts/main.ts context-read --sdd <sdd> --agent operator --agent-id <id> [--offset N]
bun <skill>/scripts/main.ts agent-start-receipt --sdd <sdd> --agent operator --agent-id <id> --lease-id <lease> \
  --read-result <pages.json> --summary-file <summary.txt> --expected-state <phase> --expected-revision <rev> \
  [--guidance-response <file>] [--goal-ack-file <file>] [--supplement <file>]
```

- `agent-bootstrap` runs OPEN → REAUTHENTICATE → READY in three authenticated subprocesses and resumes only missing phases after an interruption. It proves token continuity, not host model or isolation.
- Consume every `context-read` page, following `nextOffset`; pass all page objects in order. A literal "yes", a hash, or only the last page is not reading evidence.
- The summary states the next observable result, check method and stop condition in the role's own words (at least 20 characters). The controller itself derives and embeds the signed `readback` (work item, packet, objective, requirement/acceptance IDs, modification packages, packet outcome, preconditions, causal scope, stop conditions); roles do not hand-copy canonical fields.
- A guided lease passes `--guidance-response <json>` with exactly `next_action`, `check_method`, `stop_condition`; the controller binds the current guidance ID and fingerprint.
- A recovery lease (resume checkpoint or Coordinator replacement) passes `--supplement <json>` with `recovery_readback`: `predecessor_lease_id`, the current `worktree_fingerprint`, non-empty `inspected_paths`, the recorded `next_action` and an own-words `summary`. No product evidence is accepted before this start.
- A goal-enabled Operator lease first creates the returned phase Goal with the host `goal_create` operation (objective exactly as returned), then passes `{protocol, fingerprint, created: true}` as the goal ack. On a host without `goal_create`, dispatch with `--operator-goal unavailable`. Where creation fails while the thread already has a Goal, a reused Operator first completes its finished Goal with `goal_complete` only when that work is truly done; if an unfinished foreign Goal remains, dispatch with `--operator-goal unavailable` and a reason rather than fabricating an ack. Mark the phase Goal complete with `goal_complete` only after the controller accepted the completion evidence.
- A rejected start caused only by payload wording or ordering is corrected under the same lease; do not repeat bootstrap or reading.

## Reading reuse

- Same runtime with genuinely retained understanding: `context-read --retained-understanding`; unchanged sources covered by its signed reads in this epoch are omitted. Compaction or uncertainty means reread. `--fresh` disables reuse.
- Unchanged sections inside a changed source are reusable only when the heading layout is identical; otherwise read the whole source.
- Operator same-lease refresh: `agent-record --type context_refresh` with `read_result` and `summary`; normative drift still needs amendment.
- A fresh independent Architect may reuse its own preparation reads, never another runtime's memory or verdict.

## Test budget

Tests serve the admitted outcome; they never become a project of their own.

- Every admitted packet carries `test_budget: {minutes, max_new_test_files}`. Defaults are at most 15 minutes, one new test file and (for a planned batch) a third of its estimate. Exceeding a default requires `acceptance_basis: {acceptance_ids, reason}` naming the necessary acceptance and concrete time or layer-boundary reason; it does not authorize unrelated tests. A packet cannot exceed its planned batch budget. `minutes: 0` keeps Operator test execution disabled and permits a self-check with `test_run_event_ids: []`; independent acceptance remains required.
- `implementation` rejects more `CREATED` test files than the packet allows (`TEST_SPRAWL_FORBIDDEN`) and any test change whose `acceptance_ids` fall outside the packet (`TEST_CHANGE_SCOPE_INVALID`). Fixing an unrelated failing gate is not packet work: classify it scope-external instead.
- Run every acceptance command through `test-run --sdd <sdd> --agent operator --agent-id <id> --lease-id <lease> --expected-state <phase> --expected-revision <rev> --acceptance-ids YS01[,YS02] --command-json '["bun","test","..."]'`. The controller starts the command in its own process group, times it, kills the whole group (background children included) at the smaller of the acceptances' `timeout_seconds` and the round's remaining test budget, kills anything the command leaves running after it exits, strips capability variables from its environment, and records a signed `test_run` (`outcome`, `duration_seconds`, `timed_out`, `reclaimed`, `exit_code`, `output_sha256`, `output_bytes`, bounded `output_tail`). Output is written to a file, so its size never changes the outcome. A killed group (timeout, reclamation or an outside `SIGKILL`) is `INCONCLUSIVE`; a command that cannot start is `NOT_RUN`. `process-reclaim --sdd <sdd> --agent-id <id>` kills every group `test-run` started for that agent, on a person's request or after an abandoned session; each live run then registers as `INCONCLUSIVE` with `reclaimed: true`. Roles cannot record `test_run` directly.
- A READY `self_check` cites `test_run_event_ids` taken on the current candidate, within the claimed packets' budget (`TEST_BUDGET_EXCEEDED`). `test-run` authorizes the role first (lease, credential, start, deadline) and then bounds the run by the acceptance timeout, the lease's remaining time and two allowances computed from signed runs: the packet's (twice its budget) and the round's (twice all packet budgets). Either allowance at zero fails `TEST_BUDGET_EXHAUSTED`; escalate instead of widening tests. Closing the round starts a new clock.
- Every grant records relative credit units in the ledger created at `init` (`--credit-budget`, default 60 units per round): standard Operator or Architect lease 3, escalated Operator 5, bounded Operator or repair probe 1, preparation 1, each started test minute 1. Units estimate effort; they are not billed tokens. The default `--credit-mode observe` records spend and reports `budgets.credit.over_budget`; `--credit-mode enforce` makes the budget a hard ceiling where `CREDIT_BUDGET_EXHAUSTED` stops new grants until `user-control --action extend-credit --credit-amount N`.
- `test-run --preset <name> [--command-json '[extra args]']` prefixes a standard surface command (bun-test, playwright, playwright-axe, lighthouse, cargo-test, go-test, pytest, flutter-test, xcodebuild, gradle, hvigor, miniprogram-automator and more; see `capabilities`). An unknown preset fails `TEST_RUN_PRESET_UNKNOWN`.
- Acceptance `timeout_seconds` defaults to a ceiling of 900; larger positive safe integers require a concrete `execution.timeout_reason`. Runtime execution remains bounded by the lease and admitted budget; select a sufficient lease before launch. Architect measurements must fit that declared timeout (`VERIFICATION_CHECK_TIMEOUT_EXCEEDED`).
- `WORKTREE_FOREIGN_CONTROLLER_STATE` means another SDD's controller state is inside this worktree: give each parallel SDD its own git worktree.

## Concurrency boundary

One SDD runs one writer at a time: Operator leases, readback and repair are serialized because candidate integrity freezes one worktree baseline per round. Concurrency inside one SDD comes from overlap (Architect preparation and early prepared checks) and from concurrent read-only final-verification shard leases. Concurrent Operators need separate SDDs in separate git worktrees: split the work with a program (`program-status`), one Coordinator per SDD.

## Response end versus assignment end

A host final/idle/completed notification ends a response; only direct role evidence completes work. Classify each return:

- Legitimate control boundary: readback awaiting approval, implementation awaiting the self-check transition, READY self-check awaiting handoff. Coordinator performs the normal transition.
- Evidenced escalation, revoked/expired authority, real interruption or user stop: use the matching recovery or wait path. A still-running command is not idle.
- With authority and a feasible next action, a partial edit, a fixable in-scope failure or a progress report is not a handoff. Continue.

On the first unsupported early return inspect the tool result and delta, record `operator-reconcile` (`continue`), and send one concrete continuation naming the remaining outcome, next action, check and stop boundary — not just "continue". Repeated unsupported returns require diagnosis of the dispatched guidance, last tool result, host state and delta; after corrected guidance fails again, preserve work and replace the runtime. Model-estimated "remaining turns" are not host limits.

## Preserve first

Never require GREEN before replacement, restore whole files to HEAD, clean or reset the worktree, weaken tests, or remove necessary implementation. A replacement starts from a valid checkpoint (`resume-view`, `dispatch --resume-checkpoint`) or from the Coordinator's `replace` observation; either way its start carries one `recovery_readback` against the currently observed worktree. New packages are admitted and scoped by their repository-relative root, so no separate package-root declaration exists. The round's first baseline stays frozen across replacement and later packets; a successor never gets a clean baseline that hides predecessor edits. A file written while the snapshot reads it fails with `WORKTREE_CHANGED_DURING_CAPTURE`: let the writer finish, then capture again.

Nested repositories (a submodule or a directory containing its own `.git`) are fingerprinted as one directory entry, so any change inside is detected, but authority applies to the whole nested root rather than paths within it. Round rejected such roots outright; admit the nested root as its own package when its contents are in scope, or keep it out of modification scope. Withdraw only changes evidence proves wrong, as a precise patch against the observed fingerprint.

Before a formatter, autofix, codemod or generator writes files, verify its real target expansion, keep the potential write set inside both modification authority and the packet's causal boundary, save a pre-command snapshot outside the repository, and inspect `worktree-view` immediately afterwards. On a spill stop the command chain, reverse only hunks proven to belong to that command, and keep newer or unrelated work.

## Runtime reuse and guidance

- Keep the resident Coordinator and prefer one healthy Operator and one eligible Architect. A response ending, packet change or final verification does not require a new runtime.
- Before spawning, inspect `runtime-view` candidates and record exclusion reasons; do not create reserve pools or per-packet agents.
- Record host facts with `runtime-record --payload-file`: `observe` (model, effort, lineage, status, writer/command stop, close availability), `guidance` (outcome, steps, checks, checkpoint triggers, stop conditions, preserved work, modification packages, `operator_profile`/`profile_basis`), `supervision`, `retire`, `close_result`, `spawn_result`.
- `escalated` Operator (strongest tier, 5 credit units) is allowed only after at least two consecutive Architect rejections or stagnant attempts (`ESCALATED_OPERATOR_PROFILE_NOT_JUSTIFIED` otherwise); dispatch it to a fresh runtime with the failure evidence, never as a default.
- `standard` Operator is the default. `bounded` is only for an exact source-backed mechanical route with fixed write paths, deterministic checks, no open judgment and Goal support; the first deviation disqualifies it for that work item.
- Healthy completed agents are kept for reuse. Retire only permanently unsuitable roles after preservation and revocation; record host close only from a real `close` operation result (`interrupt_turn` stops a turn but does not close the agent). Stop, idle status or credential removal is not closure or released capacity.
- Host thread shortage is a pipeline observation: search reusable roles, never spawn repeatedly without a material change, and never turn it into product `BLOCKED`.

## Native Goal control

Goal surfaces are host operations ([hosts](hosts.md#operations)). Model-side tools (`goal_create`, `goal_read`, `goal_complete`) can only create, read and complete; pause, resume, clear and budget limits belong to the user (`user_goal_control`) or a client calling the structured `goal_get`, `goal_set` and `goal_clear` methods. Mid-turn control uses `turn_steer` and `turn_interrupt`. A role must not claim a pause or resume it cannot call.

Goal pause/resume is usable only when the active host profile marks `goal_get` and `goal_set` available (`capabilities` → `features.host.goal_control`) and the call is bound to the exact thread/turn with verified postconditions. A PID, schema file, process liveness or Goal command text sent as a message is never a control receipt. Without that bridge use `direction_update`, `interrupt_turn` and `idle_continuation` and report Goal control unavailable.

### Goal execution contract

For one logical invocation generate one `skill-invocation/v1` object (`invocation_id`, `started_at`, `origin: "explicit"`) and pass its JSON through `SDD_INVOCATION_METADATA` to every CLI process, including role subprocesses. It correlates events only and carries no token or permission.

Under `/goal`, preserve the user's objective and the SDD's acceptance and exit conditions; continue from durable state to the next unmet obligation. A response ending, a passing intermediate test or a written plan is not completion. A Goal grants no permission and extends no lease. Report a missing controller capability as a control-plane limitation and use an authorized verified recovery route without weakening signature, oracle, scope or independence gates.

## Measured execution

Every `test-run` freezes its execution inputs before the command starts. The product location is traced through the authenticated candidate (its implementation event and the Operator lease that produced it), so it survives round closure; a formal Architect run also re-checks that the product still holds that candidate. Declared packages resolve through the repository's manifest identities (`@scope/foo` → its root); an unresolvable declaration fails `TEST_RUN_PACKAGE_UNRESOLVED` instead of meaning "no inputs". The run records the candidate event and the resolved packages' files plus lockfiles in its directory; an Architect directory must lie outside the Operator worktree by real path (`TEST_RUN_ISOLATED_COPY_REQUIRED`; this prevents mistakes, it is not operating-system isolation) and must hold the product bytes of those packages (`TEST_RUN_COPY_DIVERGED`). That record proves what one run observed; it does not prove every input (installed dependencies, tool binaries, configuration outside the packages). Checks reference runs and the controller derives their contract fields, outcome and duration. Every check supporting a PASS — executed or cited by a self-check — is refused when anything after its measured run contradicts it: an invalidating control event, or a later non-PASS verdict, check or run of the same acceptance (`VERIFICATION_EVIDENCE_SUPERSEDED`); a fix followed by a new passing run is judged from that newer run. Scanning inputs does not extend authority: right before launch the controller re-checks the role or preparation authority and the lease's absolute deadline on fresh state and recomputes the timeout. Registration happens when the command ends and re-checks authority on the state at that moment: ordinary phase advancement keeps a valid result, while a changed revision or revoked or consumed authority reports `TEST_RUN_RESULT_UNREGISTERED` with the measurement summary and no acceptance effect. A prepared Architect runs with `test-run --agent architect --agent-id <id> --prepared-id <prep> --cwd <copy>` after bootstrap and reading (`PREPARATION_READINESS_REQUIRED`); its `packet_check`s are preparation information only. Round and final verification measure again under their own lease: a check is never carried over from another run or process (`VERIFICATION_EXECUTION_MODE_INVALID`).
