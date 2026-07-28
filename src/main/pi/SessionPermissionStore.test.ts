import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppLogService } from '../logging/AppLogService';
import { SessionPermissionStore } from './SessionPermissionStore';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function dataRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fate-session-permissions-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('SessionPermissionStore', () => {
  it('persists permissions by project and session without writing them into Pi sessions', async () => {
    const root = await dataRoot();
    const logs = new AppLogService();
    const store = new SessionPermissionStore(logs, root);

    await store.set('C:/work/project-a', 'session-1', 'full-access');
    await store.set('C:/work/project-a', 'session-2', 'read-only');
    await store.set('C:/work/project-b', 'session-1', 'edit');

    const reloaded = new SessionPermissionStore(logs, root);
    await expect(reloaded.get('C:/work/project-a', 'session-1')).resolves.toBe('full-access');
    await expect(reloaded.get('C:/work/project-a', 'session-2')).resolves.toBe('read-only');
    await expect(reloaded.get('C:/work/project-b', 'session-1')).resolves.toBe('edit');
    const persisted = JSON.parse(await readFile(path.join(root, 'session-permissions.json'), 'utf8')) as { permissions: Record<string, unknown> };
    expect(Object.keys(persisted.permissions)).toHaveLength(3);
    expect(JSON.stringify(persisted)).not.toContain('C:/work/project-a');
  });

  it('removes deleted session metadata', async () => {
    const root = await dataRoot();
    const store = new SessionPermissionStore(new AppLogService(), root);
    await store.set('/project', 'session-1', 'full-access');

    await store.delete('/project', 'session-1');

    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'session-1')).resolves.toBeUndefined();
  });

  it('fails closed and records a warning for malformed persisted state', async () => {
    const root = await dataRoot();
    await writeFile(path.join(root, 'session-permissions.json'), '{not-json', 'utf8');
    const logs = new AppLogService();

    await expect(new SessionPermissionStore(logs, root).get('/project', 'session-1')).resolves.toBeUndefined();

    expect(logs.list()).toEqual(expect.arrayContaining([expect.objectContaining({ level: 'warn', scope: 'permissions' })]));
  });
});
