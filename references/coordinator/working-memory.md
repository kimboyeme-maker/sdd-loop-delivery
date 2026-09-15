# Coordinator · working memory

Read at the first wake-up and after every context loss.

The Coordinator is resident for the whole delivery. Whatever it reads usually stays in its conversation, and whether earlier material keeps counting toward later input depends on the host, not on this protocol, so no rule here can promise credit savings. What the protocol can control is how much is read and where decisions live: **controller state is the memory; the Coordinator's context is only a cache over it.** Read less, read precise projections (`coordinator-brief`, `--event-id`, `context-view`), record each decision through its command, and recover from the brief after compaction instead of from recollection.

**Working set.** At any moment the Coordinator holds only:

1. the latest `coordinator-brief --sdd <sdd>` (phase, obligations, admitted packets, active lease and deadline, pending decisions, open Findings, budgets, recent event IDs, `brief_fingerprint`);
2. one decision frame: the single obligation being handled plus the evidence event IDs it needs;
3. this protocol and the SKILL invariants.

Do not re-read or rely on anything else (role transcripts, full diffs, command output, earlier briefs, rejected alternatives) once the decision it informed is recorded; when a later decision needs evidence, load that evidence again by ID.

**Decision loop.**

1. Run `coordinator-brief`. Its obligation codes are derived from the same gates the commands enforce (for example FINAL_VERIFY reports `TRANSITION_SHIP` only when the SHIP gate passes, otherwise triage, a missing shard or verdict, or requirement status). Treat the first code as orientation for the next decision, not as a command to execute unread.
2. Load only the evidence that obligation needs: `coordinator-brief --sdd <sdd> --event-id <id>` for a signed event, the named SDD section through `context-view`, or a role's structured receipt fields. Never page the whole event log.
3. Decide and record the decision through its dedicated command, so the reasoning's outcome lives in signed state, not in context.
4. Judge the command by its returned receipt (protocol and event ID) or its error code. Then discard the frame and re-run the brief. `brief_fingerprint` only tells whether signed state changed: an idempotent replay (for example a repeated `runtime-record` ID) legitimately leaves it unchanged.

**Compaction and restart.** After any context loss, do not reconstruct from memory or re-ask the user for anything already recorded. Reload the credential from `SDD_LOOP_COORDINATOR_TOKEN_FILE`, run `audit` (history authenticity), then `coordinator-brief`, and continue from its obligations. A brief is cheap enough to re-run at every wake-up; it replaces reading history.

**Delegate reading, keep deciding.** The Coordinator owns route, scope, authority and triage decisions, not bulk reading:

- Diff and product inspection belong to the Architect (and the prepared Architect's `baseline_check`/`packet_check`). The Coordinator consumes the verdict, check bindings and Finding scopes.
- Test output is summarized by `test-run` (`outcome`, `duration_seconds`, `output_sha256`, a bounded tail). Read the tail only when triaging that specific failure.
- Operator progress arrives as structured receipts (`implementation`, `self_check`, `checkpoint`, `operator-reconcile`). Read receipt fields, not transcripts.
- Design exploration that needs wide reading is design counsel, with the result recorded as a `design_proposal`.

**Budgets are Coordinator inputs, not afterthoughts.** The brief carries attempts, rounds, round test seconds and the credit ledger. Credit units are relative effort estimates: in the default `observe` mode `budgets.credit.over_budget` is a planning signal, not a stop. Only an `enforce` ledger emits `REQUEST_CREDIT_EXTENSION`; then bring the user one decision with spend so far, what remains, and the smallest amount that reaches the next verifiable milestone (`user-control --action extend-credit --credit-amount N`).

**One SDD per Coordinator.** In a program split each SDD has its own Coordinator, worktree and brief. A Coordinator never loads sibling SDD contexts; cross-SDD coordination happens through the frozen foundation interface and the Supervisor's `program-status`.

**Hand over instead of degrading.** If the Coordinator repeatedly misreads state, loses track of recorded decisions, or its context has grown past usefulness despite this discipline, prefer a fresh Coordinator through the authorized takeover path. The brief plus the signed history is the complete handoff; no transcript is transferred.

**Anti-patterns.** Keeping every role reply "for reference"; re-reading the event log to re-derive state; pasting diffs or test logs into decisions; summarizing history into free text and trusting that summary over the brief; carrying a sibling SDD's context; polling the brief in a loop without a host event.
