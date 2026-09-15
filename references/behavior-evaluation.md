# Behavior evaluation

Use only when changing skill or controller policy, or investigating a demonstrated orchestration failure. It is not part of product admission.

## Case-first correction

Each policy change names a Bad/Good pair in [cases/behavior-cases.json](../cases/behavior-cases.json). Both arms keep the workflow shape and change one decisive fact. A passing change rejects the Bad action, allows the Good action, completes the requested result, and creates no new retry, prompt, successor or terminal loop.

Evidence matures `report → trace → repro → paired-eval`. A report may improve diagnostics; a machine-enforced rule needs a reproducible pair; a general effectiveness claim needs isolated paired evaluation with every Good case passing.

## Dry-run matrix

```bash
bun run behavior:plan
bun scripts/behavior-eval.ts --suite ../create-sdd/cases/behavior-cases.json --suite cases/behavior-cases.json --runs 3
```

The planner validates suites and emits `stable`, `candidate-skill` and `candidate-full` cells. It never starts agents, alters a controller or claims effectiveness. A live harness uses fresh isolated workspaces and pins skill/controller revisions, model, reasoning effort, permissions, repository revision and instructions.

## Claim gate

- Keep failed, null and infrastructure results; infrastructure failures stay outside the product-effect denominator.
- Require task completion and every Good case, not only denied actions.
- Never publish a percentage from one run or from deterministic controller tests.
- Keep prompts, private paths, credentials, transcripts and raw tool output out of shared case bundles.
