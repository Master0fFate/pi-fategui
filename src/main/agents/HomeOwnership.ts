import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { MAX_SESSION_SNAPSHOT_BYTES } from '../pi/PiSessionRepository';
import { readAgentSessionPreset, SAVED_AGENT_SESSION_TYPE } from './AgentSessionPreset';
import type { SavedAgentSession } from '../../shared/contracts/agents';

const OWNER_TYPE = 'fate-agent-home-v1';
const homeOwnerSchema = z.object({ agentId: z.string().uuid(), revision: z.number().int().positive().safe(), instructions: z.string().max(65_536), projectPath: z.string().min(1) }).passthrough();
export interface HomeOwner { agentId: string; revision: number; instructions: string; projectPath: string; preset?: SavedAgentSession }
export interface HomeOpenOptions { enabled: boolean; deleted: boolean; requireExisting?: boolean | undefined; requirePreset?: boolean | undefined }

/** Initializes durable ownership through the supported SDK empty-file open path. */
export class HomeOwnership {
  constructor(private readonly directory: string) {}

  async open(owner: HomeOwner, lifecycle: HomeOpenOptions = { enabled: true, deleted: false }, sessionKey = owner.agentId): Promise<{ sessionId: string; file: string; appliedRevision: number }> {
    if (!lifecycle.enabled || lifecycle.deleted) throw new Error('Disabled or deleted Agents cannot open or run a home; the saved conversation is retained.');
    const parsedSessionKey = z.string().uuid().safeParse(sessionKey);
    if (!parsedSessionKey.success) throw new Error('Invalid home owner.');
    const projectPath = await fs.realpath(owner.projectPath);
    const ownerRecord = homeOwnerSchema.parse({ agentId: owner.agentId, revision: owner.revision, instructions: owner.instructions, projectPath });
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await fs.realpath(this.directory);
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error('Linked home storage is not allowed.');
    const file = path.join(root, `${sessionKey}.jsonl`);
    const lock = `${file}.lock`;
    const lockOwner = await this.acquireLock(lock);
    let temp: string | null = null;
    try {
      const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0)) throw new Error('Unsafe or ambiguous home session. Recover manually.');
      if (stat && stat.size > MAX_SESSION_SNAPSHOT_BYTES) throw new Error('Home exceeds the supported 128 MiB session-reader limit. Its history is retained; export or archive it before opening another conversation.');
      if (!stat && lifecycle.requireExisting) throw new Error('The retained home session is missing. Restore it from backup; ownership was not silently reassigned.');
      if (!stat) {
        temp = path.join(root, `${randomUUID()}.tmp`);
        const empty = await fs.open(temp, 'wx', 0o600);
        await empty.close();
        const manager = SessionManager.open(temp, root, projectPath);
        manager.appendCustomEntry(OWNER_TYPE, ownerRecord);
        if (owner.preset) {
          manager.appendCustomEntry(SAVED_AGENT_SESSION_TYPE, owner.preset);
          manager.appendSessionInfo(owner.preset.name);
          if (owner.preset.defaults.model) manager.appendModelChange(owner.preset.defaults.model.provider, owner.preset.defaults.model.id);
          manager.appendThinkingLevelChange(owner.preset.defaults.thinkingLevel);
        }
        const durable = await fs.open(temp, 'r+');
        try { await durable.sync(); } finally { await durable.close(); }
        await fs.rename(temp, file);
      }
      const manager = SessionManager.open(file, root, projectPath);
      const entries = manager.getEntries().filter((entry) => entry.type === 'custom' && entry.customType === OWNER_TYPE);
      if (entries.length !== 1 || entries[0]?.type !== 'custom') throw new Error('Ambiguous home ownership.');
      const saved = homeOwnerSchema.parse(entries[0].data);
      if (saved.agentId !== ownerRecord.agentId || saved.projectPath !== projectPath) throw new Error('Home belongs to another Agent or project.');
      if (lifecycle.requirePreset === true || (lifecycle.requirePreset !== false && owner.preset !== undefined)) {
        const preset = readAgentSessionPreset(manager);
        if (!preset) throw new Error('Saved Agent session is missing or corrupt. Restore it from backup; ownership was not silently reassigned.');
        if (preset.agentId !== owner.agentId || preset.projectPath !== projectPath) throw new Error('Saved Agent session belongs to another Agent or project.');
      }
      // Rename/default/instruction edits never rewrite a historical home snapshot.
      return { sessionId: manager.getSessionId(), file, appliedRevision: saved.revision };
    } finally {
      await lockOwner.handle.close();
      if (await fs.readFile(lock, 'utf8').catch(() => null) === lockOwner.owner) await fs.unlink(lock).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      if (temp) await fs.unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  private async acquireLock(lock: string): Promise<{ handle: Awaited<ReturnType<typeof fs.open>>; owner: string }> {
    const ownerRecord = JSON.stringify({ token: randomUUID(), pid: process.pid, host: os.hostname() });
    try {
      const handle = await fs.open(lock, 'wx', 0o600);
      try {
        await handle.writeFile(ownerRecord);
        await handle.sync();
        return { handle, owner: ownerRecord };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.unlink(lock).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockStat = await fs.lstat(lock).catch((statError: unknown) => { if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return null; throw statError; });
      if (!lockStat || !lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.nlink !== 1) throw new Error('Unsafe home lock. Recover manually without following linked storage.');
      const source = await fs.readFile(lock, 'utf8');
      let owner: { pid?: unknown; host?: unknown; token?: unknown };
      try { owner = JSON.parse(source) as { pid?: unknown; host?: unknown; token?: unknown }; }
      catch { throw new Error('Unsafe home lock. Recover manually after confirming the writer is stopped.'); }
      if (owner?.host === os.hostname() && typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
            // A crash between lock acquisition and release leaves this owner
            // record behind. A proven-dead writer on this host cannot still be
            // inside the critical section, so one recovery attempt is safe; a
            // changed lock during recovery means another writer won the race.
            if (await fs.readFile(lock, 'utf8').catch(() => null) === source) {
              await fs.unlink(lock);
              return this.acquireLock(lock);
            }
          }
        }
      }
      throw new Error('An Agent home operation is already in progress or was interrupted without recovery. Stop other Fate UI windows for this project, then retry; if it persists, remove only the matching .lock file after confirming no writer is active.');
    }
  }
}
