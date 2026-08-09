import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { taskListSchema, type TaskList } from '../../../shared/contracts/tasks';

export interface TaskPersistence {
  load(projectPath: string, sessionId: string): Promise<TaskList | null>;
  save(state: TaskList, expectedRevision: number | null): Promise<void>;
  deleteSession(projectPath: string, sessionId: string): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalProjectPath(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function stateKey(projectPath: string, sessionId: string): string {
  return `${canonicalProjectPath(projectPath)}\0${sessionId}`;
}

const MAX_SNAPSHOT_BYTES = 1 * 1024 * 1024;

/** In-memory task persistence used by tests and the unauthenticated path. */
export class InMemoryTaskRepository implements TaskPersistence {
  private readonly states = new Map<string, TaskList>();

  async load(projectPath: string, sessionId: string): Promise<TaskList | null> {
    const state = this.states.get(stateKey(projectPath, sessionId));
    return state ? clone(state) : null;
  }

  async save(state: TaskList, expectedRevision: number | null): Promise<void> {
    const parsed = taskListSchema.parse(state);
    const key = stateKey(parsed.projectPath, parsed.sessionId);
    const current = this.states.get(key);
    if ((current?.revision ?? null) !== expectedRevision) throw new Error('The task list changed before this mutation could commit.');
    if (parsed.revision !== (expectedRevision ?? 0) + 1) throw new Error('Task list revisions must advance by exactly one.');
    this.states.set(key, clone(parsed));
  }

  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    this.states.delete(stateKey(projectPath, sessionId));
  }
}

interface LogSink {
  write(level: 'info' | 'warn' | 'error', scope: string, message: string): void;
}

/** Atomic, revision-checked host-owned task snapshots. */
export class TaskRepository implements TaskPersistence {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly revisions = new Map<string, number | null>();

  constructor(
    private readonly logs: LogSink,
    private readonly dataRoot = process.env.FATE_GUI_DATA_DIR
      ? path.join(path.resolve(process.env.FATE_GUI_DATA_DIR), 'tasks', 'v1')
      : path.join(os.homedir(), '.pi', 'fateGUI', 'tasks', 'v1'),
  ) {}

  async load(projectPath: string, sessionId: string): Promise<TaskList | null> {
    const key = stateKey(projectPath, sessionId);
    await this.queues.get(key)?.catch(() => undefined);
    const state = await this.readCurrent(projectPath, sessionId);
    this.revisions.set(key, state?.revision ?? null);
    return state;
  }

  save(state: TaskList, expectedRevision: number | null): Promise<void> {
    const parsed = taskListSchema.parse(state);
    return this.enqueue(parsed.projectPath, parsed.sessionId, async () => {
      const key = stateKey(parsed.projectPath, parsed.sessionId);
      const known = this.revisions.has(key)
        ? this.revisions.get(key)!
        : (await this.readCurrent(parsed.projectPath, parsed.sessionId))?.revision ?? null;
      if (known !== expectedRevision) throw new Error('The task list changed before this mutation could commit.');
      if (parsed.revision !== (expectedRevision ?? 0) + 1) throw new Error('Task list revisions must advance by exactly one.');
      const directory = this.sessionDirectory(parsed.projectPath, parsed.sessionId);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await this.atomicWrite(path.join(directory, 'current.json'), `${JSON.stringify(parsed, null, 2)}\n`);
      this.revisions.set(key, parsed.revision);
    });
  }

  deleteSession(projectPath: string, sessionId: string): Promise<void> {
    return this.enqueue(projectPath, sessionId, async () => {
      await fs.rm(this.sessionDirectory(projectPath, sessionId), { recursive: true, force: true });
      this.revisions.delete(stateKey(projectPath, sessionId));
    });
  }

  private enqueue<T>(projectPath: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    const key = stateKey(projectPath, sessionId);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.finally(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return result;
  }

  private async readCurrent(projectPath: string, sessionId: string): Promise<TaskList | null> {
    const target = path.join(this.sessionDirectory(projectPath, sessionId), 'current.json');
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SNAPSHOT_BYTES) throw new Error('Saved task list exceeds its size limit.');
      const state = taskListSchema.parse(JSON.parse(await fs.readFile(target, 'utf8')));
      if (state.sessionId !== sessionId || canonicalProjectPath(state.projectPath) !== canonicalProjectPath(projectPath)) {
        throw new Error('Saved task list identity does not match its session directory.');
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.logs.write('warn', 'tasks', `Saved task list was ignored: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private sessionDirectory(projectPath: string, sessionId: string): string {
    return path.join(this.dataRoot, safeHash(canonicalProjectPath(projectPath)).slice(0, 32), safeHash(sessionId).slice(0, 32));
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(temporary, 'w', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, target);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function safeHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
