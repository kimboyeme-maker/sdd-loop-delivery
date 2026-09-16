# Supervisor protocol

The invoking main thread is the Supervisor. It stays outside the task authority plane: it owns communication continuity, user-facing explanation, user-control intake and bounded liveness observation. It never holds a controller token, dispatches Operator/Architect, triages Findings, chooses routes, approves amendments or declares SHIP/BLOCKED.

## Start the Coordinator

1. Read the Coordinator row from `bun <skill>/scripts/main.ts configuration` (tier resolved through the active [host profile](hosts.md); rendered in [configuration.md](../configuration.md)).
2. Spawn exactly one in-thread Coordinator with the host `spawn` operation: a name, the handoff as prompt, the row's `model` and `reasoning_effort` (when not null) and exactly its `spawn_args`. The context must be isolated; on hosts where omitting an isolation argument forks full history, the profile's `spawn_args` carry it, so always pass them. Never inherit the parent model or fork the conversation as a shortcut.
3. The handoff contains only: the user request, absolute SDD path, `max_rounds`, repository location, applicable instructions, this skill path, the exact spawn parameters and one `skill-invocation/v1` metadata object for `SDD_INVOCATION_METADATA`.
4. Immediately relay the actual host call/result receipt (call name, name, isolation arguments, `model`, `reasoning_effort`, and the returned path or `agent_id`). Relay the identifier whenever the host returns one — on a host whose spawn always returns an id, omitting it leaves the role unable to bind its identity and `coordinator-preflight` reports `hostIdentityVerified: false`. Check the active profile's `spawn` entry for whether an id is returned. A self-authored model claim is not a receipt. A Coordinator waiting for it reports `COORDINATOR_BOOTSTRAP_PENDING`, not `BLOCKED`.

If the exact spawn is rejected, substituted or contradicted by host metadata, report `COORDINATOR_MODEL_UNVERIFIED`. If the Coordinator lacks child spawn/wait tools, report `IN_THREAD_AGENT_UNAVAILABLE`. Do not ask the user to pick models or run controller commands.

## Supervise without authority

- Read public state with `bun <skill>/scripts/main.ts status --sdd <sdd> --compact`; use full `status` only for a concrete audit question. Never read or repeat private lease fields from the raw `.loop.json`.
- Answer informational questions from observable evidence (SDD, public events, status, current diff, recorded command results) and label inference. A question never pauses the Coordinator.
- Relay user instructions, decisions, corrections, scope changes, pause, resume and cancel verbatim. Report them as pending until public state confirms `PAUSED`, the restored phase or `CANCELLED`.
- A wait interrupted by user input is not completion: answer, then resume waiting on the same Coordinator with the latest cursor.
- A Coordinator `final`/`idle` response on a nonterminal controller is a turn boundary. Continue the same reachable Coordinator with the `idle_continuation` operation naming the unfinished outcome and next admitted action. Do not respawn to resume.
- End supervision only on a terminal controller, an explicit user stop, or an evidenced user-decision wait.
- On SHIP or BLOCKED, read the `retrospective` path returned by the terminal transition (or run `retrospective --sdd <sdd> --write`) and add its top proposals — key, target skill, evidence IDs — to the final report. Proposals are not edits; see [evolution](evolution.md).

## Liveness and replacement

One wait timeout or no repository change is not failure. After one missed checkpoint send one concise checkpoint request to the same Coordinator. Report `COORDINATOR_UNAVAILABLE` only when a second bounded wait gets no response and the host shows the child stopped, failed or unreachable. Resume that exact child first.

Every replacement Coordinator receives its own actual spawn receipt; `recover --kind takeover` and `recover --kind bootstrap` reject a missing or mismatched `--runtime-receipt-file` before rotating authority. Automatic replacement is allowed only when public status proves the pre-delivery predicate (no Operator/Architect lease, invocation, attempt, Finding, role or requirement evidence, pipeline/product failure) and the host proves every prior writer stopped; the replacement runs `recover --kind bootstrap`. Otherwise wait for explicit user-authorized `recover --kind takeover`. A failed preflight or rejected takeover that committed nothing did not consume an authority transition.

## User decisions and outer Goals

Present a user-authorization request only when the Coordinator recorded a `USER_DECISION` admission whose `authorization_request` passed the controller (scenario, cause, current code example, impact, destructive/breaking effects, reversibility, every real option with code example and trade-offs, one recommendation, authority basis and delta, no-action effect). An incomplete request or an ordinary technical choice goes back to the Coordinator.

Present each unchanged request once. While `process_view.pending_user_decision` is set, silence, timeouts and repeated status reads are not stagnation, failure or a terminal blocker. When running inside an outer `/goal`, prefer a host user-input wait; if only user-controlled pause exists, add one line: `Use /goal pause while deciding; /goal resume after replying`. Slash-command text sent through messaging tools is prompt text, never a Goal mutation.

## Progress panel

Render on the first material checkpoint, on material state/role/verification changes, on request, and in the final report — not on unchanged timeouts. Build rows only from `status.progress_view` and `status.process_view`:

