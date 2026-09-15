---
name: sdd-loop-delivery
description: Use when a validated SDD must be implemented end to end by Coordinator, Operator and Architect roles with bounded rounds, independent verification, recovery and SHIP/BLOCKED gates on a host with verified multi-agent capabilities.
metadata:
  short-description: Independent Bun-based SDD delivery
---

# SDD Loop Delivery

Execute an SDD as a bounded product-delivery contract. The SDD stays normative; `<SDD>.loop.json` (controller state), `<SDD>.events.jsonl` (signed event history), the active lease and the real worktree hold runtime facts. This is a standalone Bun/TypeScript skill.

Configuration authority: [agents/roles.json](agents/roles.json) (role tiers), [agents/hosts](agents/hosts) (host profiles: tier → model, neutral operation → host call; see [hosts](references/hosts.md)), [scripts/config/constants.ts](scripts/config/constants.ts) and the generated [configuration.md](configuration.md). Role names are independent of model IDs and of host tool names.

## Invocation

```text
$sdd-loop-delivery <sdd_doc_path> [max_rounds]
$sdd-loop-delivery sdd_doc_path=<path> max_rounds=<rounds>
```

`sdd_doc_path` is required. `max_rounds` defaults to `5` and must be `1`–`20`; do not mix positional and named forms. Create the SDD with `create-sdd`, then invoke this skill. The main thread becomes the Supervisor and automatically spawns the Coordinator; never ask the user to choose models or run controller commands. If Must-Ship scope, acceptance, ownership, dependency or authority in an SDD needs judgment, the Coordinator reports `SDD_AMENDMENT_REQUIRED` and keeps the product nonterminal; never guess or manufacture `BLOCKED`.

All commands run as `bun <skill>/scripts/main.ts <command> --sdd <absolute path> ...` from any directory. Resolve `<skill>` from this file's location.

## Delivery priorities

Within the authorized contract prioritize a usable end-to-end result, then measured performance and additional admitted features. Required security behavior on supported paths (authorization, secret protection, data integrity and external effects), truthful evidence and user authority are minimum boundaries. Extra testing infrastructure or speculative hardening needs a concrete causal benefit to the admitted result. Prefer existing primitives and the smallest decisive checks. This order never omits Must-Ship work or invents PASS.

## Core invariants

Treat incidents as violations of these invariants; do not add a checklist, state machine or role per symptom.

1. **Authority:** Supervisor observes and communicates; Coordinator decides; Operator implements; Architect challenges and independently verifies.
2. **Semantic ownership:** every invariant or authoritative state has one owner across the active Contract; others are delegates, projections or observers.
3. **Causal scope:** admission and verification stop at the owned delta and its causally affected consumers. Verification reach never grants modification authority.
4. **Evidence separation:** design structure, implementation evidence and independent verification stay distinct. `LOOP_READY`, Operator self-check and green local commands never imply architecture closure or SHIP.
5. **Convergence:** one active Contract, one derived packet projection, bounded attempts, safe checkpoints, explicit recovery; no successor loop to escape a bad gate.
6. **Decision closure:** freeze shared contract boundaries and authority; close execution decisions for the current admitted slice and its prerequisites before implementation. Later slices close at their own admission.
7. **Artifact custody:** admit ownership, secret flow and the acceptance that will verify new tooling; existing tooling needs executable preflight evidence. Planned work never counts as successful execution.
8. **Context economy and crash consistency:** Coordinator stays resident with a current controller-derived working set; roles reuse healthy runtimes with fresh leases. Replacement needs confirmed writer stop plus a validated checkpoint or fresh inspection of preserved work.
9. **Failure-domain separation:** SDD/design defects return to admission; product failures use product counters; controller/capability/dispatch faults use the pipeline ledger; environment-only oracle failures are `INCONCLUSIVE`; user choices are nonterminal waits. Domains never inherit each other's counters or verdicts.
10. **Evidence continuity:** a successor binds predecessor facts through declared lineage; known failed oracles, Findings, decisions and blockers need explicit disposition before admission.
11. **Test topology:** tests belong to stable business concepts and real layer/runtime boundaries; rounds, packets, attempts, Findings and hotfixes are never test-file architecture.
12. **Claim fidelity:** constraints, claims, execution and evidence keep one semantic dimension; one acceptance proves one atomic claim through one attributable execution target.
13. **Counterexample symmetry:** a new stop or terminal rule preserves the nearest Good case differing by one decisive fact.
14. **Design synthesis:** when a route is materially disproven, Architect authors the repair and Coordinator challenges and converges it; the user is not a substitute architect.
15. **Baseline conformance:** a hash, frozen file set or count proves identity only; each Must-Ship claim is either independently verified by claim-compatible evidence or assigned to a packet.
16. **Implementation logic:** before admission Coordinator independently reconstructs inputs, producers, branches, consumers, failures and acceptance for that slice; shared and upstream boundaries remain explicit. Runtime recovery cannot replace that closure.
17. **Bounded runtime selection:** `standard` Operator is the default; `bounded` only for an exact source-backed mechanical route, disqualified by its first deviation; `escalated` (strongest tier) only after two consecutive rejections or stagnant attempts.
18. **Event-driven supervision:** wait on role events, command/lease deadlines and declared checkpoints, not short polling. Messaging, interrupts and follow-ups never prove Goal pause/resume.

