# Explicit native state migration

This migration converts only Fate's existing **queue, task and GoalMax state** into the native Pi Durable document store. It is an offline, same-host operation. It does not convert or rewrite Pi session JSONL, Agent Team conversations, worktrees, Git repositories, archived transcripts or provider credentials. It never constructs a Harness, submits an input, runs a tool or starts a scheduler.

## Operator workflow

1. Stop all relevant Fate processes. Stop Pi Terminal, older Fate versions and external writers that may use the same files. Never remove an uncertain owner lock merely because its PID or heartbeat looks old.
2. Select an existing private backup directory outside the profile, Pi directory, session directory, lock namespace and projects. Use the source and destination application versions being evaluated.
3. Run the host-local `MigrationService.dryRun()` through the host's explicit migration entry point. Review every error and notice. Dry run reads and checks paths, schemas, session references, ownership records and available space; it does not create locks, backup directories or native state.
4. Preserve the returned exact plan and apply that plan explicitly. Apply acquires the same profile lock as production startup, acquires referenced checkout locks, and rechecks physical identities and the complete manifest under ownership. It refuses new or changed source data rather than silently updating an approved plan.
5. Keep the complete backup and plan. Start the candidate only after activation is reported and the host's other safety checks pass. Review recovered drafts and historical work before any new execution.

`MigrationService` is a host-internal orchestrator, not a generic network or renderer path API. CLI/UI integration must pass host-resolved `FatePaths`, application versions and an operator-selected backup directory. These instructions do not authorize deployment, actual user-data migration or final product acceptance by themselves.

## Exact data treatment

- The complete `session-queues`, `tasks` and `goalmaxxing` namespaces are inventoried and privately backed up, including every supported archived goal, source brief and event journal. Unknown files, temporary crash files, unsupported versions and corrupt records block activation; none is silently dropped.
- Session metadata must reference an existing original transcript in its project directory. Transcript bytes are streamed and hashed without loading a whole file into memory. Headers, JSONL structure and bounded records are checked. This is not a new transcript format or a claim to revalidate every historical SDK semantic rule.
- Retained Team worktree references use the existing bounded active-branch reader, so a removed worktree or inactive branch is not treated as a new execution target. Unreadable authoritative child state and missing retained worktrees require review.
- Original sessions, Teams, command uncertainty, lifecycle records and permission files stay in place. Their relevant fingerprints join the migration manifest. Credential files, trust configuration and permission grants are never copied into the new store or backup.
- Legacy default queue slot 0 maps to primary slot 1 before the migration plan is hashed. If both exist, slot 0 drafts precede slot 1 drafts while preserving order within each. Every UUID collision (including identical copies), more than 100 merged drafts, or more than 64 MiB of UTF-8 serialized queue data including attachments blocks dry run. Other slots remain unchanged. Source and backup keep the original slot layout.
- Queued messages retain their IDs, text, images, session references, learning metadata, requested model and thinking level as drafts. Runtime composition must load them into its recovered-review path. Migration creates no native submissions or tasks capable of execution.
- In-progress task items become blocked and old verification flags are cleared. Imported goal snapshots, including archived goal views, become paused with `UNKNOWN` review notice, no pending continuation and no running executor. Their permission snapshot becomes untrusted/read-only; original snapshots remain unchanged in source and backup.
- Native import validates the exact planned session keys, content digests, counts and retained references. Each session's queue/task/goal/archive documents and import receipt commit atomically. A digest is an integrity check, not a signature or proof of historical authorship.

## Staging, activation and interruption

Backups use private directories and regular files (POSIX 0700/0600, or verified private Windows ACLs). Symlinks, hard-linked files, special files, path overlap and insufficient space are refused. Apply never changes the original source namespaces.

Import writes to a separate staging root inside the exclusively owned profile. The native storage adapter uses SQLite WAL with verified `synchronous=FULL`. After all imports and the completion ledger are verified, the store closes before the new `durable` directory is renamed into its final location. A pre-existing destination is never overwritten.

An interruption during import preserves staging and its exact plan. Reapplying that unchanged plan resumes only the document import receipts. If import finished before the external activation marker was written, the native completion verifier reads back every imported queue, task, current and archived goal, brief and event against the exact planned snapshots, rejects extra documents and executable records, and checks the same completed plan without opening repository adapters or replaying work. An existing ready seal is compared before opening staging and is never replaced on retry. The sealed namespace digest is checked again immediately before rename; changed candidates remain in staging for review. An interruption after rename is recognized from the matching plan and namespace digest.

An incomplete backup without its final verified manifest is retained and rejected. Inspect it and create a new dry-run plan instead of treating it as valid. A failed or uncertain native close retains profile and checkout ownership. It is not permission to start another owner. Real process termination can leave an owner lock requiring explicit operator recovery after all possible owners have stopped.

SQLite FULL transactions and file/directory flushes mitigate ordinary crashes. They do not defeat a hostile same-user process, failing storage hardware, all filesystem semantics or every power-loss scenario. Native Windows behavior requires its own platform evidence.

## Conservative rollback

`MigrationService.rollback(plan, matchedSourceVersion)` requires the exact source application version, the same host/profile, exclusive ownership, an unchanged original-source manifest and a verified private backup. It also requires that the activated native namespace still matches its activation digest. Any candidate writes or newer command/lifecycle evidence block automatic rollback.

Rollback moves the candidate namespace into retained migration storage for investigation and leaves the original legacy namespaces untouched. It does not overwrite any original data, remove command receipts, clear uncertainty, start an older binary or undo external effects. The operator may then select the matched older version under its own normal ownership rules. Candidate changes require a separate reconciliation/export decision rather than restoring an old database over them.

## Bounds and verification

The first migration supports up to 1,000 imported sessions, 10,000 entries per scanned namespace, 128 MiB of imported queue/task/goal source state and 16 MiB per JSONL record. Transcript files are separately streamed up to 8 GiB and two million records; imported-state limits do not impose a 128 MiB history-file limit. Exceeding a bound reports a blocker and preserves data; there is no truncation fallback.

Focused synthetic Linux tests cover real native import, archives/briefs, no native work creation, ownership conflicts, exact count/source checks, corrupt and oversized input, private backup/path refusal, interrupted staging/activation, matched-version rollback and a 900 MB unchanged original transcript. These are source-level checks, not approval to migrate a real home directory or evidence of unrun native platform and final human validation gates.
