# Coordinator · amendment, user control and recovery

Read when the SDD drifts, the user pauses, resumes, cancels or extends credit, or authority, a transaction or a lock needs recovery.

- SDD drift stops dispatch. Use `amend --contract-revision <next> --reason ...`; objective, ownership, requirement or acceptance changes additionally need `--scope-change-authorized yes --scope-change-reason` from explicit user authority. `--lineage-correction yes` is limited to pre-delivery classification errors.
- Pause/resume/cancel only on explicit user instruction via `user-control --user-authorized yes`; pausing an active lease needs `--writer-stopped yes --checkpoint <signed SAFE_TO_RESUME event>`.
- Terminal product outcomes and evidence are immutable. Terminal/paused controllers still accept resource wind-down records; paused controllers additionally accept user-control resume/cancel and authority recovery, as specified in [roles](../roles.md).
- A completely replaced adopted design may be retired by an ADMIT carrying `superseded_design_resolution_ids`, `design_supersession_evidence` and its new CONVERGED `design_resolution_event_id`; only then is the old author released from the independence exclusion.
- Interrupted transactions, stale locks and Coordinator replacement follow [recovery](../recovery.md). `recover --kind takeover` and `recover --kind bootstrap` require `--runtime-receipt-file` naming the new `--coordinator-agent-id`.
- When an amendment adds rows, `document-next-id --sdd <sdd> --prefix XX` suggests the next unused document ID without writing it.