## Role routing

Read only the reference for the actually assigned role; transcripts or persona labels never grant authority.

- Supervisor: [supervisor](references/supervisor.md).
- Coordinator: [coordinator](references/coordinator.md) (an index of situation cards), [execution](references/execution.md), [recovery](references/recovery.md).
- Operator: [operator](references/operator.md) and [execution](references/execution.md).
- Architect: [architect](references/architect.md) and [execution](references/execution.md).
- Route disproven or implementation logic under review: [design convergence](references/design-convergence.md).
- Host tools, models and porting: [hosts](references/hosts.md).
- After SHIP/BLOCKED, retrospectives and skill evolution proposals: [evolution](references/evolution.md).
- A rejected command code: [error codes](references/error-codes.md) (generated; remediation per category).
- Role boundaries, identity and credentials, reading reuse: [roles](references/roles.md). Policy changes: [behavior evaluation](references/behavior-evaluation.md).
- People: [HUMAN.md](HUMAN.md) explains the flow; the [runbook](references/runbook.md) covers stuck deliveries.

## Required execution order

1. Existing native task: Coordinator runs read-only `status`, `audit` and `context-view`. New task with no sidecars: `validate`, then `init` and `auth-bootstrap`. Missing state is never a broken task; never recreate existing state.
2. Verify the authority epoch, active lease, pending transaction and actual runtime identity. Use the exact host-returned handle; a requested name is not a receipt.
3. An unfinished task with a valid lease and no external blocker continues with the same runtime; a response ending is not a reason to replace it.
4. Before each dispatch validate admission, role eligibility, scope and guidance. The dispatched role completes bootstrap, reads its context and records its start; Operator submits contract readback before implementation.
5. Operator implements only admitted scope, self-checks, and submits a complete candidate receipt. Partial progress is preserved, never treated as verification.
6. Architect independently verifies the candidate and records Findings; Coordinator owns route selection.
7. Coordinator groups fixes by approved root cause, records one decision per Finding, and keeps each Finding's identity and re-verification duty.
8. `FINAL_VERIFY` covers every effective Must-Ship requirement before `SHIP`.

## Authority, budgets and gates

- Each role writes only its own signed events under its own lease; credentials are controller-minted private files, and missing or proxy-written evidence is untrusted ([identity and credentials](references/roles.md#identity-and-credentials)).
- Controller state binds the signed event log; removed, reordered or altered history fails closed ([recovery](references/recovery.md)).
- `max_rounds` bounds logical rounds and each round allows six completed Operator→Architect attempts; exhaustion stops redispatch for a user decision and is never `BLOCKED` by itself ([convergence rules](references/coordinator/triage.md#convergence-rules)).
- One writer lease at a time, plus read-only final-verification shards and at most one Architect preparation; tests run through the controller-timed `test-run` inside strict budgets, and the credit ledger observes by default ([execution](references/execution.md)).
- `SHIP` is reachable only from `FINAL_VERIFY` through the SHIP gate; `BLOCKED` only with a signed terminal blocker ([triage and terminal gates](references/coordinator/triage.md#final-verification-and-ship)).
- Under `/goal` continue from durable state to the next unmet obligation; a Goal grants no permission and extends no lease ([goal execution contract](references/execution.md#goal-execution-contract)).

## Tooling boundary

All skill source, tests, build files and release helpers are TypeScript on Bun 1.4.2 with TypeScript 7+. Use the checked-in `oxfmt.json` and `oxlint.json`; formatting accepts explicit file lists only.

The controller is the sole writer of state and signed events. Read-only lint, scaffold, context projection and status never create sidecars or mutate product files. No host close/release capability may be claimed without a real host receipt. Maintenance changes pass `bun run review:release`.

## Reporting

Never report intuitive percentages. The coverage bar is allowed only with its exact `N/M` label meaning verified coverage. Name remaining gates with their admitted surface and causal basis. Use exactly Supervisor, Coordinator, Operator and Architect when naming roles; machine field names keep their spelling.

Final response, compactly:

```text
Workflow / product outcomes / verified coverage / round / active status:
Rounds / attempts / Operator-Architect invocations:
Controller phase: exact recorded phase (UNINITIALIZED before init)
Loop status: WORKING | WAITING_USER | PIPELINE_REPAIR | PAUSED | SHIP | BLOCKED | CANCELLED
Wait reason: NONE | USER_DECISION | USER_PAUSE | PIPELINE_REPAIR | HOST_CAPABILITY | BOOTSTRAP_PENDING | BUDGET_DECISION
Must-Ship acceptance and evidence:
Architecture/product decisions:
Deferred items and authority:
Open risks including P3/P4:
Verification passed / failed / not run / inconclusive:
Worktree and external-action status:
```

Use `status.process_view` for controller-derived fields; host/bootstrap limitations before initialization are observed reasons, not invented controller phases. Every proposed improvement includes an estimated duration in minutes (range allowed), its concrete outcome and stop condition; an estimate is not a deadline or budget authorization.
