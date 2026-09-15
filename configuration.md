# Configuration

Generated from `agents/roles.json`, `scripts/config/constants.ts` and the phase policies; edit those sources, then run `bun run render:configuration`. `agents/openai.yaml` only controls the skill picker.

## Agent roles

| Role | Tier | Model | Reasoning | New runtime context | Authority |
| --- | --- | --- | --- | --- | --- |
| Supervisor | Invoking main thread | Invoking main thread | Inherited | inherited | Owns host orchestration and progress supervision; does not sign product evidence. |
| Coordinator | frontier | gpt-6-astra | medium | isolated | Owns admission, dispatch, decisions and controller recovery. |
| Operator | standard | gpt-5.6-terra | medium | isolated | Implements admitted scope and directly signs implementation and self-check evidence. |
| Architect | review | gpt-5.6-sol | medium | isolated | Independently verifies candidates or contributes explicitly scoped design advice. |

Models are resolved from the role tier through the active host profile (`codex`, `agents/hosts/*.json`); select another with `SDD_LOOP_HOST` or `SDD_LOOP_HOST_PROFILE_FILE`. Read the live projection with `bun scripts/main.ts configuration`.

## Host operations

| Operation | Available | Call | Parameters |
| --- | --- | --- | --- |
| `spawn` | true | `spawn_agent` | task_name, message, fork_turns, model, reasoning_effort |
| `direction_update` | true | `send_message` | target, message |
| `idle_continuation` | true | `followup_task` | target, message |
| `wait` | true | `wait_agent` | timeout_ms |
| `interrupt_turn` | true | `interrupt_agent` | target |
| `close` | false | No close tool in the bundled collaboration surface. Interrupt preserves the runtime; archive/unsubscribe do not prove released capacity. Enable only through a verified custom host bridge. |  |
| `observe` | true | `list_agents` | path_prefix |
| `resume_closed` | false | No closed-runtime resume tool in the bundled collaboration surface. Use followup_task for an existing idle runtime; thread/resume requires a verified host bridge. |  |
| `goal_create` | true | `create_goal` | objective |
| `goal_read` | true | `get_goal` |  |
| `goal_complete` | true | `update_goal` | status |
| `goal_get` | true | `thread/goal/get` | threadId |
| `goal_set` | true | `thread/goal/set` | threadId, objective, status, tokenBudget |
| `goal_clear` | true | `thread/goal/clear` | threadId |
| `turn_steer` | true | `turn/steer` | threadId, input, expectedTurnId |
| `turn_interrupt` | true | `turn/interrupt` | threadId, turnId |
| `usage_read` | true | `account/usage/read` |  |
| `user_goal_control` | true | `/goal pause\|resume\|clear` |  |

## Operator profiles

| Profile | Tier | Model | Reasoning | Use |
| --- | --- | --- | --- | --- |
| `standard` | standard | gpt-5.6-terra | medium | Default implementation profile for work requiring code judgment, discovery, or nontrivial coordination. |
| `bounded` | efficient | gpt-5.6-luna | medium | Cost-sensitive profile for a closed mechanical route with exact writes and deterministic checks. |
| `escalated` | frontier | gpt-6-astra | medium | Fresh implementer on the strongest tier after two consecutive Architect rejections or stagnant attempts on the same admission; never a default. |

`standard` is the default. `bounded` requires a signed closed mechanical route; it is never inferred from prompt length or model price.

## Protocol constants

Test time, share, file-count and acceptance-timeout constants are defaults. Larger declared limits require acceptance-bound justification; actual runs remain bounded by the admitted allowance and lease.

