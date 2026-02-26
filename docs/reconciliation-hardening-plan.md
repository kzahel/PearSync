# Reconciliation and State Hardening Plan

Date: February 26, 2026

## Goal

Harden sync correctness around conflict resolution, startup reconciliation, and stale local state so peers do not overwrite newer remote changes after downtime.

## Key Direction

1. Treat `mtime` as a UX hint, not authoritative conflict truth.
2. Reconcile remote state before local uploads on startup.
3. Make local state resilient to corruption and partial writes.
4. Add explicit typed manifest variants for file metadata, tombstones, and peer/config records.

## Data-Model Recommendations

1. Add per-file logical revision metadata:
   - `rev.writerKey`
   - `rev.seq` (or equivalent monotonic per-writer counter)
2. Add `baseHash` to updates and tombstones.
3. Keep `mtime` for display/sorting and secondary tie-break only.

## Reconciliation Rules

Given local file content hash (`localHash`), local tracked state, and remote manifest value:

1. `localHash === remoteHash`:
   - no-op, update local tracking.
2. `remote.baseHash === local.lastSyncedHash`:
   - safe fast-forward to remote.
3. `localHash === local.lastSyncedHash` and remote changed:
   - apply remote update/deletion.
4. Otherwise:
   - true divergence, create conflict copy.

## Startup Sequence (Target)

1. Load manifest and local state.
2. Scan local disk and compute hash for each tracked file.
3. Apply remote manifest/tombstones against local state (reconciliation pass).
4. Only after reconciliation, process local uploads and live watcher events.

## Local State Hardening

1. Persist checksum + backup:
   - `state.json`
   - `state.json.bak`
2. On parse/checksum failure:
   - recover from backup if valid
   - else rebuild state from disk + manifest
3. Preserve atomic write strategy and serialized write queue.

## TDD Plan

## Iteration 1 (Now): Startup Reconciliation Regressions

Add failing tests for:

1. Remote edit while peer is stopped should not be rolled back on restart.
2. Remote tombstone while peer is stopped should delete unchanged local file on restart.

Acceptance:

1. Restarting a stale peer does not overwrite newer remote content.
2. Restarting after remote delete does not resurrect deleted files.

## Iteration 2: State Corruption Recovery

Add failing tests for:

1. Corrupt `.pearsync/state.json` recovery from backup.
2. Corrupt state without backup rebuilds and continues syncing.

Acceptance:

1. `engine.ready()` does not fail hard on parse corruption.
2. Sync resumes with deterministic reconciliation behavior.

## Iteration 3: `mtime` / revision conflict semantics

Add failing tests for:

1. Divergent edits with skewed clocks.
2. Same-content concurrent edits without conflict.
3. Edit-vs-delete with explicit base mismatch.

Acceptance:

1. Decisions are revision/baseHash-driven.
2. `mtime` alone cannot force incorrect conflict winners.

## Iteration 4: Manifest typing and reserved-key policy

Add failing tests for:

1. Peer/config entries parsed through typed unions without unsafe casts.
2. Reserved-key path policy is explicit and enforced.

Acceptance:

1. No `as unknown as` casts for manifest values in sync path.
2. Reserved path behavior is deterministic and documented.

