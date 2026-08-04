import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GOALMAX_BRIEF_LIMIT, goalMaxStateSchema, type GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import { migrateGoalMaxSnapshot } from './GoalMaxMigrations';

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_JOURNAL_EVENTS = 1_000;

export interface GoalMaxPersistence {
  load(projectPath: string, sessionId: string): Promise<GoalMaxState | null>;
  save(state: GoalMaxState, expectedRevision: number | null): Promise<void>;
  saveBrief(projectPath: string, sessionId: string, goalId: string, brief: string): Promise<{ ref: string; hash: string }>;
  archiveAndClear(state: GoalMaxState): Promise<void>;
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

export class InMemoryGoalMaxRepository implements GoalMaxPersistence {
  private readonly states = new Map<string, GoalMaxState>();
  readonly archives: GoalMaxState[] = [];
  readonly briefs = new Map<string, string>();

  async load(projectPath: string, sessionId: string): Promise<GoalMaxState | null> {
    const state = this.states.get(stateKey(projectPath, sessionId));
    return state ? clone(state) : null;
  }

  async save(state: GoalMaxState, expectedRevision: number | null): Promise<void> {
    const parsed = goalMaxStateSchema.parse(state);
    const key = stateKey(parsed.projectPath, parsed.sessionId);
    const current = this.states.get(key);
    if ((current?.revision ?? null) !== expectedRevision) throw new Error('GoalMax snapshot changed before this mutation could commit.');
    if (parsed.revision !== (expectedRevision ?? 0) + 1) throw new Error('GoalMax snapshots must advance by exactly one revision.');
    this.states.set(key, clone(parsed));
  }

  async saveBrief(projectPath: string, sessionId: string, goalId: string, brief: string): Promise<{ ref: string; hash: string }> {
    const hash = createHash('sha256').update(brief).digest('hex');
    const ref = `brief-${safeHash(goalId).slice(0, 16)}-${hash.slice(0, 16)}.txt`;
    this.briefs.set(`${stateKey(projectPath, sessionId)}\0${ref}`, brief);
    return { ref, hash };
  }

  async archiveAndClear(state: GoalMaxState): Promise<void> {
    const key = stateKey(state.projectPath, state.sessionId);
    const current = this.states.get(key);
    if (!current || current.id !== state.id || current.revision !== state.revision) throw new Error('GoalMax snapshot changed before it could be cleared.');
    this.archives.push(clone(current));
    this.states.delete(key);
  }

  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    this.states.delete(stateKey(projectPath, sessionId));
  }
}

interface LogSink {
  write(level: 'info' | 'warn' | 'error', scope: string, message: string): void;
}

/** Atomic, revision-checked host-owned goal snapshots plus a bounded audit journal. */
export class GoalMaxRepository implements GoalMaxPersistence {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly revisions = new Map<string, number | null>();

  constructor(
    private readonly logs: LogSink,
    private readonly dataRoot = process.env.FATE_GUI_DATA_DIR
      ? path.join(path.resolve(process.env.FATE_GUI_DATA_DIR), 'goalmaxxing', 'v1')
      : path.join(os.homedir(), '.pi', 'fateGUI', 'goalmaxxing', 'v1'),
  ) {}

  async load(projectPath: string, sessionId: string): Promise<GoalMaxState | null> {
    const key = stateKey(projectPath, sessionId);
    await this.queues.get(key)?.catch(() => undefined);
    const state = await this.readCurrent(projectPath, sessionId);
    this.revisions.set(key, state?.revision ?? null);
    return state;
  }

  save(state: GoalMaxState, expectedRevision: number | null): Promise<void> {
    const parsed = goalMaxStateSchema.parse(state);
    return this.enqueue(parsed.projectPath, parsed.sessionId, async () => {
      const key = stateKey(parsed.projectPath, parsed.sessionId);
      const known = this.revisions.has(key)
        ? this.revisions.get(key)!
        : (await this.readCurrent(parsed.projectPath, parsed.sessionId))?.revision ?? null;
      if (known !== expectedRevision) throw new Error('GoalMax snapshot changed before this mutation could commit.');
      if (parsed.revision !== (expectedRevision ?? 0) + 1) throw new Error('GoalMax snapshots must advance by exactly one revision.');
      const directory = this.sessionDirectory(parsed.projectPath, parsed.sessionId);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await this.atomicWrite(path.join(directory, 'current.json'), `${JSON.stringify(parsed, null, 2)}\n`);
      this.revisions.set(key, parsed.revision);
      await this.appendJournal(directory, {
        goalId: parsed.id,
        revision: parsed.revision,
        status: parsed.status,
        phase: parsed.phase,
        timestamp: parsed.updatedAt,
      });
    });
  }