| Constant | Current value |
| --- | --- |
| `ACCEPTANCE_TIMEOUT_MAX_SECONDS` | `900` |
| `COORDINATOR_BRIEF_RECENT_EVENTS` | `8` |
| `DEFAULT_CREDIT_BUDGET_PER_ROUND` | `60` |
| `ESCALATED_OPERATOR_MIN_FAILURES` | `2` |
| `MAX_NEW_TEST_FILES_PER_BATCH` | `1` |
| `MINIMUM_BUN` | `1.4.2` |
| `PROTOCOL` | `sdd-loop-delivery/v1` |
| `RUNTIME` | `bun` |
| `SDD_DOCUMENT_ID_PATTERN` | `^[A-Z]{2}[0-9]{2,4}$` |
| `TEST_BUDGET_MAX_MINUTES` | `15` |
| `TEST_BUDGET_MAX_SHARE_DIVISOR` | `3` |
| `TEST_RETRY_BUDGET_MULTIPLIER` | `2` |
| `TEST_RUN_OUTPUT_TAIL_BYTES` | `2000` |
| `TOKENS_PER_CREDIT_UNIT` | `20000` |
| `TYPESCRIPT` | `>=7` |

## SDD document IDs

Pattern: `^[A-Z]{2}[0-9]{2,4}$`. IDs start at 01, extend to four digits and are never recycled.

| Prefix | Category |
| --- | --- |
| `PC` | batch |
| `JZ` | matrix |
| `BH` | closure |
| `MJ` | gate |
| `XQ` | requirement |
| `YS` | acceptance |
| `JC` | decision |
| `FX` | risk |
| `LJ` | implementation_path |
| `BZ` | implementation_step |
| `DL` | claim |
| `SP` | design_review |
| `YL` | legacy_surface |
| `DY` | reader |
| `ZJ` | evidence |

## Agent event authority

| Role | Allowed authored events |
| --- | --- |
| Supervisor | None |
| Coordinator | `challenge_resolution`, `context_policy`, `contract_admission`, `contract_amendment`, `convergence_review`, `coordinator_dependency_decision`, `coordinator_identity`, `design_resolution`, `dispatch`, `execution_substrate_receipt`, `finding_decision`, `finding_status`, `operator_reconcile`, `pipeline_incident`, `pipeline_repair`, `preparation_grant`, `preparation_revoked`, `project_context`, `readback_decision`, `recovery`, `requirement_status`, `round_close`, `runtime_record`, `state_transition`, `terminal_blocker`, `timeout_decision`, `user_decision` |
| Operator | `agent_started`, `capability_probe`, `checkpoint`, `context_refresh`, `contract_readback`, `dependency_operation_proposal`, `implementation`, `implementation_escalation`, `plan_challenge`, `self_check` |
| Architect | `agent_started`, `capability_probe`, `checkpoint`, `context_ready`, `dependency_safety_review`, `design_proposal`, `finding`, `verification` |

## Role event phases

| Role | Event | Allowed phases |
| --- | --- | --- |
| Operator | `context_refresh` | `OPERATOR_READBACK`, `READBACK_APPROVED`, `IMPLEMENTING`, `OPERATOR_SELF_CHECK` |
| Operator | `capability_probe` | `OPERATOR_READBACK`, `IMPLEMENTING`, `OPERATOR_SELF_CHECK` |
| Operator | `agent_started` | `OPERATOR_READBACK`, `IMPLEMENTING`, `OPERATOR_SELF_CHECK` |
| Operator | `contract_readback` | `OPERATOR_READBACK` |
| Operator | `plan_challenge` | `OPERATOR_READBACK` |
| Operator | `implementation_escalation` | `IMPLEMENTING` |
| Operator | `implementation` | `IMPLEMENTING` |
| Operator | `self_check` | `OPERATOR_SELF_CHECK` |
| Operator | `checkpoint` | `OPERATOR_READBACK`, `IMPLEMENTING`, `OPERATOR_SELF_CHECK` |
| Operator | `dependency_operation_proposal` | `OPERATOR_READBACK`, `IMPLEMENTING` |
| Operator | `test_run` | `IMPLEMENTING`, `OPERATOR_SELF_CHECK` |
| Architect | `capability_probe` | `CONTRACT_DRAFT`, `CONTRACT_AMENDED`, `COORDINATOR_TRIAGE`, `ARCHITECT_VERIFY`, `FINAL_VERIFY` |
| Architect | `agent_started` | `CONTRACT_DRAFT`, `CONTRACT_AMENDED`, `COORDINATOR_TRIAGE`, `ARCHITECT_VERIFY`, `FINAL_VERIFY` |
| Architect | `design_proposal` | `CONTRACT_DRAFT`, `CONTRACT_AMENDED`, `COORDINATOR_TRIAGE` |
| Architect | `dependency_safety_review` | `CONTRACT_DRAFT`, `CONTRACT_AMENDED`, `OPERATOR_READBACK`, `IMPLEMENTING`, `COORDINATOR_TRIAGE` |
| Architect | `verification` | `ARCHITECT_VERIFY`, `FINAL_VERIFY` |
| Architect | `test_run` | `ARCHITECT_VERIFY`, `FINAL_VERIFY` |
| Architect | `finding` | `ARCHITECT_VERIFY`, `FINAL_VERIFY` |
| Architect | `checkpoint` | `ARCHITECT_VERIFY`, `FINAL_VERIFY` |

