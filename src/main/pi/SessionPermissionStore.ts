import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { permissionLevelSchema, type PermissionLevel } from '../../shared/contracts/ipc';
import type { AppLogService } from '../logging/AppLogService';

const MAX_ENTRIES = 5_000;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_INTENT_BYTES = 4 * 1024;
const MAX_SESSION_ID_CHARACTERS = 500;
const intentSchema = z.object({
  version: z.literal(1),
  transactionId: z.string().uuid(),
  createdAt: z.number().int().nonnegative(),
  stateSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
type PermissionWriteIntent = z.infer<typeof intentSchema>;

const entrySchema = z.object({
  level: permissionLevelSchema,
  updatedAt: z.number().int().nonnegative(),
});

const stateSchema = z.object({
  version: z.literal(1),
  permissions: z.record(entrySchema),
});

type PermissionEntry = z.infer<typeof entrySchema>;

export class SessionPermissionStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionPermissionStorageError';
  }
}

export interface SessionPermissionPersistence {
  /** Undefined means a genuinely missing grant. Unhealthy storage MUST reject. */
  get(projectPath: string, sessionId: string): Promise<PermissionLevel | undefined>;
  set(projectPath: string, sessionId: string, level: PermissionLevel): Promise<void>;
  delete(projectPath: string, sessionId: string): Promise<void>;
  /** Load all durable grant state before declaring a server profile ready. */
  checkHealth(): Promise<void>;
  /** Synchronous, sticky failure fence shared by all runtimes using this store. */
  assertHealthy(): void;
  onFailure(listener: (error: SessionPermissionStorageError) => void): () => void;
}

function permissionKey(projectPath: string, sessionId: string): string {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId || normalizedSessionId.length > MAX_SESSION_ID_CHARACTERS || normalizedSessionId.includes('\0')) {
    throw new Error('A valid Pi session ID is required to store its permission level.');
  }
  const normalizedProject = path.normalize(path.resolve(projectPath));
  const platformProject = process.platform === 'win32' ? normalizedProject.toLocaleLowerCase() : normalizedProject;
  return `${createHash('sha256').update(platformProject).digest('hex')}:${normalizedSessionId}`;
}

export class InMemorySessionPermissionStore implements SessionPermissionPersistence {
  private readonly entries = new Map<string, PermissionLevel>();

  async get(projectPath: string, sessionId: string): Promise<PermissionLevel | undefined> {
    return this.entries.get(permissionKey(projectPath, sessionId));
  }

  async set(projectPath: string, sessionId: string, level: PermissionLevel): Promise<void> {
    this.entries.set(permissionKey(projectPath, sessionId), level);
  }

  async delete(projectPath: string, sessionId: string): Promise<void> {
    this.entries.delete(permissionKey(projectPath, sessionId));
  }

  async checkHealth(): Promise<void> {}
  assertHealthy(): void {}
  onFailure(_listener: (error: SessionPermissionStorageError) => void): () => void { return () => undefined; }
}

/** Host-owned permission metadata. Session JSONL content can never grant itself access. */
export class SessionPermissionStore implements SessionPermissionPersistence {
  private entries = new Map<string, PermissionEntry>();
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private storageError: SessionPermissionStorageError | null = null;
  private readonly failureListeners = new Set<(error: SessionPermissionStorageError) => void>();

  constructor(
    private readonly logs: AppLogService,
    private readonly dataRoot = process.env.FATE_GUI_DATA_DIR
      ? path.resolve(process.env.FATE_GUI_DATA_DIR)
      : path.join(os.homedir(), '.pi', 'fateGUI'),
  ) {}

  assertHealthy(): void {
    if (this.storageError) throw this.storageError;
  }

  onFailure(listener: (error: SessionPermissionStorageError) => void): () => void {
    this.failureListeners.add(listener);
    if (this.storageError) {
      try { listener(this.storageError); } catch { /* A broken observer cannot clear the stored failure. */ }
    }
    return () => { this.failureListeners.delete(listener); };
  }

  /** Startup preflight: load the entire store and reject an unfinished write intent
   * without inventing a session grant or mutating permission state. */
  async checkHealth(): Promise<void> {
    await this.writeQueue;
    try {
      this.assertHealthy();
      await this.load();
      await this.assertNoIntent();
    } catch (error) { throw this.failStorage(error); }
  }

  async get(projectPath: string, sessionId: string): Promise<PermissionLevel | undefined> {
    await this.writeQueue;
    try {
      this.assertHealthy();
      await this.load();
      await this.assertNoIntent();
      return this.entries.get(permissionKey(projectPath, sessionId))?.level;
    } catch (error) { throw this.failStorage(error); }
  }

  set(projectPath: string, sessionId: string, level: PermissionLevel): Promise<void> {
    const key = permissionKey(projectPath, sessionId);
    return this.enqueue(async () => {
      const next = new Map(this.entries);
      next.set(key, { level, updatedAt: Date.now() });
      this.assertCapacity(next);
      await this.persist(next);
      this.entries = next;
    });
  }

