# Self-evolution

Every delivery teaches both skills something. The loop turns that into cited, reviewable proposals; it never edits a skill by itself.

## Retrospective

- `transition` to `SHIP` or `BLOCKED` writes `<SDD>.retrospective.json` right after the commit and returns its path. A write failure never undoes the transition.
- Any time: `bun <skill>/scripts/main.ts retrospective --sdd <sdd> [--write]` (read-only unless `--write`; also for `CANCELLED` or a live delivery).
- Sources: committed state, the signed event history and `<SDD>.rejections.jsonl`, which records one `{at, command, code}` line for each rejected command against an initialized delivery. Arguments, payloads and credentials are never recorded. The retrospective does not verify signatures; run `audit` when provenance matters.

`retrospective/v1` carries `metrics` (rounds, attempts, invocations, credit and extensions, controller-measured tests, verdicts, findings by priority, execution failures, pipeline incidents), `issues` and `proposals`.

| Issue kind | Signal | Target | Area first reviewed |
| --- | --- | --- | --- |
| `CONTRACT_AMENDMENT` | an amendment was needed | create-sdd | phases/2-admit |
| `LATE_USER_DECISION` | a `USER_DECISION` admission | create-sdd | phases/1-harvest |
| `ARCHITECT_REJECTION` | FAIL/NOT_RUN/INCONCLUSIVE verdict | create-sdd | verification-planning |
| `BLOCKING_FINDING` | P0/P1 Finding | create-sdd | loop-ready |
| `IMPLEMENTATION_ESCALATION` | Operator escalated | create-sdd | work-decomposition |
| `READBACK_CHALLENGE` | readback or plan challenged | create-sdd | complete-design |
| `TEST_TIMEOUT` | controller killed a test run | create-sdd | test-budget |
| `ROUND_OVERRUN` | more than one logical round | create-sdd | work-decomposition |
| `ESTIMATE_MISS` | batch elapsed/estimated outside 0.5–1.5 | create-sdd | estimate-calibration |
| `EXECUTION_FAILURE` | product execution failure by root | loop | execution |
| `NO_PROGRESS_RETURN` | Operator return without progress | loop | execution |
| `CREDIT_PRESSURE` | ≥80% of the credit budget spent | loop | credit constants |
| `COMMAND_REJECTION` | same rejection code at least twice | loop | role reference |
| `PIPELINE_INCIDENT` | pipeline incident by root | loop | recovery |
| `HOST_INCIDENT` | `HOST_`/`RUNTIME_` incident root | host profile | agents/hosts |

Each proposal has a stable `key` (`target:kind:root`), the cited issue, a change direction and a Bad/Good behavior-case sketch. Its `maturity` starts at `report`.

## Digest across deliveries

`bun <skill>/scripts/main.ts evolution-digest --retrospective-files a.retrospective.json,b.retrospective.json` merges proposals by key. A key seen in two or more deliveries matures to `trace`: a recurring, cited pattern. The digest groups counts by target skill and returns `estimate_calibration` (median elapsed/estimated ratio overall and per lane) from each retrospective's `metrics.estimates`; create-sdd applies it to future batch estimates.

## Applying a proposal

1. Supervisor includes the top proposals (key, target, evidence IDs) in the final report after SHIP or BLOCKED. It does not start editing.
2. With user or maintainer authority, turn a `trace` proposal into a Bad/Good pair in the target skill's `cases/behavior-cases.json`, following [behavior evaluation](behavior-evaluation.md). A single `report` may improve diagnostics or wording only.
3. Make the smallest guidance or controller change that rejects Bad and allows Good; converge an existing rule before adding one.
4. Run the target skill's release checks (loop: `bun run review:release`; create-sdd: link check and `validate-draft` of its examples) and cite the proposal key in the change description.

Never paste transcripts, private paths or credentials into cases, and never widen a gate to hide a recurring failure.
