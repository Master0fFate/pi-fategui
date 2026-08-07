import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationRepository } from './AutomationRepository';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fate-automations-'));
  roots.push(root);
  const logs = { write: vi.fn() };
  return { root, logs, repository: new AutomationRepository(logs, root) };
}

describe('AutomationRepository', () => {
  it('atomically creates, updates, lists, launches, and removes project-scoped automations', async () => {
    const { repository: automations } = await repository();
    const created = await automations.create('/project-a', {
      name: 'Review auth',
      prompt: 'Review auth changes.',
      permissionLevel: 'read-only',
    });
    expect(await automations.list('/project-a')).toEqual([created]);
    expect(await automations.list('/project-b')).toEqual([]);

    const updated = await automations.update('/project-a', {
      id: created.id,
      name: 'Review authentication',
      prompt: 'Review auth changes and run focused tests.',
      permissionLevel: 'edit',
    });
    expect(updated).toMatchObject({ name: 'Review authentication', permissionLevel: 'edit', launchCount: 0 });

    const launched = await automations.recordLaunch('/project-a', created.id, 'accepted');
    expect(launched).toMatchObject({ launchCount: 1, lastLaunchOutcome: 'accepted' });
    expect(launched.lastLaunchedAt).toBeTypeOf('number');

    await automations.remove('/project-a', created.id);
    expect(await automations.list('/project-a')).toEqual([]);
  });

  it('serializes concurrent writes and rejects ambiguous duplicate names', async () => {
    const { repository: automations } = await repository();
    await Promise.all([
      automations.create('/project', { name: 'Alpha', prompt: 'Run alpha.', permissionLevel: 'read-only' }),
      automations.create('/project', { name: 'Beta', prompt: 'Run beta.', permissionLevel: 'edit' }),
    ]);
    expect((await automations.list('/project')).map((automation) => automation.name).sort()).toEqual(['Alpha', 'Beta']);
    await expect(automations.create('/project', {
      name: 'alpha',
      prompt: 'Duplicate.',
      permissionLevel: 'read-only',
    })).rejects.toThrow('already exists');
  });

  it('ignores malformed persisted data without exposing it to the renderer', async () => {
    const { root, logs, repository: automations } = await repository();
    await automations.create('/project', { name: 'Review', prompt: 'Review.', permissionLevel: 'read-only' });
    const file = (await findFiles(root)).find((entry) => entry.endsWith('automations.json'))!;
    expect(await readFile(file, 'utf8')).toContain('Review');
    await writeFile(file, '{ malformed', 'utf8');

    await expect(new AutomationRepository(logs, root).list('/project')).resolves.toEqual([]);
    expect(logs.write).toHaveBeenCalledWith('warn', 'automations', expect.stringContaining('ignored'));
  });

  it('rejects an oversized write before it can replace valid saved definitions', async () => {
    const { root, logs, repository: automations } = await repository();
    const created = await automations.create('/project', { name: 'Review', prompt: 'Review.', permissionLevel: 'read-only' });
    const file = (await findFiles(root)).find((entry) => entry.endsWith('automations.json'))!;
    const currentBytes = (await readFile(file)).byteLength;
    const limited = new AutomationRepository(logs, root, currentBytes + 128);

    await expect(limited.update('/project', {
      id: created.id,
      name: created.name,
      prompt: 'x'.repeat(2_000),
      permissionLevel: created.permissionLevel,
    })).rejects.toThrow('storage limit');

    expect(await automations.list('/project')).toEqual([created]);
  });

  it('does not let one project mutate another project’s definitions', async () => {
    const { repository: automations } = await repository();
    const created = await automations.create('/project-a', { name: 'Only A', prompt: 'Run A.', permissionLevel: 'read-only' });
    await expect(automations.update('/project-b', {
      id: created.id,
      name: 'Moved',
      prompt: 'Move it.',
      permissionLevel: 'read-only',
    })).rejects.toThrow('no longer exists');
    await expect(automations.remove('/project-b', created.id)).rejects.toThrow('no longer exists');
    expect(await automations.list('/project-a')).toHaveLength(1);
  });
});

async function findFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target); else result.push(target);
    }
  };
  await visit(root);
  return result;
}