  delete(projectPath: string, sessionId: string): Promise<void> {
    const key = permissionKey(projectPath, sessionId);
    return this.enqueue(async () => {
      if (!this.entries.has(key)) return;
      const next = new Map(this.entries);
      next.delete(key);
      await this.persist(next);
      this.entries = next;
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.writeQueue.then(async () => {
      try {
        // A failed transaction is never silently retried, even by this instance.
        // Operator recovery must inspect the grant AND intent while Fate is stopped.
        if (this.storageError) throw this.storageError;
        await this.load();
        await this.assertNoIntent();
        await operation();
      } catch (error) { throw this.failStorage(error); }
    });
    this.writeQueue = queued.catch(() => undefined);
    return queued;
  }

  private failStorage(error: unknown): SessionPermissionStorageError {
    if (this.storageError) return this.storageError;
    this.storageError = error instanceof SessionPermissionStorageError ? error : new SessionPermissionStorageError('Session permission storage failed. Execution is blocked. Stop Fate UI, inspect and repair the permission grant and write-intent files, then restart; no automatic retry is permitted.', { cause: error });
    for (const listener of [...this.failureListeners]) {
      try { listener(this.storageError); } catch { /* One failed observer cannot prevent other owners from being fenced. */ }
    }
    return this.storageError;
  }

  private load(): Promise<void> {
    this.loadPromise ??= this.readState();
    return this.loadPromise;
  }

  private async readState(): Promise<void> {
    try {
      await this.assertNoIntent();
      const target = this.filePath();
      const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) return;
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error('Session permission state is not a bounded regular file.');
      const parsed = stateSchema.parse(JSON.parse(await fs.readFile(target, 'utf8')));
      const entries = new Map(Object.entries(parsed.permissions));
      this.assertCapacity(entries);
      this.entries = entries;
    } catch (error) {
      this.logs.write('warn', 'permissions', 'Saved session permissions could not be loaded. Execution is blocked; repair the permission store and reopen Fate UI.');
      this.entries.clear();
      if (error instanceof SessionPermissionStorageError) throw error;
      throw new SessionPermissionStorageError('Saved session permission storage is unreadable or corrupt. Repair the permission store and reopen Fate UI before continuing.', { cause: error });
    }
  }

  private assertCapacity(entries: Map<string, PermissionEntry>): void {
    // Evicting read-only grants would restore them as the less restrictive Edit default.
    // Refuse the whole operation instead of silently increasing authority on restart.
    if (entries.size > MAX_ENTRIES) throw new Error('Session permission state exceeds its entry limit.');
  }

  private intentPath(): string {
    return path.join(this.dataRoot, 'session-permissions.intent.json');
  }

  private async readIntent(): Promise<PermissionWriteIntent | null> {
    try {
      const target = this.intentPath();
      const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) return null;
      if (!stat.isFile() || stat.size > MAX_INTENT_BYTES) throw new Error('Invalid permission intent file.');
      const file = await fs.open(target, 'r');
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.size > MAX_INTENT_BYTES) throw new Error('Invalid permission intent file.');
        const bytes = Buffer.alloc(MAX_INTENT_BYTES + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_INTENT_BYTES) throw new Error('Permission intent exceeds its size limit.');
        return intentSchema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
      } finally { await file.close(); }
    } catch (error) {
      throw new SessionPermissionStorageError('Session permission write intent is unreadable or corrupt. Execution is blocked. Stop Fate UI and inspect and repair both permission files before restarting; do not remove the intent alone.', { cause: error });
    }
  }

  private async assertNoIntent(): Promise<void> {
    if (await this.readIntent()) {
      throw new SessionPermissionStorageError('An incomplete session permission write intent blocks execution. Stop Fate UI and inspect and repair both permission files before restarting; do not remove the intent alone. No automatic retry or replay is permitted.');
    }
  }

  private async syncDirectory(): Promise<void> {
    // The marker protocol applies on every platform. Windows cannot open a
    // directory for fsync through this API; no stronger power-loss claim is made.
    if (process.platform === 'win32') return;
    const directory = await fs.open(this.dataRoot, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async persist(entries: Map<string, PermissionEntry>): Promise<void> {
    const target = this.filePath();
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const contents = `${JSON.stringify({ version: 1 as const, permissions: Object.fromEntries(entries) }, null, 2)}\n`;
    if (Buffer.byteLength(contents, 'utf8') > MAX_STATE_BYTES) throw new Error('Session permission state exceeds its size limit.');
    const intent: PermissionWriteIntent = { version: 1, transactionId: randomUUID(), createdAt: Date.now(), stateSha256: createHash('sha256').update(contents).digest('hex') };
    await fs.mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    try {
      // Exclusive creation refuses another writer's intent. Flush its contents
      // and directory entry BEFORE replacing any grant. Never clean it on error.
      const marker = await fs.open(this.intentPath(), 'wx', 0o600);
      try {
        await marker.writeFile(`${JSON.stringify(intent)}\n`, 'utf8');
        await marker.sync();
      } finally { await marker.close(); }
      await this.syncDirectory();
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(contents, 'utf8');
        await file.sync();
      } finally { await file.close(); }
      await fs.rename(temporary, target);
      await this.syncDirectory();
      const retained = await this.readIntent();
      if (!retained || retained.transactionId !== intent.transactionId || retained.stateSha256 !== intent.stateSha256 || retained.createdAt !== intent.createdAt) {
        throw new Error('Permission write intent changed before commit.');
      }
      // FINAL COMMIT BOUNDARY. All file/directory syncs and handle closes are
      // complete. Nothing fallible follows successful marker removal. A marker
      // resurrected after power loss conservatively blocks recovery instead.
      await fs.unlink(this.intentPath());
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    // A failed transaction cannot reach this commit boundary: health is sticky.
  }

  private filePath(): string {
    return path.join(this.dataRoot, 'session-permissions.json');
  }
}
