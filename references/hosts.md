# Host adapters

The loop never names a host's tools in its protocol. Roles use a neutral operation vocabulary; a host profile maps each operation to a real call, and maps role tiers to real models.

## Selection

- Bundled profiles live in [agents/hosts](../agents/hosts): `codex` (default), `claude-code`, `generic`.

## Host permission gates

A host may refuse a controller command before the controller ever sees it. Observed on `claude-code` (2026-09-16): the flags that assert a user granted something — `--scope-change-authorized yes`, `--user-authorized yes` — are refused by the host's own permission classifier when a role runs unattended, because from the host's side an agent is claiming an authorization the host cannot see the user give. Two differently worded attempts were refused as `Instruction Poisoning` and then `Self-Modification`.

That refusal is correct and must not be worked around. An authorization relayed through another agent's message is still a relay, never the user's own act, and rewording the reason to get past a classifier is exactly the evasion these roles are forbidden. A role that hits this stops, reports the exact command and both refusals, and waits.

Clear it before the run, not during it: the user grants the permission in their own session, or adds a host permission rule for that command. Treat it like any other host capability — probe it during startup rather than discovering it at the first amendment.
- `SDD_LOOP_HOST=<id>` selects a bundled profile. `SDD_LOOP_HOST_PROFILE_FILE=<absolute json>` loads a custom `host-profile/v1` file (PI, internal harnesses) and wins over the id.
- Keep one host per delivery. Receipts, observations and admissions are checked against the active profile at command time; switching hosts mid-delivery makes earlier runtime facts fail their match.
- Read the resolved view with `bun <skill>/scripts/main.ts configuration` (roles with tier, model, effort, `spawn_args`) and `capabilities` (`features.host`).

## Tiers

`agents/roles.json` names tiers, never models: Coordinator `frontier`, Operator `standard` (profile `bounded` → `efficient`), Architect `review`, Supervisor inherits the invoking thread. Each profile's `tiers.<tier>` declares `spawn_model` (what to pass), `accepted_models` (what a receipt may report, aliases included) and `reasoning_effort` (`null` when the host has no per-spawn effort). An empty `accepted_models` means the host cannot pin models: any reported model is accepted and recorded, so model-tier guarantees are absent and must be disclosed.

## Operations

| Operation | Meaning |
| --- | --- |
| `spawn` | Start a role runtime with the tier model and the profile's isolated `spawn_args`. |
| `direction_update` | Queue guidance without starting a turn. |
| `idle_continuation` | Start or resume a turn on an idle runtime. |
| `wait` | Block on role events or notifications instead of polling. |
| `interrupt_turn` | Stop the current turn only; the runtime stays reusable. |
| `close` | End a runtime (and descendants when `closes_descendants`). |
| `observe` | List live runtimes for `runtime-record observe`. |
| `resume_closed` | Reopen a closed runtime by id. |
| `goal_create`, `goal_read`, `goal_complete` | Model-side Goal tools. |
| `goal_get`, `goal_set`, `goal_clear` | Structured host Goal methods (pause, resume, budget, clear). |
| `turn_steer`, `turn_interrupt` | Structured mid-turn control. |
| `usage_read` | Real token/usage accounting. |
| `user_goal_control` | User-typed Goal commands; never sent by a role as message text. |
| `task_create` | Start an independent top-level task in a new worktree (cross-SDD workflow). |
| `task_message` | Send a message to such a task (the bind CONTINUE, stop requests). |
| `task_wait` | Wake on task idle or completion instead of polling. |
| `task_list` | List actual tasks to reconcile an uncertain creation by its intent. |
| `wake_schedule` | Recurring wake for the scheduling task while it is otherwise idle. |
| `project_discover` | Resolve the saved project or repository reference `task_create` needs. |

Rules:

