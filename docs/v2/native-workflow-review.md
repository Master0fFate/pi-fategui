# Offline review of UNKNOWN native workflows

A native workflow may have started an external effect without recording a confirmed outcome. Fate blocks startup rather than replaying that work or inferring success. This host-local review flow can permanently retire a clearly identified historical graph while leaving its outcome **UNKNOWN**. It does not complete, cancel, reconcile, resume or repeat the old work.

Only a new explicit user request may authorize new work afterward. Acknowledgment never re-enables saved routines, automatically continues a restored goal or sends a recovered draft. Startup enforces `explicitWorkOnly`, and the workflow factory checks permanent identity retirement both before choosing a database and before lazy new storage admission. Recovered goals are projected as paused until a new accepted user prompt, a new goal, an explicit Resume, or a separately authorized direct session message establishes fresh intent for that exact runtime generation.

## Commands

Stop every relevant Fate process and other writer first. These commands acquire the same exclusive profile OwnerLock as normal startup. A lock file is not proof that its owner is stopped; no PID/heartbeat-based reclamation is performed. Use exactly one `--desktop` or `--profile NAME` on the execution host.

1. Inspect the retained evidence:

   ```sh
   fate-server workflow-review inspect --desktop
   ```

   `inspect` is the default verb. It prints bounded summaries and identity hashes, not transcript content or a plan body. It reads databases through the immutable read-only scanner, preserves every original database/sidecar byte, and creates/releases only the transient ownership lock. It does not construct a Harness, initialize a provider or start a task.

2. Prepare a private exact review plan:

   ```sh
   fate-server workflow-review prepare --desktop --out-file /private/plans/workflow-review.json
   ```

   The output parent must already be private, with no symbolic-link ancestors, and outside the profile, Pi data, ownership directories and referenced projects. Existing output is never overwritten. The plan records host/profile physical identity, application/native format/SDK versions, the full bounded workflow file inventory, digests and identified blocked graphs. It does not contain messages or credentials. Review it privately, alongside the original sessions and actual external outcomes. Preparation does not acknowledge anything.

3. If you accept that the historical outcomes remain unknown and those graph identities must never run again:

   ```sh
   fate-server workflow-review acknowledge --desktop --plan-file /private/plans/workflow-review.json --plan-digest DIGEST_FROM_PREPARE --acknowledge-unknown
   ```

   Supply the exact SHA-256 printed by `prepare`. Any change or reformatting of the private plan changes its byte digest. A plan moved into a referenced project is also rejected. The command rechecks the original inventory under the exclusive owner before appending an immutable private review record. It records `UNKNOWN` and permanent retirement, never a completion receipt.

Replace `--desktop` with `--profile NAME` for an existing server profile. JSON cannot choose another host/profile or expand these operations into a remote-path API.

## What an acknowledgment means

- The original database and all sidecars remain in their original locations, byte-for-byte. No checkpoint, writable SDK opener, migration, SQL repair, deletion or native task reconciliation is used.
- The original graph's hashed storage identity is permanently inadmissible. The admission check refuses it even if the original database is missing or a caller tries to create a fresh database with the same graph identity.
- Missing, replaced, changed or newly sidecar-bearing acknowledged evidence blocks startup and new graph admission. Removing evidence is not a recovery mechanism.
- A valid historical acknowledgment removes only that exact byte-identical graph's startup block. New unknown graphs still need separate review. Other host authorization, session, permission and lifecycle gates continue to apply.
- Acknowledged profiles remain `explicitWorkOnly`. Normal startup does not enable saved routine timers or automatically continue restored goals. Automatic child reports cannot wake a recovered root; deferred reports preserve their original no-wake intent. Starting a different explicit request does not change the historical outcome or revive an old graph.
- There is no command to undo a tombstone, mark an uncertain effect complete or retry it automatically. A new request can itself repeat real-world effects if the user asks for the same work; inspect those effects before deciding what to request.

## Diagnosis-only cases

The bounded first version refuses acknowledgment when identity is missing, ambiguous or mismatched, when metadata/SQL is malformed or unsupported, when sidecars prevent safe immutable inspection, when a file is unreadable/linked/oversized, or when the inventory exceeds its quotas. Identifiable `UNKNOWN`, active-at-shutdown, nonterminal-task and unsettled-submission histories are eligible only if the scanner's bounded committed-metadata checks pass. This is not a certification of every SDK semantic rule or external effect.

Opaque or sidecar-only history requires a separate stopped-owner forensic/export decision. This flow does not promise to recover every corrupt profile. It will not checkpoint a WAL or open it through a writable runtime merely to obtain an identity. Keep every file intact.

Review records live in the profile's separate `workflow-reviews/v1` namespace. An incomplete write, malformed receipt, duplicate tombstone, mismatched version/profile, empty retained record directory or altered evidence fails closed. A repeated identical successful acknowledgment is idempotent; a partial record is retained for explicit investigation, never overwritten on retry. An uncertain acknowledgment-writer or native database close retains profile ownership.

## Bounds and limits

The review supports at most 1,024 graph files, up to 256 MiB per database/sidecar and 1 GiB of workflow evidence, with at most 10,000 entries scanned in the native directory. Private plan/receipt files are bounded to 8 MiB, all review receipts to 32 MiB, and retired identities to 1,024. Exceeding a limit blocks rather than truncates. Native metadata inspection has additional row/revision/document limits.

Digests bind exact bytes; they are not signatures, proof of effect completion or protection against a hostile process that can replace the user's private profile. Version binding may require a separately reviewed upgrade path when the application, native format or SDK changes. User-directed destruction of both records and original evidence cannot be reconstructed from missing data.

Synthetic source tests cover immutable evidence, explicit acknowledgment, permanent same-ID refusal, missing/recreated old databases, malformed/sidecar history, partial writes, tampering, owner conflicts, private plan placement, exact digest and no provider/Harness initialization. They do not constitute real-profile execution, native Windows/macOS validation or final human acceptance. Actual-core synthetic tests additionally cover startup with acknowledged UNKNOWN, persisted active GoalMax reopening without a prompt, disabled routine timers, explicit fresh input, permanently retired IDs, and delayed child-report admission. This does not turn source coverage into native platform or human acceptance.


Fresh intent is process-local and bound to the exact live project/session generation.
A new message held during compaction remains inert until native Pi accepts it;
handled, rejected, edited, or cancelled input does not unlock recovered goals.
Direct session messages carry a process-local correlation and gain continuation
permission only when the current native session consumes that message. Delayed
messages from a disposed generation cannot grant permission to a reopened one.
A missing state database alongside retained native or review evidence blocks all
backend selections before provider or runtime construction; it is not rollback.
