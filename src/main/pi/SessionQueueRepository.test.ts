import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionQueueRepository } from './SessionQueueRepository';
import type { QueuedMessage } from '../../shared/contracts/ipc';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-queue-'));
  roots.push(root);
  return { root, repository: new SessionQueueRepository(root) };
}
const message = (): QueuedMessage => ({ id: randomUUID(), text: 'Check the regression', behavior: 'followUp', createdAt: Date.now() });

describe('SessionQueueRepository', () => {
  it('restores exact draft identity, attachments, and requested settings after reopening', async () => {
    const { root, repository } = await fixture();
    const draft = { ...message(), images: [{ data: 'aGVsbG8=', mimeType: 'image/png' as const, name: 'flow.png' }], requestedModel: { provider: 'test', id: 'exact-model' }, requestedThinkingLevel: 'high' as const };
    await repository.save('/project', 'session', [draft]);
    expect(await new SessionQueueRepository(root).load('/project', 'session')).toEqual([draft]);
    expect(await repository.load('/other', 'session')).toEqual([]);
    expect(await repository.load('/project', 'other')).toEqual([]);
    expect(await new SessionQueueRepository(root, 1).load('/project', 'session')).toEqual([]);
  });

  it('serializes replacement and deletion without resurrecting cancelled messages', async () => {
    const { repository } = await fixture();
    const first = repository.save('/project', 'session', [message()]);
    const second = repository.save('/project', 'session', []);
    await Promise.all([first, second]);
    expect(await repository.load('/project', 'session')).toEqual([]);
    const third = repository.save('/project', 'session', [message()]);
    const deleted = repository.deleteSession('/project', 'session');
    await Promise.all([third, deleted]);
    expect(await repository.load('/project', 'session')).toEqual([]);
  });

  it('fails visibly on corrupt data and leaves it untouched', async () => {
    const { root, repository } = await fixture();
    await repository.save('/project', 'session', [message()]);
    const directory = path.join(root, 'instance-0');
    const target = path.join(directory, (await fs.readdir(directory))[0]!);
    await fs.writeFile(target, '{broken');
    await expect(repository.load('/project', 'session')).rejects.toThrow();
    expect(await fs.readFile(target, 'utf8')).toBe('{broken');
  });

  it('rejects oversized queues before replacing valid data', async () => {
    const { repository } = await fixture();
    const previous = message();
    await repository.save('/project', 'session', [previous]);
    expect(() => repository.save('/project', 'session', Array.from({ length: 101 }, message))).toThrow();
    expect(await repository.load('/project', 'session')).toEqual([previous]);
  });
});
