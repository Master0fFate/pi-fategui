import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { permissionLevelSchema, type PermissionLevel } from '../../shared/contracts/ipc';
import type { AppLogService } from '../logging/AppLogService';

const MAX_ENTRIES = 5_000;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_ID_CHARACTERS = 500;

const entrySchema = z.object({
  level: permissionLevelSchema,
  updatedAt: z.number().int().nonnegative(),
});

const stateSchema = z.object({
  version: z.literal(1),
  permissions: z.record(entrySchema),
});

type PermissionEntry = z.infer<typeof entrySchema>;

export interface SessionPermissionPersistence {
  get(projectPath: string, sessionId: string): Promise<PermissionLevel | undefined>;
  set(projectPath: string, sessionId: string, level: PermissionLevel): Promise<void>;
  delete(projectPath: string, sessionId: string): Promise<void>;
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
}

/** Host-owned permission metadata. Session JSONL content can never grant itself access. */
export class SessionPermissionStore implements SessionPermissionPersistence {
  private entries = new Map<string, PermissionEntry>();
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly logs: AppLogService,
    private readonly dataRoot = process.env.FATE_GUI_DATA_DIR
      ? path.resolve(process.env.FATE_GUI_DATA_DIR)
      : path.join(os.homedir(), '.pi', 'fateGUI'),
  ) {}

  async get(projectPath: string, sessionId: string): Promise<PermissionLevel | undefined> {
    await this.writeQueue;
    await this.load();
    return this.entries.get(permissionKey(projectPath, sessionId))?.level;
  }

  set(projectPath: string, sessionId: string, level: PermissionLevel): Promise<void> {
    const key = permissionKey(projectPath, sessionId);
    return this.enqueue(async () => {
      const next = new Map(this.entries);
      next.set(key, { level, updatedAt: Date.now() });
      this.prune(next);
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
      await this.load();
      await operation();
    });
    this.writeQueue = queued.catch(() => undefined);
    return queued;
  }

  private load(): Promise<void> {
    this.loadPromise ??= this.readState();
    return this.loadPromise;
  }

  private async readState(): Promise<void> {
    try {
      const target = this.filePath();
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error('Session permission state exceeds its size limit.');
      const parsed = stateSchema.parse(JSON.parse(await fs.readFile(target, 'utf8')));
      this.entries = new Map(Object.entries(parsed.permissions));
      this.prune(this.entries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logs.write('warn', 'permissions', `Saved session permissions were ignored: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.entries.clear();
    }
  }

  private prune(entries: Map<string, PermissionEntry>): void {
    if (entries.size <= MAX_ENTRIES) return;
    const oldest = [...entries.entries()]
      .sort(([leftKey, left], [rightKey, right]) => left.updatedAt - right.updatedAt || leftKey.localeCompare(rightKey))
      .slice(0, entries.size - MAX_ENTRIES);
    for (const [key] of oldest) entries.delete(key);
  }

  private async persist(entries: Map<string, PermissionEntry>): Promise<void> {
    const target = this.filePath();
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const state = { version: 1 as const, permissions: Object.fromEntries(entries) };
    await fs.mkdir(this.dataRoot, { recursive: true });
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private filePath(): string {
    return path.join(this.dataRoot, 'session-permissions.json');
  }
}
