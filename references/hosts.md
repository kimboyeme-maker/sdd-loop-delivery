# Host adapters

The loop never names a host's tools in its protocol. Roles use a neutral operation vocabulary; a host profile maps each operation to a real call, and maps role tiers to real models.

## Selection

- Bundled profiles live in [agents/hosts](../agents/hosts): `codex` (default), `claude-code`, `generic`.
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

Rules:

- An operation with `available: false` is unavailable. Report it with its `reason` and take the documented fallback; never emulate it through another tool (a message is not a Goal pause, a stopped task is not a released close unless the profile says `close`).
- `available: true` in a profile means the host protocol supports the operation, not that this session holds the tool. Confirm the tool before relying on it and record what you observed (for example `close_available` in `runtime-record observe`); plans consume those recorded session facts.
- A receipt records the actual call name and returned identifiers. A self-described model, a PID or process liveness is never a receipt.
- Without `goal_create`, dispatch Operators with `--operator-goal unavailable` and a reason; `bounded` Operators therefore stay unavailable on that host.
- Without `goal_get`/`goal_set`, Goal pause/resume is unavailable; use `direction_update`, `interrupt_turn` or `idle_continuation` and say so.
- Without `spawn`, the host cannot run the four-role topology; report `IN_THREAD_AGENT_UNAVAILABLE` instead of simulating roles in one context.

### Codex capability migration

The bundled profile uses the exposed collaboration tools. `close` and `resume_closed` are unavailable by default; `followup_task` continues a live idle runtime, while `interrupt_agent` stops its turn and preserves reuse. Neither proves closure or releases capacity. Reuse eligible runtimes; if the host limit prevents an independent role, report the concrete capability wait.

Official [app-server documentation](https://learn.chatgpt.com/docs/app-server) distinguishes `thread/resume` (reopen a persisted thread), `thread/archive` (archive logs) and `thread/unsubscribe` (unload only after the last subscriber and an inactivity grace period). These methods are not automatically callable by a model, and archival is not a subagent-slot receipt. A verified custom profile may expose a bridge only after it proves exact runtime identity, stop/close postconditions and capacity release separately. Never launch a second app-server or use an unrelated task-management tool to simulate ownership of the current agent tree.

## Generated calls

`runtime-plan --sdd <sdd>` renders the next host calls with this profile's call names and parameter names (for example `spawn` → `spawn_agent {task_name, message, fork_turns, model, reasoning_effort}` on Codex, `Agent {description, prompt, model}` on Claude Code). The Coordinator makes the calls and records their results; the plan is never a receipt.

## Porting to a new host

1. Copy `agents/hosts/generic.json` and set `id`, `sources` (official documentation), `skill_roots`.
2. Map each tier to models the host can actually select, with every alias its receipts report.
3. Describe isolated context: the arguments that start a runtime without parent history, and the values a spawn receipt reports for it. If the host cannot isolate, leave `spawn` unavailable.
4. Map each operation you verified against the host's documentation or a real call; mark the rest unavailable with a reason.
5. Run `SDD_LOOP_HOST_PROFILE_FILE=<file> bun <skill>/scripts/main.ts configuration`; `HOST_PROFILE_INVALID` means a tier, context or operation entry is incomplete.
