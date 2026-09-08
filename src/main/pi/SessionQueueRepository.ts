import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { queuedMessageSchema, type QueuedMessage } from '../../shared/contracts/ipc';

const documentSchema = z.object({
  version: z.literal(1),
  projectPath: z.string().min(1),
  sessionId: z.string().min(1),
  messages: z.array(queuedMessageSchema).max(100),
}).strict();
const MAX_BYTES = 64 * 1024 * 1024;

export interface SessionQueuePersistence {
  load(projectPath: string, sessionId: string): Promise<QueuedMessage[]>;
  save(projectPath: string, sessionId: string, messages: readonly QueuedMessage[]): Promise<void>;
  deleteSession(projectPath: string, sessionId: string): Promise<void>;
}

function canonical(projectPath: string): string {
  const resolved = path.resolve(projectPath).normalize('NFC');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export class InMemorySessionQueueRepository implements SessionQueuePersistence {
  private readonly records = new Map<string, QueuedMessage[]>();
  async load(projectPath: string, sessionId: string): Promise<QueuedMessage[]> {
    return structuredClone(this.records.get(`${canonical(projectPath)}\0${sessionId}`) ?? []);
  }
  async save(projectPath: string, sessionId: string, messages: readonly QueuedMessage[]): Promise<void> {
    this.records.set(`${canonical(projectPath)}\0${sessionId}`, structuredClone([...messages]));
  }
  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    this.records.delete(`${canonical(projectPath)}\0${sessionId}`);
  }
}

/** A draft outbox, not permission to replay work whose delivery is uncertain. */
export class SessionQueueRepository implements SessionQueuePersistence {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly root = path.join(
    process.env.FATE_GUI_DATA_DIR ? path.resolve(process.env.FATE_GUI_DATA_DIR) : path.join(os.homedir(), '.pi', 'fateGUI'),
    'session-queues', 'v1',
  ), private readonly instanceSlot = 0) {}

  async load(projectPath: string, sessionId: string): Promise<QueuedMessage[]> {
    const target = this.target(projectPath, sessionId);
    await this.writes.get(target);
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Saved message queue exceeds its storage limit.');
      const document = documentSchema.parse(JSON.parse(await fs.readFile(target, 'utf8')));
      if (document.projectPath !== canonical(projectPath) || document.sessionId !== sessionId) throw new Error('Saved message queue belongs to another session.');
      return document.messages;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  save(projectPath: string, sessionId: string, messages: readonly QueuedMessage[]): Promise<void> {
    const target = this.target(projectPath, sessionId);
    const document = documentSchema.parse({ version: 1, projectPath: canonical(projectPath), sessionId, messages });
    const serialized = JSON.stringify(document);
    if (Buffer.byteLength(serialized) > MAX_BYTES) return Promise.reject(new Error('The saved message queue is full. Remove attachments or waiting messages.'));
    return this.enqueue(target, async () => {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  }

  deleteSession(projectPath: string, sessionId: string): Promise<void> {
    const target = this.target(projectPath, sessionId);
    return this.enqueue(target, () => fs.rm(target, { force: true }));
  }

  private enqueue(target: string, operation: () => Promise<void>): Promise<void> {
    const result = (this.writes.get(target) ?? Promise.resolve()).then(operation, operation);
    this.writes.set(target, result);
    void result.then(() => { if (this.writes.get(target) === result) this.writes.delete(target); }, () => undefined);
    return result;
  }

  private target(projectPath: string, sessionId: string): string {
    const key = createHash('sha256').update(`${canonical(projectPath)}\0${sessionId}`).digest('hex');
    return path.join(this.root, `instance-${this.instanceSlot}`, `${key}.json`);
  }
}
