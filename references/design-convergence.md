# Design convergence and implementation logic

Read when reconstructing an SDD's implementation paths before admission, or when evidence materially disproves an admitted route, migration closure, evidence lifecycle, packet DAG or recovery plan. Do not use it for editorial changes or mechanically obvious corrections with a complete oracle.

## Implementation logic reconstruction

`implementation_logic` (`implementation-logic/v1`) is a compact projection of the SDD's canonical pseudocode: `paths[]` covering every Must-Ship requirement and acceptance; each path has `inputs` (`ENTRY` only for verified caller/environment prerequisites, otherwise a producing path), ordered `steps` (`requires`, `produces`, executable `pseudocode`, explicit `failure`), `outputs`, and executed `challenges` whose `result` is `CLOSED` with evidence. Cross-path producer edges are acyclic; intentional loops live inside bounded pseudocode.

The author describes the contract paths before declaring loop readiness. Coordinator independently reconstructs the current admitted paths from repository and runtime evidence, tracing forward from entry points and backward from acceptance, and records `sdd_convergence_review.logic_review`. With `must_ship_decision_closure.scope: CURRENT_ADMISSION`, only paths explicitly mapped to disjoint later requirements may be excluded; shared or unmapped paths remain included. Prerequisite interfaces and authority must already be established:

```json
{
  "design_fingerprint": "SHA-256 of the canonical implementation_logic JSON",
  "traces": [
    {
      "path_id": "LJ01",
      "step_ids": ["BZ01", "BZ02"],
      "counterexample": "A missing value arrives while a previous result exists",
      "method": "Run invalid and valid inputs against the owning path",
      "observed_result": "Invalid input preserves prior state; valid input publishes",
      "result": "PASS",
      "evidence": ["actual trace location"]
    }
  ]
}
```

Use the controller's canonical JSON for the fingerprint (from `context-view`), never an example digest. Every path appears once with every authored step. Structural validation proves coverage and ordering only; omitted branches, false `ENTRY` assumptions and fictional evidence remain the author's and Coordinator's semantic responsibility. A blocker derivable from available facts but discovered during implementation is a design/review miss: repair the owning pseudocode and shared dependencies, then readmit.

## Architect proposal, Coordinator convergence

1. Dispatch the Architect with `--verification-mode design-counsel` while in `CONTRACT_DRAFT`, `CONTRACT_AMENDED` or `COORDINATOR_TRIAGE`. The lease is read-only with empty modification scope and consumes no product attempt.
2. Architect records `design_proposal`: `proposal_id`, `materiality` (`BOUNDED | MATERIAL`), trigger, problem evidence, root cause, independent checks, counterexamples against the current route, one falsifiable claim per review dimension (`STATE_EVIDENCE_LIFECYCLE`, `PACKET_DEPENDENCY`, `SCOPE_AUTHORITY`, `VERIFICATION_TOPOLOGY`, `FAILURE_RECOVERY`), real `route_options` with one `recommended_route_id`, `contract_preservation` for every user boundary, state/evidence and packet invariants, falsifiers, unknowns, and `authority_classification`.
3. Coordinator records `design_resolution` with an `evidence_review`:
   - `CHALLENGE`: at least one failed review dimension, concrete counterexamples, challenged claim IDs, exact required revisions; `evidence_review.result` is `DISPROVED`. The same design Architect answers under a fresh lease with a proposal whose `responds_to_design_resolution_event_id` names that challenge and whose `challenge_responses` answer every required revision (`CORRECTED` or `UPHELD_WITH_EVIDENCE`, each with evidence). Coordinator may not substitute an unreviewed plan.
   - `CONVERGED`: all five dimensions PASS, no unknowns, one selected proposed route, rejected failure modes, falsifier evidence, matching authority classification, every pending required revision resolved; `evidence_review.result` is `CONFIRMED`. A sound first proposal may converge directly.
4. Install the design through normal amendment and readmission. `COORDINATOR_OWNED` repairs continue without asking the user; only `USER_AUTHORITY_REQUIRED` becomes a `USER_DECISION`.

Do not manufacture a compulsory FAIL, disagreement, second call or changed claim. A `MATERIAL` author may continue revisions but cannot verify the adopted implementation; dispatch a distinct Architect (`fresh-independent`). A later ADMIT may list `superseded_design_resolution_ids` together with `design_supersession_evidence` and its new CONVERGED `design_resolution_event_id` only when the old route is completely replaced; partial replacement keeps the old author excluded.

## User authority boundaries

User authority is required only to change or defer Must-Ship scope, accept material security/data risk, break a public API, move major ownership, delete behavior, perform irreversible/external actions, or decide a choice the user or SDD reserved. Even an obvious best route needs permission to cross such a boundary; Coordinator recommends it rather than outsourcing selection.

Custody refreshes inside the admitted artifact envelope (re-signing, rotating process-local keys, byte-exact reinstall at the admitted path) and reassigning execution roles for an admitted artifact are Coordinator operations, not user decisions; the controller rejects a request with no true authority delta. Offline dependency hydration from the existing lockfile that changes only disposable materialization is a reversible execution prerequisite.