## Phase transitions

| Phase | Allowed next phases |
| --- | --- |
| `DISCOVER` | `ARCHITECT`, `BLOCKED` |
| `ARCHITECT` | `CONTRACT_DRAFT`, `BLOCKED` |
| `CONTRACT_DRAFT` | `CONTRACT_ADMITTED`, `BLOCKED` |
| `CONTRACT_ADMITTED` | `OPERATOR_READBACK`, `BLOCKED` |
| `OPERATOR_READBACK` | `READBACK_APPROVED`, `CONTRACT_AMENDED`, `BLOCKED` |
| `READBACK_APPROVED` | `IMPLEMENTING`, `BLOCKED` |
| `IMPLEMENTING` | `OPERATOR_SELF_CHECK`, `CONTRACT_AMENDED`, `BLOCKED` |
| `OPERATOR_SELF_CHECK` | `ARCHITECT_VERIFY`, `IMPLEMENTING`, `BLOCKED` |
| `ARCHITECT_VERIFY` | `COORDINATOR_TRIAGE`, `BLOCKED` |
| `COORDINATOR_TRIAGE` | `CONTRACT_AMENDED`, `ROUND_CLOSED`, `FINAL_CANDIDATE`, `BLOCKED` |
| `CONTRACT_AMENDED` | `OPERATOR_READBACK`, `BLOCKED` |
| `ROUND_CLOSED` | `CONTRACT_DRAFT`, `FINAL_CANDIDATE`, `BLOCKED` |
| `FINAL_CANDIDATE` | `FINAL_VERIFY`, `BLOCKED` |
| `FINAL_VERIFY` | `SHIP`, `COORDINATOR_TRIAGE`, `BLOCKED` |
| `SHIP` | terminal |
| `BLOCKED` | terminal |

`PAUSED` and `CANCELLED` are entered only through `user-control`; they are not ordinary transitions.

## Other executable tables

`ADMISSION_ASSUMPTION_CATEGORIES`, `ARTIFACT_INSTALL_MODES`, `ARTIFACT_KINDS`, `ARTIFACT_ROLES`, `AUTHORITY_BASIS_DELTA_KEYS`, `AUTHORITY_DELTA_KEYS`, `CREDIT_WEIGHTS`, `DECISION_CLOSURE_DIMENSIONS`, `DECISION_EVIDENCE`, `DESIGN_PRESERVATION_BOUNDARIES`, `DESIGN_REVIEW_DIMENSIONS`, `EVIDENCE_KINDS_BY_CLAIM`, `FINDING_DECISIONS`, `FRESH_ARCHITECT_REASONS`, `READER_INVENTORY_EVIDENCE_KINDS`, `ROLES`, `RUNTIME_REMOVAL_CLAIM_DIMENSIONS`, `SDD_DEFAULT_ID_PREFIXES`, `TERMINAL_BLOCKER_REASONS`, `USER_AUTHORITY_BASES`
