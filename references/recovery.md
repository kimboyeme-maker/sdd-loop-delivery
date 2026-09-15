# Native task recovery

People supervising a delivery use the symptom-based [runbook](runbook.md).

Coordinator first reads `audit` and current native state. Preserve product files, event history, counters and pending journal. Never delete a journal, reconstruct state, replay a product command or create a replacement task to bypass recovery. A response ending alone requires continuation, not recovery.

## Interrupted transaction

1. Confirm through the host that the previous agent and its active commands have stopped. A timeout, idle label or missing message does not prove this.
2. If an orphan lock remains, use `recover --kind lock` with its actual SHA-256 as `--expected-lock-hash`, `--owner-stopped yes` and the applicable `--user-authorized yes`. These flags record existing authorization and observed facts; do not invent either. Authenticate with the current Coordinator credential. The command removes only the matching lock and preserves the journal. Each lock records `pid`, `host` and a unique nonce, so its hash names one lock instance; `recover --kind lock` refuses with `LOCK_OWNER_STILL_ACTIVE` / `LOCK_OWNER_POSSIBLY_ACTIVE` when that owner process is observably alive on this host. A dead PID never replaces the stop confirmation.
3. If a journal remains, run `recover --kind transaction --role coordinator` with the actual `--sdd`, `--expected-state`, `--expected-revision` and `--all-previous-writers-stopped yes`. Recovery checks the signed target bytes and reachable commit stage. It completes the original commit; it does not execute the underlying product work again.
4. Read `audit` and `status` again before selecting the next obligation. A successful transaction recovery is not product verification or SHIP.

Commands that work inside a round verify only the lines after the round checkpoint; `audit`, `status` and SHIP verify the whole log. Run `audit` after anything may have touched the sidecars.

`EVENT_LOG_TAIL_AHEAD` means the log extends the committed prefix (an interrupted commit): recover the transaction, or adopt the tail through an authorized `recover --kind takeover`. `EVENT_LOG_HISTORY_MISMATCH` means committed events were removed, reordered or altered; no command repairs it. Preserve all files, report the incident, and restore the sidecars from an intact copy only with explicit user authorization.

For first `auth-bootstrap` interrupted before credentials reached state, retain the original bootstrap token. The recovery commands accept it only when it authenticates a pending first-authority journal whose target preserves all product facts. Missing, mismatched or malformed evidence is not permission to bootstrap over existing state.

If that first attempt stopped before even creating a journal, `recover --kind lock` can remove the orphan lock under explicit user authorization and confirmed owner stop, but only in uncredentialed DISCOVER with no active grants or verification-key history. The exact lock hash is still required. Then perform the original authorized bootstrap normally; no authority or product evidence was restored by removing the lock.

Coordinator rotation journals retain evidence from the approving epoch. Authenticate recovery using whichever Coordinator credential the persisted state currently recognizes; journal verification uses the retained public key and does not require borrowing the other Coordinator's private credential. Never print tokens or put them in a receipt.

## Pause and resume

`user-control --action pause` requires existing user authorization. With an active lease, confirm its execution stopped and supply its actual signed `SAFE_TO_RESUME` checkpoint; a made-up ID or another lease's checkpoint is invalid. Pause revokes active execution and preparation authority.

`user-control --action resume` restores only the phase attested by the authenticated pause decision. It does not restore the old lease or extend its deadline. Dispatch normally after checking current admission and role eligibility. New pause decisions remain verifiable across Coordinator rotation. An early HMAC-only pause cannot be guessed or silently converted into a signed historical decision.

## Coordinator replacement

Both commands take the new Coordinator's actual host spawn receipt through `--runtime-receipt-file`; a missing, mismatched or wrong-model receipt is rejected before authority changes. Use `recover --kind bootstrap` only before delivery starts and within its documented safe-state checks. Use `recover --kind takeover` for an authorized later replacement, after stopping previous execution, removing active grants and recovering pending transactions. Both preserve historical Coordinator identities, rotate epoch and credential, and retain public verification keys. Neither clears product history or grants product-role eligibility to a former Coordinator.

A resource or authentication failure is a control-plane incident, not a product failure. Preserve the smallest concrete error and use an already authorized recovery route; do not weaken gates, invent host receipts or change the user's SDD to make the command pass.