  saveBrief(projectPath: string, sessionId: string, goalId: string, brief: string): Promise<{ ref: string; hash: string }> {
    return this.enqueue(projectPath, sessionId, async () => {
      const directory = this.sessionDirectory(projectPath, sessionId);
      const hash = createHash('sha256').update(brief).digest('hex');
      const ref = `brief-${safeHash(goalId).slice(0, 16)}-${hash.slice(0, 16)}.txt`;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await this.atomicWrite(path.join(directory, ref), brief);
      return { ref, hash };
    });
  }

  archiveAndClear(state: GoalMaxState): Promise<void> {
    const parsed = goalMaxStateSchema.parse(state);
    return this.enqueue(parsed.projectPath, parsed.sessionId, async () => {
      const key = stateKey(parsed.projectPath, parsed.sessionId);
      const current = await this.readCurrent(parsed.projectPath, parsed.sessionId);
      if (!current || current.id !== parsed.id || current.revision !== parsed.revision) throw new Error('GoalMax snapshot changed before it could be cleared.');
      const directory = this.sessionDirectory(parsed.projectPath, parsed.sessionId);
      const archiveDirectory = path.join(directory, 'archive');
      await fs.mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
      await this.atomicWrite(path.join(archiveDirectory, `${safeHash(parsed.id).slice(0, 24)}-${parsed.revision}.json`), `${JSON.stringify(parsed, null, 2)}\n`);
      const briefFiles = (await fs.readdir(directory)).filter((name) => /^brief-[0-9a-f-]+\.txt$/u.test(name));
      for (const name of briefFiles) {
        const source = path.join(directory, name);
        const destination = path.join(archiveDirectory, name);
        await fs.rename(source, destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      await fs.rm(path.join(directory, 'current.json'), { force: true });
      this.revisions.set(key, null);
      await this.appendJournal(directory, { goalId: parsed.id, revision: parsed.revision, status: 'cleared', timestamp: Date.now() });
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

  private async readCurrent(projectPath: string, sessionId: string): Promise<GoalMaxState | null> {
    const target = path.join(this.sessionDirectory(projectPath, sessionId), 'current.json');
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SNAPSHOT_BYTES) throw new Error('Saved GoalMax snapshot exceeds its size limit.');
      const state = migrateGoalMaxSnapshot(JSON.parse(await fs.readFile(target, 'utf8')));
      if (state.sessionId !== sessionId || !sameProjectPath(state.projectPath, projectPath)) throw new Error('Saved GoalMax snapshot identity does not match its session directory.');
      if (state.originalBriefRef && state.originalBriefHash) {
        const briefPath = path.join(path.dirname(target), path.basename(state.originalBriefRef));
        const briefStat = await fs.stat(briefPath);
        if (!briefStat.isFile() || briefStat.size > GOALMAX_BRIEF_LIMIT * 4) throw new Error('Saved GoalMax source brief exceeds its size limit.');
        const brief = await fs.readFile(briefPath, 'utf8');
        if (createHash('sha256').update(brief).digest('hex') !== state.originalBriefHash) throw new Error('Saved GoalMax source brief failed its integrity check.');
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.logs.write('warn', 'goalmaxxing', `Saved goal state was ignored: ${error instanceof Error ? error.message : String(error)}`);
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

  private async appendJournal(directory: string, event: Record<string, unknown>): Promise<void> {
    const target = path.join(directory, 'events.jsonl');
    await fs.appendFile(target, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      const stat = await fs.stat(target);
      if (stat.size <= MAX_JOURNAL_BYTES) return;
      const lines = (await fs.readFile(target, 'utf8')).trimEnd().split('\n').slice(-MAX_JOURNAL_EVENTS);
      await this.atomicWrite(target, `${lines.join('\n')}\n`);
    } catch (error) {
      this.logs.write('warn', 'goalmaxxing', `Goal audit journal could not be compacted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function sameProjectPath(left: string, right: string): boolean {
  return canonicalProjectPath(left) === canonicalProjectPath(right);
}

function safeHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