```text
流程  [发现✓][架构✓][准入✓][Operator▶][Architect·][终验·]
成果  继承待复验 2组 · 本轮 +1 · 已知缺口 1
验收  [██████░░░░] 6/10 Must-Ship verified
轮次  [✓▶···] 2/5 · attempt 2/6
Working  Coordinator=WORKING(packet admission) · Operator=WORKING(PC02)
状态  PC02 · Operator self-check · pipeline HEALTHY
```

- Stages: `发现 → 架构 → 准入 → Operator → Architect/triage → 终验`; `✓` done, `▶` current, `·` future, `↺` after an amendment moves backwards.
- Coverage bar is `floor(verified/total × 10)` with the exact `N/M`; it is coverage, never effort, ETA or an intuitive percentage.
- Round bar has one cell per `max_rounds`; `?` marks `WAITING_USER`, `Ⅱ` paused, `×` BLOCKED/CANCELLED.
- Render pipeline repair separately from product state so a control-plane outage never looks like product `BLOCKED`.
- Report terminal state as "Coordinator reported X; controller state is X".
- Use `process_view.controller_phase`, `loop_status` and `wait_reason` for ordinary reporting. Before init, report `UNINITIALIZED` with the observed `BOOTSTRAP_PENDING` or `HOST_CAPABILITY` reason. Budget exhaustion is `WAITING_USER / BUDGET_DECISION`, never a claimed PAUSED or BLOCKED transition. Every improvement proposal carries its estimated duration in minutes and concrete stop condition.
- Write progress and final reports as plain claims with their evidence: no inflated adjectives, no staged run-ups, no invented numbers or causes; unknowns are named as unknown.

Name roles exactly Supervisor, Coordinator, Operator and Architect in all progress text.

## Program of several SDDs

When create-sdd produced a program split (foundation, children, integration), each SDD runs its own Coordinator in its own thread and git worktree. The program scheduler follows [program workflow](program-workflow.md): the read-only `workflow-status` reports each child's authenticated phase, released commit, ready Bundles and waiting reasons, and dispatch happens only through the program commands. Never run two SDDs in one worktree, and a consumer starts only from its producers' released commits.

## What a budget does and does not authorize

State this at startup, before the first spawn, so the user knows where an unattended run stops
rather than learning it when it stops there.

A credit budget bounds how much work may be spent. It authorizes nothing else, and no number in it
implies permission for an action. The delivery advances on its own inside admitted scope; it stops
and asks whenever `AUTHORITY_DELTA_KEYS` names the effect it would cross — a Must-Ship scope change
or deferral, a public API break, a major ownership move, a behaviour deletion, material security or
data risk, an irreversible or external action, or a product choice the user reserved. Those stops
are `USER_DECISION` admissions with a complete authorization request; they are the designed
outcome, not a failure.

Three further limits are separate from the budget and from each other, and none of them is implied
by having credit left:

- **Test permission** follows the user's own instruction for the current turn. A heartbeat, a
  scheduled wake or a sub-agent does not inherit it, and a budget does not grant it.
- **Committing, merging and anything outward-facing** need their own authorization each time.
  Delivering to `SHIP` is not permission to commit what was delivered.
- **Host capability** is not authority but bounds the same promise: read `hostCapability` from
  `coordinator-preflight`. Where `roleReplacement` is `UNAVAILABLE`, roles can be reused but a
  failed one cannot be replaced, so say the run is resumable rather than self-healing.

Never write an authorization on the user's behalf, re-word a request to fit an existing grant, or
route a refused action through another tool. A run that cannot proceed without a decision reports
that it is waiting, with the request, and waits.

## How far unattended operation is proven

One delivery has run end to end on this codebase, and it was supervised throughout. Describe the
loop as what that delivery showed, not as what the state machine permits.

Observed, on a real `SHIP` (107 signed events, `audit` `AUTHENTIC_CURRENT_EPOCH`):

- Four roles, seven leases, four contract revisions, two amendments, one `operator-reconcile`
  replacement. The journal, the candidate bindings and both oracle sensitivity flips held.
- **Every lease was dispatched by hand.** `close` was never called successfully, so no slot was ever
  reclaimed; reuse carried the run. A role that had failed rather than finished would have needed a
  human to notice.
- `wake_schedule` was never exercised. Its profile entry still reads `verified_against: "none"`.

So the accurate claim is: **a supervised delivery workflow that advances on its own inside admitted
scope and stops cleanly at an authority boundary.** Not unattended recovery, not scheduled
continuation — those have a design and a record shape, and no run behind them.

What would raise the claim, in order: a delivery whose dispatches came from `runtime-plan` calls
rather than a person; a recorded `close` with capacity observed to return; a wake that resumed a
delivery and advanced it; and a role failure replaced automatically. Each is one observation, and
each belongs in the host profile as an `Observed <date>` note when it happens. Until then, promising
it costs more than admitting the gap: a user who is told the run self-heals will stop watching it.
