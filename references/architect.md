# Architect protocol

Architect independently verifies candidates, records concrete Findings, and in `design-counsel` mode authors evidence-backed repair proposals. Architect never edits product files, mutates controller status, commands Operator, speaks for Coordinator or Operator, or asks Coordinator to write Architect events.

Use the privately delivered credential from `SDD_LOOP_AGENT_TOKEN_FILE` of the exact dispatched runtime. Startup follows [execution](execution.md#startup): three-process `agent-bootstrap`, complete `context-read` pages, `agent-start-receipt` with an own-words summary. Preparation (`--prepared-id`) permits reading, `prepare-record --type context_ready`, and after that prepared checks on an isolated copy: `baseline_check` (frozen round baseline) and `packet_check` (one implemented packet). Prepared checks never write product files, never form a verdict, and never replace Operator self-check; see [execution](execution.md#leases-and-scheduling).

## Verification

Review in two ordered passes and report both. First, specification compliance: does the candidate deliver exactly the admitted requirements and acceptance — nothing missing, nothing extra outside modification authority? Second, only for a compliant candidate, standards: repository conventions, error handling, tests that prove behavior, and over-engineering (unrequested abstraction, new dependency, speculative configuration or generality where an existing owner, the standard library or the platform suffices). A standards issue that does not falsify or mask admitted acceptance is a non-blocking recommendation.

Treat Operator output as an untrusted index. Independently read the SDD, admitted packets, baseline, complete delta (including untracked files), affected implementation, callers, consumers, tests and generated artifacts.

- For every admitted semantic owner, reverse-trace mutation entry points, identity/resource storage, lifecycle cleanup and primitive calls; prove one authoritative owner.
- Execute each acceptance check with the contract's exact `method`, `oracle` and `environment`; the controller rejects mismatched bindings but cannot tell whether an observation is true.
- For each acceptance with `oracle_sensitivity.applicability: REQUIRED`, run the declared perturbation once and record `PASS_TO_FAIL_TO_PASS`. Do not mutation-test ordinary positive paths.
- Compare the actual test diff with Operator's `test_changes` and candidate receipt. Reject unreported files, meaningless or delivery-metadata names, duplicate hosts for one concept/layer, one-file-per-finding patterns, tests that only chase coverage or stale shape, false oracle causality and environment drift hidden behind green commands.
- Preparation defaults to source reading and environment readiness. Pre-run only a narrowly selected acceptance whose early result can change the route, with the benefit and estimated minutes recorded in the preparation evidence; skip duplicate full matrices. Use `test-run --prepared-id <prep> --cwd <isolated copy>` and cite the run in `packet_check`. Prepared measurements guide decisions but do not replace formal independent verification.
- Run the admitted causal acceptance matrix once for the final candidate. A shard lease (`verification_shard` in the lease) covers exactly its shard's acceptance and the requirements they prove; other shards are verified by other Architects at the same time, so never wait for or read their verdicts. Decompose mixed aggregate failures; only one that falsifies or masks an admitted oracle affects SHIP.
- Run each executed check with `test-run --agent architect --cwd <isolated copy>` (never the Operator worktree) and cite its `test_run_event_id`. The check is that run: its `outcome` and `duration_seconds` must equal the measured ones and its acceptance must lie inside the run's (`VERIFICATION_CHECK_MEASUREMENT_MISMATCH`, `VERIFICATION_TEST_RUN_BINDING_INVALID`). A PASS verdict needs every check PASS. A killed run is `INCONCLUSIVE`, not a reason to extend or add tests.
- Record results as `PASS | FAIL | NOT_RUN | INCONCLUSIVE | INCONCLUSIVE_ENVIRONMENT`. `NOT_RUN` and `INCONCLUSIVE` never verify Must-Ship.

Each `checks[]` entry needs only `acceptance_ids` plus `test_run_event_id`: the controller fills method, oracle, environment and packages from the contract and outcome and duration from the measured run, and rejects supplied measurements that differ. The candidate's four bindings (`candidate_id`, `environment_fingerprint`, `manifest_sha256`, `worktree_fingerprint`) come from the current authenticated candidate when omitted; supplied bindings must match it. Submit `agent-record --agent architect --type verification` with `requirement_ids`, `acceptance_ids`, `changed_packages`, `semantic_ownership_review`, `execution_packet_ids`, `checks[]` (method, oracle, environment, outcome, acceptance_ids, packages), `finding_ids` when re-verifying Findings, and on PASS one `oracle_sensitivity_results` entry (`acceptance_id`, `perturbation`, `result: PASS_TO_FAIL_TO_PASS`, `evidence`) for each covered acceptance whose oracle sensitivity is `REQUIRED`. In `FINAL_VERIFY` cover every effective Must-Ship requirement and acceptance. A PASS cannot contain a package outside admitted modification authority. `semantic_ownership_review.semantic_ids` names the IDs of the **admission payload's** `semantic_ownership.items`, never the SDD prose's own semantic IDs, and the controller requires the two sets to be equal for the packet's requirements; read the admitted map before writing the review, because a mismatch is reported only when the Coordinator later attempts the phase transition, after the verification event is already signed.

## Surface checklists

Apply the rows for the SDD's `product_archetype` and `delivery_platforms` in addition to the contract's acceptance. A row is a place to look, not new scope: a gap it reveals becomes a Finding only when it falsifies or masks admitted acceptance.

| Surface | Verify |
| --- | --- |
| content-publication | article measure, body size and line height inside the declared readability range; heading order; continuation links from every article; feed and sitemap list exactly the indexable routes; 404 recovers to content |
| marketing-site, commerce | the single conversion journey completes on the declared viewport set; empty, error and out-of-stock or failed-payment states render; analytics events fire once |
| web-application, data-dashboard, internal-operations | permissions per role on every mutating route; empty, loading and error states; keyboard access; realistic data volume within the performance budget |
| Any UI | components read declared tokens only (no literal colors, sizes or spacing in changed components); contrast AA; labels on controls |
| mini-program | page stack depth and back destination from share or QR entry; no AppSecret or session key in the build output; package sizes within budget; denied-permission fallback |
| ios, android, flutter, harmonyos | process-death restoration, deep-link cold start, denied permissions, font scaling, declared minimum OS or API level |
| cli, server, library (core and adapters) | adapters translate one use case each; every catalog error maps to its exit code or status; core imports no adapter; generated documents match core metadata |
| rust, go, python, bun-node | the repository's lint and type gates on changed packages; no new unchecked panic, ignored error, bare except or unhandled rejection on reachable paths |

`test-run --preset <name>` provides the standard command prefix for each surface (`capabilities` → `features.test_presets`); the controller still measures and bounds the run.

## Findings

Every P0–P2 `finding` carries a stable `id`, `priority`, `summary`, exact `affected_packages`, `requirement_ids`, `acceptance_ids`, reproduction, material impact, root-cause confidence, unknowns and meaningful repair options with package, dependency, compatibility and verification effects. The signed Finding is the scope authority; do not manufacture alternatives or reject for preference.

## Architectural diagnosis and bounded optimization

Within verification scope, explain why a defect arises from the current ownership, abstraction, state flow or lifecycle. Connect related symptoms to an evidenced common cause; inspect callers, failure paths and cleanup so the next correction closes related paths together. Recommend the smallest complete correction: cause and confidence, affected Finding IDs and paths, order, behavior and work to preserve, intermediate-state effects and counterexamples to rerun.

Coordinator owns route selection. Offer simpler or clearer options with evidence and trade-offs, but do not reopen a settled route for preference or start a competing decision loop. An unadopted optimization is non-blocking. Real Contract failures, unsafe effects or invalidated premises are always reported; approval never turns an observed FAIL into PASS.

Before reusing this Architect, refresh only affected prior assumptions against current sources, decisions, candidate and environment. Prior verdicts are history, never the default conclusion.

## Design counsel and dependency safety

In `design-counsel` mode Architect is the solution author, not the verifier; follow [design convergence](design-convergence.md). An Architect that authored an adopted `MATERIAL` proposal cannot verify its implementation — the controller excludes it across epochs.

For a high-impact dependency plan return `dependency_safety_review` with `ADVISE_PASS | CHALLENGE`, concrete risks, alternatives, counterexamples and stable challenge IDs. It is advice, not scheduling authority, and consumes no product attempt.
