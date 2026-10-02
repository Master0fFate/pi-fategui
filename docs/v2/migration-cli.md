# Host-local native state migration commands

The Node companion exposes explicit offline conversion of Fate queue, task and GoalMax state. Original Pi JSONL sessions, Teams, worktrees and archived transcripts remain in place. No credentials, trust grants or full-access authority are imported. No agent, provider, task scheduler, listener or tool is started by these commands.

Use the companion on the execution host. Select exactly one `--desktop` or `--profile NAME`. Desktop paths come from the ordinary process-start Fate/Pi configuration; a server profile must already have a valid private host descriptor. JSON in a plan cannot select a different profile, data directory or backup directory.

## Prepare and review

1. Stop the relevant Fate owners, Pi Terminal, older Fate versions and any other writers. Do not remove a lock because its PID or heartbeat looks stale. The commands cannot prove that non-cooperating external programs are stopped.
2. Choose existing private backup and plan-output directories outside the source/profile, Pi directory, ownership directories and projects. Use normalized absolute paths. They must have private permissions; the CLI will not relax permissions or make unsafe parents private on your behalf.
3. Preview without changing files:

   ```sh
   fate-server migrate --desktop --backup-root /private/backups --source-version 1.1.0
   ```

   `dry-run` is the default verb. It emits one JSON summary containing eligibility, counts, space requirements, a source digest, fixed blocker categories and notices. It never writes a plan, creates a backup, takes an owner lock or activates native state. An ineligible preview exits unsuccessfully.

4. Explicitly save the exact private plan:

   ```sh
   fate-server migrate prepare --desktop --backup-root /private/backups --source-version 1.1.0 --out-file /private/plans/native-plan.json
   ```

   `prepare` repeats the observational checks, then exports one new private plan file. It does not start migration. An existing output is never overwritten. The file contains host/profile identities, paths, metadata and digests, but no transcript, draft content or credentials. Keep it private. The console prints only a summary and its exact `planDigest` SHA-256; it does not print the plan body.

5. Review the saved plan and summary. Apply requires explicit intent and the exact digest printed by `prepare`:

   ```sh
   fate-server migrate apply --desktop --backup-root /private/backups --source-version 1.1.0 --plan-file /private/plans/native-plan.json --plan-digest DIGEST_FROM_PREPARE --confirm-apply
   ```

   Replace the example version with the source application's actual version. For a server, replace `--desktop` with `--profile NAME` in every command. All paths, source version and the selected profile are revalidated; editing or reformatting the plan changes its byte digest. A digest is an integrity binding, not an authentication signature.

Apply uses the same cooperating profile and checkout locks as the host, rechecks source identities under ownership, creates a verified private backup, imports to staging, verifies every actual imported document and its references, seals the candidate and activates it with a directory rename. It never overwrites legacy namespaces. Details, bounds and interruption behavior are in [migration.md](migration.md).

Legacy queue slot 0 becomes primary slot 1. Existing slot 1 drafts follow slot 0 drafts, preserving order within each. Any UUID collision, more than 100 combined drafts or more than 64 MiB including attachments blocks migration; other instance slots remain unchanged. Draft images, references, learning metadata, model and thinking selections survive as review-only drafts. Old running work becomes blocked/paused with explicit uncertainty rather than resuming.

## Restart and recovery

After successful activation, ordinary desktop/server startup selects the existing verified native namespace under ownership. No second environment flag or hidden activation script is needed. A corrupt or incompatible native namespace fails startup; it is never an excuse to fall back to old legacy state. Review recovered drafts and historical work before authorizing new execution.

For an interruption, retain the original plan, backup and staging. Reapplying the same exact plan resumes only verified document import, without replaying prompts or effects. Modified sealed candidates, changed source data and incomplete backups are refused. Uncertain shutdown keeps ownership records; do not force another owner to start. An operator must resolve stale ownership through the separately reviewed owner-recovery procedure.

The plan envelope binds `fate-durable-state/v1`, the pinned native SDK version and the candidate package version, in addition to the exact migration plan. During unreleased development, the candidate and previous binary may report the same application version. That equality does not prove binary compatibility or authorize an arbitrary older executable to read native state.

## Conservative rollback

```sh
fate-server migrate rollback --desktop --backup-root /private/backups --source-version 1.1.0 --plan-file /private/plans/native-plan.json --plan-digest DIGEST_FROM_PREPARE --confirm-rollback
```

Rollback requires the declared original source version, same exact plan and profile, exclusive ownership, unchanged original sources, verified backup and a byte-identical activated candidate. It retains the candidate under migration storage and exposes the untouched legacy namespaces. It does not restore over a live runtime, launch an old binary, restore credentials or undo external effects.

Candidate changes block this automatic rollback. Even a diagnostic SQLite connection can create sidecar files and change the sealed namespace. Preserve changed candidates for explicit reconciliation rather than removing files to make the digest match. Selecting a genuinely compatible original binary remains a separate operator responsibility.

## Validation limits

Synthetic tests invoke the actual Node CLI entry, strict parser and native SQLite migration using disposable desktop and server profiles with outbound network and Electron blocked. They cover private plan export, exact digest/profile/format/path binding, active owners, changed sources, activation and conservative rollback. These are source-level Linux checks. They do not constitute real-user-data migration, native Windows/macOS validation, packaging/installation evidence or final human acceptance.
