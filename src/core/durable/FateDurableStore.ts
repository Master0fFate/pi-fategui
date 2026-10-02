import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSession, type Cursor, type Session, type Storage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { SessionQueuePersistence } from '../../main/pi/SessionQueueRepository';
import type { TaskPersistence } from '../../main/pi/tasks/TaskRepository';
import type { GoalMaxPersistence } from '../../main/pi/goalmaxxing/GoalMaxRepository';
import { taskListSchema, type TaskList } from '../../shared/contracts/tasks';
import { goalMaxStateSchema, type GoalMaxState, GOALMAX_BRIEF_LIMIT } from '../../shared/contracts/goalmaxxing';
import type { OwnerLock } from '../ownership/OwnerLock';
import { DurableStorageCloseUncertainError, openOwnedDurableStorage, type OwnedDurableStorage } from './OwnedDurableStorage';
import {
  StateManifest, QueueState, TaskState, GoalState, GoalArchive,
  queueDocumentSchema, taskDocumentSchema, goalDocumentSchema, manifestSchema, archiveDocumentSchema,
  importPlanSchema, identity, queueKey, durableSessionKey, archiveKey, assertIdentity, assertBytes,
  detached, jsonValue, hash, validateGoalBrief, validateBriefs, normalizedImport, durableImportDigest,
  QUEUE_MAX_BYTES, TASK_MAX_BYTES, GOAL_MAX_BYTES, GOAL_DOCUMENT_MAX_BYTES, MAX_ARCHIVES,
  type DurableSessionImport, type DurableImportPlan,
} from './StateDocuments';

export { durableSessionKey, durableImportDigest } from './StateDocuments';
export type { DurableSessionImport, DurableImportPlan } from './StateDocuments';

export interface FateDurableStoreOptions {
  readonly dataRoot: string;
  readonly profileOwner: OwnerLock;
  readonly mode?: 'normal' | 'import';
  /** Exact complete dry-run plan, produced only by the explicit migration workflow. */
  readonly importPlan?: DurableImportPlan;
}
export interface DurableTaskPersistence extends TaskPersistence {
  loadHealth(projectPath: string, sessionId: string): Promise<{ state: 'ok'; list: TaskList } | { state: 'absent' | 'invalid' }>;
}