- An operation with `available: false` is unavailable. Report it with its `reason` and take the documented fallback; never emulate it through another tool (a message is not a Goal pause, a stopped task is not a released close unless the profile says `close`).
- `available: true` in a profile means the host protocol supports the operation, not that this session holds the tool. Confirm the tool before relying on it and record what you observed (for example `close_available` in `runtime-record observe`); plans consume those recorded session facts.
- A receipt records the actual call name and returned identifiers. A self-described model, a PID or process liveness is never a receipt.
- Without `goal_create`, dispatch Operators with `--operator-goal unavailable` and a reason; `bounded` Operators therefore stay unavailable on that host.
- Without `goal_get`/`goal_set`, Goal pause/resume is unavailable; use `direction_update`, `interrupt_turn` or `idle_continuation` and say so.
- Program operations (`task_*`, `wake_schedule`, `project_discover`) have fallbacks in [program workflow](program-workflow.md): without `task_create` the user starts each child task, without `wake_schedule` the run is `attended`. The run records the profile id, so a workflow cannot switch hosts midway.
- Without `spawn`, the host cannot run the four-role topology; report `IN_THREAD_AGENT_UNAVAILABLE` instead of simulating roles in one context.

### Codex capability migration

The bundled profile uses the exposed collaboration tools. `close` is unavailable: no exposed tool closes a runtime, `followup_task` continues a live idle one, and `interrupt_agent` stops its turn while preserving reuse — neither proves closure nor releases capacity. Reuse eligible runtimes; if the host limit prevents an independent role, report the concrete capability wait.

`resume_closed` is a different case and the profile says so: it is marked available because the app-server publishes `thread/resume`, which is protocol support, not proof that this session can call it. That is exactly the distinction every profile carries — `availability: "host-tool-probe-required"` and `operation_meaning: "protocol-support-not-session-proof"` in `configuration` output. Read an operation's `available` as "the host protocol defines this", and an `Observed <date>` note as "someone called it here and it worked". Plan from the second, not the first: an operation with no observation is a capability to probe before relying on, and `wake_schedule` states `verified_against: "none"` for precisely this reason.

Official [app-server documentation](https://learn.chatgpt.com/docs/app-server) distinguishes `thread/resume` (reopen a persisted thread), `thread/archive` (archive logs) and `thread/unsubscribe` (unload only after the last subscriber and an inactivity grace period). These methods are not automatically callable by a model, and archival is not a subagent-slot receipt. A verified custom profile may expose a bridge only after it proves exact runtime identity, stop/close postconditions and capacity release separately. Never launch a second app-server or use an unrelated task-management tool to simulate ownership of the current agent tree.

## Generated calls

A wait call carries `timeout_ms` bounded at 60 seconds, the same ceiling [program workflow](program-workflow.md) sets for a blocking wait while actively communicating, plus a non-argument `deadline_ms` naming how far the lease deadline really is. Re-wait until that deadline; the short timeout is a communication bound, not a poll interval, and `deadline_ms` is plan context the host never receives.

`runtime-plan --sdd <sdd>` renders the next host calls with this profile's call names and parameter names (for example `spawn` → `spawn_agent {task_name, message, fork_turns, model, reasoning_effort}` on Codex, `Agent {description, prompt, model}` on Claude Code). The Coordinator makes the calls and records their results; the plan is never a receipt.

## Porting to a new host

1. Copy `agents/hosts/generic.json` and set `id`, `sources` (official documentation), `skill_roots`.
2. Map each tier to models the host can actually select, with every alias its receipts report.
3. Describe isolated context: the arguments that start a runtime without parent history, and the values a spawn receipt reports for it. If the host cannot isolate, leave `spawn` unavailable.
4. Map each operation you verified against the host's documentation or a real call; mark the rest unavailable with a reason.
5. Run `SDD_LOOP_HOST_PROFILE_FILE=<file> bun <skill>/scripts/main.ts configuration`; `HOST_PROFILE_INVALID` means a tier, context or operation entry is incomplete.
