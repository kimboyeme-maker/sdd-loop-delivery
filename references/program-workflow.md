# Cross-SDD workflow

Load only for a user's explicit instruction to start or resume a multi-SDD workflow. Document creation is not startup authority. One root scheduling task coordinates independent execution-SDD tasks; do not execute a group document with the leaf controller or create a team per tree level.

Host calls use the neutral program operations of the active host profile ([hosts](hosts.md)): `project_discover`, `task_create`, `task_message`, `task_wait`, `task_list`, `wake_schedule`. Read the resolved calls with `bun <skill>/scripts/main.ts configuration`. An unavailable operation takes the fallback named below; never emulate it with an unrelated tool, and never run a child delivery as an in-session subagent unless the profile maps `task_create` to that.

## Commands and authority

Use `bun <skill>/scripts/main.ts <command> --program <absolute-root-SDD>`. `program-check` and `workflow-status` are read-only. Mutations add `--payload-file <json>`; JSON is data, not executable code.
| Command | Payload / result |
| --- | --- |
| program-start | scheduler_task_id, authorization_ref, max_parallel, total_test_seconds, optional project_ref, host_ref, wake_mode; returns private token_file and revision |
| program-next | scheduler_task_id, expected_revision; reserves at most one CREATE_TASK intent, or returns WAIT |
| program-record | scheduler_task_id, expected_revision, action and fields below |
| program-stop | scheduler_task_id, expected_revision; stops new dispatch, does not stop children |
| program-resume | scheduler_task_id, expected_revision; continues the same mappings and budget |
| program-lock-recover | scheduler_task_id, expected_revision, lock_hash, owner_stopped: true, authorization_ref; only exact orphan lock recovery |

The run records the active host profile id; every mutation under another profile fails with `PROGRAM_HOST_MISMATCH`.
Set `SDD_PROGRAM_TOKEN_FILE` to the private returned file for mutations. Never print its contents, put it in a child prompt or pass it to test subprocesses. Status revision changes on dispatch and test reservations; refresh it after a mismatch, do not replay a host creation call.

`workflow-status`, `program-stop`, `program-resume` and `program-lock-recover` also accept `--run <absolute-root.workflow.json>` instead of `--program`. Use the exact durable record when the root SDD is missing. Stop persists paused before trying to parse sources; degraded status returns the mappings and source error. Resume still requires valid, reconciled sources.

Record actions:

- `wake`: wake_id, host_receipt (the real `wake_schedule` result). Only for `wake_mode: scheduled`.
- `bind`: bundle_id, intent_id, task_id, worktree, sdd, host_receipt. Use the host's final task identifier, never a client-side provisional one. The child must not initialize before binding. Binding installs a budget locator in Git's common directory, outside product files.
- `creation-result`: bundle_id, intent_id, outcome: UNKNOWN | NOT_CREATED, host_receipt. NOT_CREATED additionally requires no_task_created: true backed by a definitive host failure or the user's statement that no task was started, never merely an empty task listing. UNKNOWN preserves the intent for reconciliation.
- `retry-creation`: bundle_id, intent_id. Only a confirmed failed creation may retry; returns the next CREATE_TASK action while retaining prior intent/receipt history and all reservations. A successful-but-lost creation must bind the original task instead. Capacity and dependencies are checked again.
- `handoff`: bundle_id. After child SHIP and controller wind-down, before committing, authenticate the current candidate and the linked Asset/Bundle/Entry acceptance. Every linked claim must be verified with current independent PASS evidence. Freeze product/history hashes, acceptance event IDs, contract revision, candidate ID and Asset file hashes. Repeating accepts only the same handoff. Complete child runtime records before this freeze; later child events invalidate it.
- `release`: bundle_id, commit (full commit hash). After obtaining required commit authority and committing unchanged bytes, bind the immutable commit. The controller checks real committed Asset contents and every required predecessor commit. Consumers inherit this recorded commit, never a later HEAD. A normal commit changes HEAD/index, so this step uses frozen content rather than the pre-commit worktree fingerprint.
- `stopped`: bundle_id, intent_id, task_id, writers_stopped: true, commands_stopped: true, host_receipt. Record actual product-writer/command termination, not an ended response. The child must be terminal and have no primary/shard lease or preparation. The history-bound observation allows its concurrency slot to be released; allocations are not reclaimed. This may follow handoff/release and does not write a child event.
- `reconcile`: only while paused, authorization_ref plus max_parallel and total_test_seconds matching the revised program. Unstarted branches may change. A dispatched child needs its ordinary authenticated amendment first, matching root/child SDD bytes, no active lease/preparation, and child_reconciliations keyed by Bundle with the current state_hash and real host_stop_receipt. Its upstream commits must stay unchanged; shipped definitions cannot be replaced. Allowances may only grow with explicit user authority and an updated plan; no spent or in-flight reservation is reclaimed.

