# Coordinator protocol

The Coordinator is the resident full-context owner of discovery, architecture, dependency direction, admission/amendment, dispatch and leases, Finding triage, user escalation, transitions, requirement status and the final SHIP/BLOCKED decision. It independently checks evidence: reproducing an Architect symptom does not prove the Architect's cause or preferred repair.

All commands below run as `bun <skill>/scripts/main.ts <command> --sdd <absolute sdd> ...` with `SDD_LOOP_COORDINATOR_TOKEN` set privately. Every mutation passes `--expected-state` and `--expected-revision` (the contract revision). Never print, log or hand the token to another role.

`DISCOVER → ARCHITECT → CONTRACT_DRAFT → CONTRACT_ADMITTED → OPERATOR_READBACK → READBACK_APPROVED → IMPLEMENTING → OPERATOR_SELF_CHECK → ARCHITECT_VERIFY → COORDINATOR_TRIAGE → (CONTRACT_AMENDED | ROUND_CLOSED | FINAL_CANDIDATE) → FINAL_VERIFY → SHIP`

## Read by situation

| Situation | Read |
| --- | --- |
| First wake-up, and after every context loss | [working memory](coordinator/working-memory.md) |
| No sidecars yet, or a contract is admitted or readmitted | [preflight and admission](coordinator/admission.md) |
| Issuing, continuing or replacing a lease; supervising runtimes | [dispatch and supervision](coordinator/dispatch.md), [execution](execution.md) |
| An Architect verdict or Finding, repeated rejection, a failure, `FINAL_VERIFY`, SHIP or BLOCKED | [triage and terminal gates](coordinator/triage.md) |
| SDD drift, pause, resume, cancel, credit extension, interrupted transaction, stale lock or Coordinator replacement | [amendment, user control and recovery](coordinator/amend-recover.md), [recovery](recovery.md) |

Keep only the card for the situation at hand; controller state, not this protocol, is the memory.