/** Legacy files are only detected here, never read, changed, replayed, or auto-imported. */
async function hasLegacyState(root: string): Promise<boolean> {
  const pending = ['session-queues/v1', 'tasks/v1', 'goalmaxxing/v1'].map((name) => path.join(root, name));
  let visited = 0;
  while (pending.length) {
    if (++visited > 100_000) throw new Error('Legacy state inventory exceeds its bound; explicit migration is required.');
    const target = pending.pop()!;
    let stat;
    try { stat = await fs.lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error('Legacy state inventory contains an unsafe link or special file; startup is fenced.');
    if (stat.isFile()) return true;
    for (const name of await fs.readdir(target)) pending.push(path.join(target, name));
  }
  return false;
}

function validatePlan(plan: DurableImportPlan): DurableImportPlan {
  const parsed = detached(importPlanSchema.parse(plan));
  if (new Set(parsed.sessions.map((item) => item.key)).size !== parsed.sessions.length) throw new Error('Native durable import plan repeats a session.');
  parsed.sessions.sort((a, b) => a.key.localeCompare(b.key));
  return parsed;
}

function validateManifest(value: unknown) {
  const manifest = manifestSchema.parse(value);
  if (manifest.plan) {
    validatePlan(manifest.plan);
    const planned = new Map(manifest.plan.sessions.map((item) => [item.key, item.digest]));
    if (Object.entries(manifest.completed).some(([key, digest]) => planned.get(key) !== digest)
      || manifest.status === 'ready' && Object.keys(manifest.completed).length !== planned.size) {
      throw new Error('Native durable import completion metadata is corrupt; admission is fenced.');
    }
  } else if (manifest.status !== 'ready' || Object.keys(manifest.completed).length > 0) {
    throw new Error('Native durable activation metadata is corrupt; admission is fenced.');
  }
  return manifest;
}

/**
 * One profile-owned native Pi Session, with no Harness, scheduler, models, or tools.
 * Adapters keep the established Fate interfaces; all reads and writes share one
 * serialized line and expose detached, schema-checked committed state only.
 */
export class FateDurableStore {
  private readonly session: Session;
  private tail: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private ready = false;
  readonly filename: string;
  readonly diagnostics: OwnedDurableStorage['diagnostics'];

  private constructor(private readonly owned: OwnedDurableStorage) {
    this.session = createSession(owned.storage);
    this.filename = owned.filename;
    this.diagnostics = owned.diagnostics;
  }

  static async open(options: FateDurableStoreOptions): Promise<FateDurableStore> {
    const importing = options.mode === 'import';
    if (importing !== Boolean(options.importPlan)) throw new Error('Explicit import requires an exact import plan, and normal startup must not supply one.');
    const plan = options.importPlan ? validatePlan(options.importPlan) : null;
    // Refuse even before creating SQLite files on an unmigrated profile.
    if (!importing) {
      try { await fs.lstat(path.join(options.dataRoot, 'durable', 'v1', 'state.sqlite')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (await hasLegacyState(options.dataRoot)) throw new Error('Legacy Fate state requires explicit validated migration before native durable activation.');
      }
    }
    const owned = await openOwnedDurableStorage({ dataRoot: options.dataRoot, profileOwner: options.profileOwner, filename: 'state.sqlite' });
    const store = new FateDurableStore(owned);
    try {
      const current = await store.session.snapshot(StateManifest, BACKGROUND_CONTEXT);
      if (current) {
        const manifest = validateManifest(current);
        if (manifest.status === 'ready') {
          if (importing) throw new Error('Native durable state is already active; import cannot overwrite it.');
          store.ready = true;
        } else {
          if (!importing || JSON.stringify(manifest.plan) !== JSON.stringify(plan)) throw new Error('Native durable import is incomplete; resume the exact validated plan before admission.');
        }
      } else {
        const existing = await owned.storage.scanDocuments({ scope: { kind: 'session' }, at: 'current' }, 1, undefined, BACKGROUND_CONTEXT);
        if (existing.items.length > 0) throw new Error('Native durable activation metadata is missing; existing state is preserved.');
        if (!importing && await hasLegacyState(options.dataRoot)) throw new Error('Legacy Fate state requires explicit validated migration before native durable activation.');
        await store.session.commit(async (tx) => {
          const manifest = await tx.doc(StateManifest);
          manifest.status = importing ? 'importing' : 'ready';
          manifest.plan = plan;
        }, BACKGROUND_CONTEXT);
        store.ready = !importing;
      }
      return store;
    } catch (error) {
      try { await store.close(); }
      catch (closeError) { throw new DurableStorageCloseUncertainError([error, closeError], 'Native durable startup failed and close is uncertain; retain profile ownership.'); }
      throw error;
    }
  }

  /** Seals synchronously, drains admitted work, checkpoints and closes SQLite. */
  close(): Promise<void> {
    return this.closing ??= this.tail.then(() => this.session.close(BACKGROUND_CONTEXT));
  }

  createQueue(instanceSlot = 1): SessionQueuePersistence {
    if (!Number.isSafeInteger(instanceSlot) || instanceSlot < 0) throw new Error('A nonnegative durable queue instance slot is required.');
    return {
      load: (projectPath, sessionId) => this.run(async () => {
        const expected = identity(projectPath.normalize('NFC'), sessionId);
        const document = await this.session.snapshot(QueueState, queueKey(projectPath, sessionId, instanceSlot), BACKGROUND_CONTEXT);
        if (!document) return [];
        const parsed = queueDocumentSchema.parse(document);
        assertIdentity(parsed, expected);
        if (parsed.instanceSlot !== instanceSlot) throw new Error('Native durable queue belongs to another instance.');
        assertBytes(parsed, QUEUE_MAX_BYTES, 'Saved message queue');
        return detached(parsed.messages);
      }),
      save: (projectPath, sessionId, messages) => {
        const expected = identity(projectPath.normalize('NFC'), sessionId);
        const next = detached(queueDocumentSchema.parse({ ...expected, schemaVersion: 1, instanceSlot, messages }));
        assertBytes(next, QUEUE_MAX_BYTES, 'Saved message queue');
        return this.run(() => this.session.commit(async (tx) => {
          const document = await tx.doc(QueueState, queueKey(projectPath, sessionId, instanceSlot), { ...expected, instanceSlot });
          const previous = queueDocumentSchema.parse(document);
          assertIdentity(previous, expected);
          if (previous.instanceSlot !== instanceSlot) throw new Error('Native durable queue belongs to another instance.');
          assertBytes(previous, QUEUE_MAX_BYTES, 'Saved message queue');
          document.messages = jsonValue(next.messages);
        }, BACKGROUND_CONTEXT));
      },
      deleteSession: (projectPath, sessionId) => this.run(() => this.session.commit((tx) => tx.retireDoc(QueueState, queueKey(projectPath, sessionId, instanceSlot)), BACKGROUND_CONTEXT)),
    };
  }

  createTasks(): DurableTaskPersistence {
    const load = (projectPath: string, sessionId: string): Promise<TaskList | null> => this.run(async () => {
      const expected = identity(projectPath, sessionId);
      const document = await this.session.snapshot(TaskState, durableSessionKey(projectPath, sessionId), BACKGROUND_CONTEXT);
      if (!document) return null;
      const parsed = taskDocumentSchema.parse(document);
      assertIdentity(parsed, expected);
      if (parsed.state) { assertIdentity(parsed.state, expected); assertBytes(parsed.state, TASK_MAX_BYTES, 'Saved task list'); }
      return detached(parsed.state);
    });
    return {
      load,
      loadHealth: async (projectPath, sessionId) => {
        try { const list = await load(projectPath, sessionId); return list ? { state: 'ok', list } : { state: 'absent' }; }
        catch { return { state: 'invalid' }; }
      },
      save: (state, expectedRevision) => {
        const next = detached(taskListSchema.parse(state));
        assertBytes(next, TASK_MAX_BYTES, 'Saved task list');
        const expected = identity(next.projectPath, next.sessionId);
        return this.run(() => this.session.commit(async (tx) => {
          const document = await tx.doc(TaskState, durableSessionKey(next.projectPath, next.sessionId), expected);
          const previous = taskDocumentSchema.parse(document);
          assertIdentity(previous, expected);
          if (previous.state) { assertIdentity(previous.state, expected); assertBytes(previous.state, TASK_MAX_BYTES, 'Saved task list'); }
          if ((previous.state?.revision ?? null) !== expectedRevision) throw new Error('The task list changed before this mutation could commit.');
          if (next.revision !== (expectedRevision ?? 0) + 1) throw new Error('Task list revisions must advance by exactly one.');
          document.state = jsonValue(next);
        }, BACKGROUND_CONTEXT));
      },
      deleteSession: (projectPath, sessionId) => this.run(() => this.session.commit((tx) => tx.retireDoc(TaskState, durableSessionKey(projectPath, sessionId)), BACKGROUND_CONTEXT)),
    };
  }

  createGoals(): GoalMaxPersistence {
    return {
      load: (projectPath, sessionId) => this.run(async () => {
        const expected = identity(projectPath, sessionId);
        const document = await this.session.snapshot(GoalState, durableSessionKey(projectPath, sessionId), BACKGROUND_CONTEXT);
        if (!document) return null;
        const parsed = this.validateGoalDocument(document, expected);
        return detached(parsed.state);
      }),
      save: (state, expectedRevision) => {
        const next = detached(goalMaxStateSchema.parse(state));
        assertBytes(next, GOAL_MAX_BYTES, 'GoalMax snapshot');
        const expected = identity(next.projectPath, next.sessionId);
        return this.run(() => this.session.commit(async (tx) => {
          const document = await tx.doc(GoalState, durableSessionKey(next.projectPath, next.sessionId), expected);
          const previous = this.validateGoalDocument(document, expected);
          if ((previous.state?.revision ?? null) !== expectedRevision) throw new Error('GoalMax snapshot changed before this mutation could commit.');
          if (next.revision !== (expectedRevision ?? 0) + 1) throw new Error('GoalMax snapshots must advance by exactly one revision.');
          validateGoalBrief(next, previous.briefs);
          document.state = jsonValue(next);
          document.events = jsonValue([...previous.events, { goalId: next.id, revision: next.revision, status: next.status, phase: next.phase, timestamp: next.updatedAt }].slice(-1000));
          assertBytes(document, GOAL_DOCUMENT_MAX_BYTES, 'Saved goal document');
        }, BACKGROUND_CONTEXT));
      },
      saveBrief: (projectPath, sessionId, goalId, brief) => {
        if (!goalId || goalId.length > 160 || brief.length > GOALMAX_BRIEF_LIMIT) return Promise.reject(new Error('GoalMax source brief exceeds its size limit.'));
        const digest = hash(brief);
        const ref = `brief-${hash(goalId).slice(0, 16)}-${digest.slice(0, 16)}.txt`;
        validateBriefs({ [ref]: brief });
        const expected = identity(projectPath, sessionId);
        return this.run(async () => {
          await this.session.commit(async (tx) => {
            const document = await tx.doc(GoalState, durableSessionKey(projectPath, sessionId), expected);
            this.validateGoalDocument(document, expected);
            document.briefs[ref] = brief;
            assertBytes(document, GOAL_DOCUMENT_MAX_BYTES, 'Saved goal document');
          }, BACKGROUND_CONTEXT);
          return { ref, hash: digest };
        });
      },
      archiveAndClear: (state) => {
        const next = detached(goalMaxStateSchema.parse(state));
        const expected = identity(next.projectPath, next.sessionId);
        return this.run(() => this.session.commit(async (tx) => {
          const document = await tx.doc(GoalState, durableSessionKey(next.projectPath, next.sessionId), expected);
          const previous = this.validateGoalDocument(document, expected);
          if (!previous.state || previous.state.id !== next.id || previous.state.revision !== next.revision) throw new Error('GoalMax snapshot changed before it could be cleared.');
          if (previous.archives.length >= MAX_ARCHIVES) throw new Error('GoalMax archive limit reached; previous committed state is preserved.');
          const key = archiveKey(next.projectPath, next.sessionId, next.id, next.revision);
          if (previous.archives.includes(key)) throw new Error('Native durable goal archive identity is already retained; current state is preserved.');
          const archive = await tx.doc(GoalArchive, key, { ...expected, schemaVersion: 1, state: jsonValue(previous.state), briefs: detached(previous.briefs) });
          const parsed = archiveDocumentSchema.parse(archive);
          if (JSON.stringify(parsed.state) !== JSON.stringify(previous.state)) throw new Error('Native durable goal archive identity already exists with different content.');
          document.archives = [...previous.archives, key];
          document.state = null;
          document.briefs = {};
          document.events = jsonValue([...previous.events, { goalId: next.id, revision: next.revision, status: 'cleared', timestamp: Date.now() }].slice(-1000));
        }, BACKGROUND_CONTEXT));
      },
      deleteSession: (projectPath, sessionId) => this.run(() => this.session.commit(async (tx) => {
        const expected = identity(projectPath, sessionId);
        const key = durableSessionKey(projectPath, sessionId);
        const document = await tx.doc(GoalState, key, expected);
        const parsed = this.validateGoalDocument(document, expected);
        for (const archive of parsed.archives) await tx.retireDoc(GoalArchive, archive);
        await tx.retireDoc(GoalState, key);
      }, BACKGROUND_CONTEXT)),
    };
  }

  /** Explicit migration seam; persists exact state and historical archives without executing it. */
  importSessionSnapshot(requestId: string, snapshot: DurableSessionImport): Promise<'imported' | 'already-imported'> {
    const parsed = normalizedImport(snapshot);
    const digest = durableImportDigest(parsed);
    const key = durableSessionKey(parsed.projectPath, parsed.sessionId);
    const expected = identity(parsed.projectPath, parsed.sessionId);
    return this.run(async () => {
      const existingManifest = validateManifest(await this.session.snapshot(StateManifest, BACKGROUND_CONTEXT));
      if (existingManifest.status !== 'importing' || existingManifest.plan?.requestId !== requestId) throw new Error('Native durable import request does not own the pending import.');
      if (existingManifest.plan.sessions.find((item) => item.key === key)?.digest !== digest) throw new Error('Imported session does not match its complete validated plan.');
      if (existingManifest.completed[key]) {
        if (existingManifest.completed[key] !== digest) throw new Error('Native durable imported session digest changed.');
        await verifyImportedPayloads(this.session, this.owned.storage,
          { ...existingManifest.plan, sessions: [{ key, digest }] }, { [key]: digest }, [parsed], false);
        return 'already-imported';
      }
      // The ledger and every imported document commit together. Existing payload
      // without its ledger means corruption or an identity collision, never a
      // reason to silently overwrite previously retained native data.
      if (await this.session.snapshot(TaskState, key, BACKGROUND_CONTEXT)
        || await this.session.snapshot(GoalState, key, BACKGROUND_CONTEXT)) throw new Error('Native durable import found unaccounted existing session state.');
      for (const queue of parsed.queues) {
        if (await this.session.snapshot(QueueState, queueKey(parsed.projectPath, parsed.sessionId, queue.instanceSlot), BACKGROUND_CONTEXT)) throw new Error('Native durable import found an existing queue identity.');
      }
      for (const archive of parsed.archives) {
        if (await this.session.snapshot(GoalArchive, archiveKey(parsed.projectPath, parsed.sessionId, archive.state.id, archive.state.revision), BACKGROUND_CONTEXT)) throw new Error('Native durable import found an existing archive identity.');
      }
      return this.session.commit(async (tx) => {
        const manifest = await tx.doc(StateManifest);
        const metadata = validateManifest(manifest);
        if (metadata.status !== 'importing' || metadata.plan?.requestId !== requestId) throw new Error('Native durable import request does not own the pending import.');
        if (metadata.plan.sessions.find((item) => item.key === key)?.digest !== digest) throw new Error('Imported session does not match its complete validated plan.');
        if (metadata.completed[key]) {
          if (metadata.completed[key] !== digest) throw new Error('Native durable imported session digest changed.');
          return 'already-imported';
        }
        for (const queue of parsed.queues) {
          const queueIdentity = identity(parsed.projectPath.normalize('NFC'), parsed.sessionId);
          const document = await tx.doc(QueueState, queueKey(parsed.projectPath, parsed.sessionId, queue.instanceSlot), { ...queueIdentity, instanceSlot: queue.instanceSlot });
          document.messages = jsonValue(queue.messages);
        }
        const tasks = await tx.doc(TaskState, key, expected);
        tasks.state = detached(parsed.tasks);
        const goal = await tx.doc(GoalState, key, expected);
        goal.state = jsonValue(parsed.goal);
        goal.briefs = detached(parsed.briefs);
        goal.events = jsonValue(parsed.goalEvents ?? []);
        for (const archive of parsed.archives) {
          const archiveId = archiveKey(parsed.projectPath, parsed.sessionId, archive.state.id, archive.state.revision);
          await tx.doc(GoalArchive, archiveId, { ...expected, schemaVersion: 1, state: jsonValue(archive.state), briefs: detached(archive.briefs) });
          goal.archives.push(archiveId);
        }
        assertBytes(goal, GOAL_DOCUMENT_MAX_BYTES, 'Imported goal document');
        manifest.completed[key] = digest;
        return 'imported';
      }, BACKGROUND_CONTEXT);
    }, true);
  }

  finishImport(expected: { requestId: string; sourceDigest: string; expectedSessions: number }): Promise<void> {
    return this.run(async () => {
      await this.session.commit(async (tx) => {
        const manifest = await tx.doc(StateManifest);
        const parsed = validateManifest(manifest);
        const plan = parsed.plan;
        if (!plan || plan.requestId !== expected.requestId || plan.sourceDigest !== expected.sourceDigest
          || plan.sessions.length !== expected.expectedSessions || Object.keys(parsed.completed).length !== expected.expectedSessions
          || plan.sessions.some((item) => parsed.completed[item.key] !== item.digest)) throw new Error('Native durable import is incomplete or its source manifest changed.');
        manifest.status = 'ready';
      }, BACKGROUND_CONTEXT);
      this.ready = true;
    }, true);
  }

  private validateGoalDocument(document: unknown, expected: ReturnType<typeof identity>) {
    const parsed = goalDocumentSchema.parse(document);
    assertIdentity(parsed, expected);
    if (parsed.state) { assertIdentity(parsed.state, expected); assertBytes(parsed.state, GOAL_MAX_BYTES, 'Saved GoalMax snapshot'); }
    validateGoalBrief(parsed.state, parsed.briefs);
    if (new Set(parsed.archives).size !== parsed.archives.length) throw new Error('Native durable goal archive index is invalid.');
    assertBytes(parsed, GOAL_DOCUMENT_MAX_BYTES, 'Saved goal document');
    return parsed;
  }

  private run<T>(operation: () => Promise<T>, importing = false): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Native durable state is closed.'));
    const result = this.tail.then(async () => {
      await this.owned.assertOwnership();
      if (!this.ready && !importing) throw new Error('Native durable import must finish before repository admission.');
      return operation();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function openFateDurableStore(options: FateDurableStoreOptions): Promise<FateDurableStore> { return FateDurableStore.open(options); }

/** Compare native payloads, not merely the import ledger that claims they committed. */
async function verifyImportedPayloads(session: Session, storage: Storage, plan: DurableImportPlan,
  completed: Readonly<Record<string, string>>, snapshots: readonly DurableSessionImport[], checkInventory = true): Promise<void> {
  const expectedByKey = new Map<string, DurableSessionImport>();
  const planByKey = new Map(plan.sessions.map((entry) => [entry.key, entry.digest]));
  for (const input of snapshots) {
    const snapshot = normalizedImport(input);
    const key = durableSessionKey(snapshot.projectPath, snapshot.sessionId);
    if (expectedByKey.has(key) || planByKey.get(key) !== durableImportDigest(snapshot)) throw new Error('Native durable verification snapshots do not match the validated source digest plan.');
    expectedByKey.set(key, snapshot);
  }
  if (expectedByKey.size !== planByKey.size) throw new Error('Native durable verification requires the complete validated source snapshot set.');
  const expectedDocuments = new Set([`${StateManifest.definition.kind}\0`]);
  for (const [key, digest] of Object.entries(completed)) {
    const expected = expectedByKey.get(key);
    if (!expected || planByKey.get(key) !== digest) throw new Error('Native durable verification found an unplanned completion.');
    const scope = identity(expected.projectPath, expected.sessionId);
    const tasks = taskDocumentSchema.parse(await session.snapshot(TaskState, key, BACKGROUND_CONTEXT));
    const goal = goalDocumentSchema.parse(await session.snapshot(GoalState, key, BACKGROUND_CONTEXT));
    assertIdentity(tasks, scope); assertIdentity(goal, scope);
    expectedDocuments.add(`${TaskState.definition.kind}\0${key}`);
    expectedDocuments.add(`${GoalState.definition.kind}\0${key}`);
    const queues: DurableSessionImport['queues'] = [];
    for (const expectedQueue of expected.queues) {
      const address = queueKey(expected.projectPath, expected.sessionId, expectedQueue.instanceSlot);
      const queue = queueDocumentSchema.parse(await session.snapshot(QueueState, address, BACKGROUND_CONTEXT));
      assertIdentity(queue, identity(expected.projectPath.normalize('NFC'), expected.sessionId));
      if (queue.instanceSlot !== expectedQueue.instanceSlot) throw new Error('Native durable queue identity changed after import.');
      queues.push({ instanceSlot: queue.instanceSlot, messages: queue.messages });
      expectedDocuments.add(`${QueueState.definition.kind}\0${address}`);
    }
    const expectedArchives = expected.archives.map((archive) => archiveKey(expected.projectPath, expected.sessionId, archive.state.id, archive.state.revision));
    if (JSON.stringify(goal.archives) !== JSON.stringify(expectedArchives)) throw new Error('Native durable archive inventory changed after import.');
    const archives: DurableSessionImport['archives'] = [];
    for (const address of goal.archives) {
      const archive = archiveDocumentSchema.parse(await session.snapshot(GoalArchive, address, BACKGROUND_CONTEXT));
      assertIdentity(archive, scope);
      archives.push({ state: archive.state, briefs: archive.briefs });
      expectedDocuments.add(`${GoalArchive.definition.kind}\0${address}`);
    }
    if (expected.goalEvents === undefined && goal.events.length > 0) throw new Error('Native durable audit payload changed after import.');
    const actual: DurableSessionImport = { ...scope, queues, tasks: tasks.state, goal: goal.state, briefs: goal.briefs, archives,
      ...(expected.goalEvents === undefined ? {} : { goalEvents: goal.events }) };
    if (durableImportDigest(actual) !== digest) throw new Error('Native durable imported payload digest mismatch; staging is preserved.');
  }
  if (!checkInventory) return;
  let cursor: Cursor | undefined;
  const seen = new Set<string>();
  do {
    const page = await storage.scanDocuments({ scope: { kind: 'session' }, at: 'current' }, 128, cursor, BACKGROUND_CONTEXT);
    for (const document of page.items) {
      const address = `${document.kind}\0${document.key ?? ''}`;
      if (!expectedDocuments.has(address) || seen.has(address)) throw new Error('Native durable imported document inventory has changed or contains unaccounted state.');
      seen.add(address);
    }
    cursor = page.next;
  } while (cursor);
  if (seen.size !== expectedDocuments.size) throw new Error('Native durable imported document inventory is incomplete.');
  if ((await storage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).items.length
    || (await storage.scanTasks({}, 1, undefined, BACKGROUND_CONTEXT)).items.length
    || (await storage.scanSubmissions({}, 1, undefined, BACKGROUND_CONTEXT)).items.length) {
    throw new Error('Native durable imported state unexpectedly contains executable records.');
  }
}

/**
 * Read-only recovery seam for a migration interrupted after finishImport but before
 * its external activation marker. The orchestrator must still verify its staging
 * location and source/backup manifest. This never reopens import mutation admission.
 */
export async function verifyCompletedDurableImport(options: {
  readonly dataRoot: string;
  readonly profileOwner: OwnerLock;
  readonly importPlan: DurableImportPlan;
  /** Re-read and validated by the migration owner against the original source manifest. */
  readonly snapshots: readonly DurableSessionImport[];
}): Promise<boolean> {
  const expected = validatePlan(options.importPlan);
  await fs.lstat(path.join(options.dataRoot, 'durable', 'v1', 'state.sqlite'));
  const owned = await openOwnedDurableStorage({ dataRoot: options.dataRoot, profileOwner: options.profileOwner, filename: 'state.sqlite' });
  const session = createSession(owned.storage);
  let verificationFailure: { error: unknown } | undefined;
  try {
    const manifest = validateManifest(await session.snapshot(StateManifest, BACKGROUND_CONTEXT));
    if (JSON.stringify(manifest.plan) !== JSON.stringify(expected)) {
      throw new Error('Completed native durable import does not match the exact validated plan.');
    }
    await verifyImportedPayloads(session, owned.storage, expected, manifest.completed, options.snapshots);
    // False has one meaning only: a valid matching incomplete import. Corruption,
    // ownership loss, mismatched plans and close failures always reject.
    return manifest.status === 'ready';
  } catch (error) {
    verificationFailure = { error };
    throw error;
  } finally {
    try { await session.close(BACKGROUND_CONTEXT); }
    catch (closeError) {
      throw new DurableStorageCloseUncertainError([...(verificationFailure ? [verificationFailure.error] : []), closeError], 'Native durable import verification close is uncertain; retain profile ownership.');
    }
  }
}