The runtime records facts and explicit authority references supplied by the host-facing agent. It cannot cryptographically prove a user message or host tool receipt. Do not fabricate them. A receipt names the actual call or, for a user-performed step, the user's message. File locks and expected revisions serialize mutations; the owner task and private token prevent another scheduler from casually dispatching the same program. Do not rotate ownership because a response ended. A missing owner/token requires user-directed recovery, never a new workflow with reset budgets.

Lock recovery is serialized by `<run>.recovery.lock`. It rereads the target lock and run under that mutex, verifies a stopped local owner, advances the run revision before removing the orphan, and never automatically removes a recovery mutex. An interrupted first start with no run record uses `initial_start: true`, `expected_revision: 0`, the exact lock_hash, owner_stopped and explicit authorization_ref; preserve any existing token. Unverifiable/foreign owners and an orphan recovery mutex remain user-directed recovery, not timeout-based takeover.

## Startup: one user action, explicit limits

1. Read the root program and run program-check; validate each leaf with the ordinary SDD gates. program-start repeats the leaf `validate` and refuses with `PROGRAM_CHILD_INVALID` before any task or budget exists. Present missing concurrency/total-budget choices together. A proposed allocation is not authorization; zero test seconds is supported. User test restrictions still apply even when a numeric allowance exists.
2. Confirm the repository, base commit and which program operations this session actually holds. With `project_discover`, resolve the project reference `task_create` needs; without it, the scheduler's own repository is the project. The static profile is not a live host receipt.
3. Run program-start with the scheduling task's real identifier and the user's authorization reference. `wake_mode` defaults to `scheduled` when the profile has `wake_schedule`, otherwise `attended`; `scheduled` on a host without it fails with `PROGRAM_HOST_OPERATION_UNAVAILABLE`. Keep `<root>.workflow.json` and its token outside child worktrees. Do not commit the token or runtime files.
4. `scheduled`: create one recurring wake through `wake_schedule`. Its prompt: resume this exact program and mappings, advance only ready work within the user's limits, keep quiet while unchanged, notify on meaningful progress, completion, failure or required user action. Use a modest interval (about five minutes); active execution waits on task events rather than polling. Record the result with action `wake`. If creation is uncertain, inspect existing wakes before retrying. Until recorded, status is `WAITING_HOST` and nothing dispatches. Disclose host limits of the wake (session-only, expiry). `attended`: no unattended continuation; tell the user the workflow advances only while the scheduling task is active or is asked to resume.
5. Run program-next. A CREATE_TASK result already has a durable intent; never call it again to replace an uncertain task creation.

## Host creation handshake

CREATE_TASK returns the prompt, base commit, required commits, project_ref/host_ref and `host_call`, the active profile's `task_create` mapping. With `task_create` available, call it with the prompt and base commit, selecting a new worktree. Without it, give the user the prompt and base commit, ask them to start one separate task in a new worktree of the same repository, and use their report as the receipt; do not start the child in the scheduler's context. Do not set a model unless the user requested it; leaf role selection belongs to its skill. The prompt names program, Bundle and unique intent so a lost response can be reconciled against actual tasks.

The child's initial assignment is read-only: report its actual task identifier, worktree and SDD location, then wait. If the SDDs were not committed at the selected base, copy the exact approved SDD and its required referenced documents into the child workspace before binding, within file authority. Do not copy other controller sidecars, credentials or unrelated working changes. The bind command compares the child SDD bytes with the approved source; normal leaf source binding covers its companion documents.

Obtain the final task identifier and real paths, then record `bind`. Binding rejects a shared worktree, another repository, a divergent SDD, a duplicate task, or a child initialized too soon. After the successful record, send CONTINUE with its bound SDD path and allocation through `task_message` (or through the user when unavailable). A crash between marker publication and state publication repeats the same bind, not task creation.

Bind replay must name the same task, worktree, SDD and intent; it cannot move an active assignment. CREATE_TASK includes the approved absolute source path. Do not substitute a similarly named document.

Each child uses sdd-loop-delivery with its normal Coordinator and roles. If several predecessor commits are required, its admitted integration-first batch incorporates them under explicit merge authority; it must not implement dependent consumer behavior before those inputs are available. A merge outside declared scope goes back to design/authority. Never ask the root scheduler to perform unowned product edits. Child SHIP alone is insufficient until the actual handoff commit includes all required predecessor commits and current product bytes.

