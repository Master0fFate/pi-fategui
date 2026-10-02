# Native durable state boundary

`openFateDurableStore` owns one native Pi Durable 1.0.0 `Session` over one SQLite
database at `<dataRoot>/durable/v1/state.sqlite`. `createQueue(instanceSlot)`,
`createTasks()` (including recovery `loadHealth`), and `createGoals()` implement
the existing Fate persistence contracts. Use this same store for the runtime
and cold recovery. It never constructs a Harness, runs a model, or resumes work.

The host must first acquire its existing profile `OwnerLock`, keep it throughout
the store lifetime, stop runtime/recovery admissions, close the store, and only
then release ownership. Borrowed ownership is checked at open and each operation;
there is no alternate lock acquisition or stale-owner takeover. Duplicate
in-process opens are rejected. A close failure must retain the profile owner.

## Commit and recovery contract

- Uses public `NodeSqliteDatabase` and `SqliteStorage` adapters. WAL and
  `synchronous=FULL` are explicitly set and queried on the active connection.
  The upstream convenience opener's NORMAL mode is intentionally not used.
- Requires a working `node:sqlite` runtime. Missing capability, unsafe paths,
  unsupported SQLite/document schema, corrupt state, invalid identity, and
  uncertain storage outcomes fail closed. There is no JSONL fallback.
- Allocation metadata must exceed all persisted IDs and revision/entry/document
  lifecycle sequence numbers. Positive but regressed counters reject before
  admission; the database is preserved rather than reset.
- Typed `fate.state.*` document families store queues, task lists, goals, source
  briefs, audit events and goal archives. Revisions use compare-and-swap inside
  the native commit. Current-only documents checkpoint each write, avoiding an
  unbounded revision history for mutable state.
- Every operation uses the same ordered admission line. Only detached,
  validated committed values are returned. Failed commits do not publish dirty
  drafts. An uncertain commit poisons the native Session until close/reopen;
  the existing database must be retained, not retried or deleted automatically.
- Queue delivery uncertainty and goal continuation state are preserved as data.
  They never become native runnable Task/Submission records. Application recovery
  retains responsibility for explicit review; opening storage is not permission
  to replay a draft, tool effect, model request, or interrupted run.
- Bounds: queue 100 items/64 MiB; tasks 1 MiB; individual goal snapshots 4 MiB;
  source briefs 200,000 characters/800,000 bytes; current goal document including
  all live briefs, 1,000 audit records and archive index 32 MiB; 10,000 archives
  per session. An explicit import is at most 256 MiB per session. Exceeding a bound
  rejects the write and preserves previous state; archives are never truncated.

FULL is SQLite's filesystem durability contract. It cannot compensate for a
filesystem/device that lies about synchronization. The process-termination tests
exercise actual WAL recovery; they are not physical power-loss hardware tests.
Windows/macOS/Electron compatibility still requires their platform matrix.

## Explicit migration and backup

Normal startup refuses an unactivated namespace when legacy queue/task/goal
files exist. Empty directories are safe; links and special files are rejected.
Legacy files are never modified or implicitly imported. Once the ready marker
exists, preserved legacy files do not trigger another import.

The host migration workflow must inventory and validate the complete source,
make and verify a private backup, and supply `DurableImportPlan` with a source
manifest digest and the exact session key/content digest set. Open a **staging**
data root with `mode: 'import'` and that plan, call `importSessionSnapshot` for
each planned session, and `finishImport` with the exact request ID, source digest,
and expected count. Imports preserve current state, queues by instance slot,
briefs, and archived goals in atomic native commits. Retrying the same imported
session is idempotent; changing its data or source plan is rejected.

Until the complete planned set is committed, all ordinary repository access is
fenced. An interrupted import can only resume under the exact original plan.
For a crash after `finishImport` but before the external activation marker,
`verifyCompletedDurableImport` verifies the completed manifest read-only without
reopening mutation admission. It also requires the complete revalidated source
`snapshots`, reads back each completed queue/task/goal/brief/archive/audit payload,
recomputes its planned digest, and checks the exact active session-scoped document
inventory. Pending imports receive the same completed-payload checks. This is not
an exhaustive inventory of retired or nonexistent-owner scoped physical records.
The orchestrator still owns staging-path, immutable ready-digest, source, backup,
activation and rollback checks.

For a portable backup, stop admissions and close the store before copying the
database. Never copy only the main `.sqlite` file while its WAL is live. After an
uncertain close or crash, preserve the complete database directory including
`-wal`/`-shm` and the ownership evidence for explicit recovery. No in-place
schema downgrade, destructive reset, history migration, or credential import is
performed by this module.

`openOwnedDurableStorage` exposes the same backend boundary for a separately
owned native execution database. Each filename must have exactly one Session or
Harness; an execution adapter must additionally enforce its own admission fence,
effect uncertainty review, and close state before accessing cached data/effects.
