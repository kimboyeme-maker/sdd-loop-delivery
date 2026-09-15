# Coordinator · triage and terminal gates

Read after an Architect verdict or Finding, on repeated rejection or failure, and in `FINAL_VERIFY`.

## Phase gates

`DISCOVER → ARCHITECT → CONTRACT_DRAFT → CONTRACT_ADMITTED → OPERATOR_READBACK → READBACK_APPROVED → IMPLEMENTING → OPERATOR_SELF_CHECK → ARCHITECT_VERIFY → COORDINATOR_TRIAGE → (CONTRACT_AMENDED | ROUND_CLOSED | FINAL_CANDIDATE) → FINAL_VERIFY → SHIP`; any nonterminal phase may go to `BLOCKED` with a valid terminal blocker. The full table is in [configuration.md](../../configuration.md#phase-transitions).

- `READBACK_APPROVED` consumes an Operator `contract_readback` with `ACCEPT`/`SUPPORTED`.
- `OPERATOR_SELF_CHECK` consumes the implementation and a current candidate; `ARCHITECT_VERIFY` consumes a READY self-check whose candidate receipt covers oracle sensitivity, environment integrity and actual modification scope.
- `COORDINATOR_TRIAGE`/`SHIP` consume the Architect verification from that phase. Re-entering a phase clears that phase's prior role evidence.

## Convergence rules

Track logical rounds, contract revisions, completed Operator→Architect attempts, role invocations, consecutive stagnant attempts, consecutive Architect rejections, product execution failures and pipeline incidents separately. A completed pair consumes one attempt even when rejected; readback, amendment, timeout, crash, interruption and pipeline incidents do not.

- After an Architect rejection classify the root cause before redispatch; the same packet and route are never replayed unchanged. A second same-root rejection is a Coordinator planning failure: stop redispatch, challenge the packet and revise admission.
- Three consecutive Architect rejections or stagnant attempts require a `convergence_review` (review granularity, plan specificity, Operator execution quality) before any transition other than amendment or BLOCKED, and before dispatch or readmission. Operator is deficient only when the missed obligation and oracle were explicit before dispatch.
- The controller refuses a seventh completed attempt in one round (`ATTEMPT_BUDGET_EXHAUSTED`) and a round beyond `max_rounds` (`ROUND_BUDGET_EXHAUSTED`). Stop product redispatch and request a nonterminal user decision with the convergence record; neither is `BLOCKED` without a separate valid terminal blocker.

## Evidence review and Finding decisions

Before an Architect claim changes a Finding disposition, design route, scope/authority request, requirement status or terminal decision, attach an `evidence_review` (`decision-evidence-v1`): `architect_claim_ids`, `claim_type`, `decision_impact`, cheapest decisive `method`, `decision_flip_condition`, `result`, `evidence`, and `no_rerun_reason` only for `SOURCE_READ`/`ARTIFACT_AUDIT`. Root causes need a counterfactual; behavior needs targeted reproduction or the canonical oracle. A material `INCONCLUSIVE` cannot support the decision. This is not a second QA pass.

For each Finding record exactly one `finding_decision` via `record`: `finding_ids`, `decision` (`APPROVE_AS_PROPOSED`, `APPROVE_WITH_EXISTING_CAPABILITY`, `REWRITE_ROUTE`, `SPLIT_ROUTE`, `DEFER_WITH_CONTAINMENT`, `DOWNGRADE_TO_P3_OR_P4`, `REJECT_FINDING_OR_PROPOSAL`, `BLOCKED_NEEDS_USER_DECISION`), `evidence`, `evidence_review`. Attempt accounting uses the dedicated `attempt` command. Close Findings with `finding --status resolved --evidence <Architect verification naming it>`. Opening a Finding requires its requirement, acceptance and affected-package scope to lie within what the producing verification could observe: the current admission for round verification, the whole Must-Ship contract for `FINAL_VERIFY`.

Consume Architect's common-cause diagnosis and bounded optimization advice; Coordinator alone selects the route.

Correction classes are evidence-based, never by file or line count: `EDITORIAL_ONLY` (Coordinator may close), `BOUNDED_OBSERVABLE_CORRECTION` (reuse the finding's Architect with `bounded-correction`), `MATERIAL_OR_UNCERTAIN` (normal path). A fresh Architect needs an enumerated reason.

## Failure domains

- Control-plane, capability, dispatch, signing or sidecar fault: `pipeline-failure --root-cause-key`, then a materially changed `pipeline_repair` and a probe lease (`dispatch --pipeline-repair-probe-root`). Product redispatch stays frozen until the repair passes the probe; incidents never charge product counters or become product `BLOCKED`.
- Product task failure: `execution-failure --root-cause-key`; admission is invalidated until an `execution_failure_review` readmission. Counts are observational.
- Environment-only oracle failure: `INCONCLUSIVE_ENVIRONMENT`.
- User-owned choice: `USER_DECISION` wait.

## Final verification and SHIP

Operator self-check is mandatory and separate from acceptance. Every implementation carries a complete `test_changes` manifest (empty when no test changed) and every READY self-check a machine-bound `candidate_receipt`. Architect reproduces acceptance independently with the contract's exact method, oracle and environment; see [architect](../architect.md).

`SHIP` is reachable only from `FINAL_VERIFY` with a current independent Architect PASS covering every effective Must-Ship requirement and acceptance, each requirement marked verified from Architect evidence, no open Finding, no pending user decision or recovery, and an unchanged candidate worktree. Coordinator additionally checks SDD consistency, artifacts, final matrix, worktree delta and authority decisions. P3/P4 remain only as disclosed debt.

User-approved Must-Ship deferral is an explicit exception: status `deferred` with complete owner/trigger/impact and `approved_by=user` in the contract and a signed requirement-status event. It is disclosed, never reported as complete.

## BLOCKED

`BLOCKED` requires a signed `terminal_blocker` with an enumerated cause (`REQUIRED_RUNTIME_UNAVAILABLE`, `REQUIRED_TOOL_UNAVAILABLE`, `NO_FEASIBLE_SAFE_ROUTE`, `INCONCLUSIVE_MUST_SHIP_AFTER_BOUNDED_ATTEMPTS`, `COORDINATOR_AUTHORITY_UNRECOVERABLE`), independent substantive evidence, a recovery condition and a confirmed evidence review. Budget exhaustion alone is rejected even with a signed review; report `BUDGET_DECISION` and wait for user direction. Existing terminal history stays immutable. Pipeline faults report `PIPELINE_UNAVAILABLE`; authorization waits stay `pending_user_decision`.

Terminal `BLOCKED` needs `record --type terminal_blocker` with an enumerated `reason`, `summary`, `evidence`, `recovery_condition` and a `CONFIRMED` `evidence_review`, then `transition --to BLOCKED`. A pending user decision rejects both. When evidence shows a terminal was caused by a controller defect and the user objective still requires completion, establish one corrected continuation that preserves scope and valid evidence; never repeat successors without a corrected cause.