The Bundle's integration_batch_id references that exact existing batch; every other batch follows it transitively. Missing inputs permit only this batch, and candidate registration requires all inputs in the actual worktree. A separate integration Bundle is optional. Shared checks run at dispatch, the existing write action-gate, test-run launch and implementation registration. First product dispatch requires guidance; runtime-record guidance adds controller-derived program_context and context-view exposes it. Reuse ordinary start/readback/acknowledgment. This enforces supported controller paths; action-gate still needs a trusted host adapter to intercept arbitrary tool actions.

## Event-driven advancement and recovery

Wait on active tasks through `task_wait`, then re-read workflow-status; host idle/completed is only a wake-up signal. Use bounded waits of at most 60 seconds while actively communicating. Without `task_wait`, re-read status on each wake or user resume. On a wake, inspect status once, reconcile changed tasks and advance; do not emit unchanged updates.

The controller reads authenticated child histories and current sources/candidates. Child Coordinator events carry proofs verifiable with the epoch's registered public key, so the scheduler authenticates a child without ever holding its credential; never copy a child token into the scheduler. SHIP requires a committed handoff with declared Asset paths and all predecessor commits present. Commit and merge permissions are separate: ask when required, preserve the candidate while waiting. Structural metadata, a hash or Asset existence alone never proves business acceptance; the leaf's independent SHIP gate supplies that evidence.

For each ready slot run program-next, create/bind/continue its task, and repeat up to capacity. Pending/unknown creation intents count against capacity. Unclear creation results require searching actual tasks for the exact intent through `task_list`, or asking the user when it is unavailable. Record a definitive failure through creation-result before retry-creation; failed attempts stop occupying capacity but remain in history. Product terminal state alone does not release an active slot: record actual stopped writers/commands.

The root status distinguishes WORKING, WAITING_HOST, WAITING_USER, WAITING_BUDGET, WAITING_DEPENDENCY, PAUSED, FAILED and COMPLETE. Child phase preserves the actual product state; wait_reason is derived separately. Budget exhaustion never overwrites SHIP/BLOCKED/CANCELLED. Healthy independent branches may proceed within remaining capacity. COMPLETE requires all released deliveries, Entry composition coverage/declared acceptance and stopped writers. A paused or waiting child retains its task and allocation; don't recycle them while commands may still run.

program-stop stops only new dispatch. If the user asks to stop active work, separately request/confirm child writer and command stops using actual host tools; don't claim that changing scheduler state killed them. Stop or pause the recorded wake when the user requests it. On COMPLETE, stop the recorded wake and report delivered commits/Assets and the remaining unverified limits; do not archive tasks unless requested.

Source drift blocks new dispatch, not preservation. Pause and reconcile authorized changes to unstarted work; dispatched-definition changes require the owning child's explicit amendment and a reviewed recovery, not deleting its slot or starting a successor to evade obligations. No automatic ownership takeover or destructive stale-lock deletion is provided.

Include all shard leases and preparation in quiescence checks. Do not reset controllers, rewrite old evidence, reclaim reservations or silently accept an old post-commit fingerprint.

## Budget semantics

Program allowances are disjoint lifetime allocations. Binding is captured by child init and checked by test-run; omitting an environment variable cannot remove it. Every Operator, Architect and prepared run reserves its entire allowed timeout atomically before execution. It is also bounded by existing packet, round and lease limits. Reservations are never refunded, including failed starts, crashes or lost registration: unused reservations are conservative lost capacity, not measured spend. They survive rounds and retries. No child can borrow another's allowance.

The budget does not authorize a test. User prohibition still wins. Existing new-test-file limits remain unchanged; do not multiply test scope by Meta or SDD count. Exhaustion requires a real user decision; no automatic extension or BLOCKED claim. Internal credit units and reserved seconds are not billed credits; no actual billing hard cap is claimed. This enforces the supported controller test-run path, not an OS-level barrier against arbitrary unauthorized commands.

## Final user report

Report the root status; execution task count and actual task links; each Bundle's SDD, worktree, dependency state and committed handoff; completed and waiting branches; authorized/allocated/reserved seconds; which program operations were host calls and which were user-performed; and next required user decisions. Distinguish structure checks from runtime implementation evidence. A parent is complete only when all effective execution obligations and their declared integration Bundle are complete, never simply because all host responses ended.
