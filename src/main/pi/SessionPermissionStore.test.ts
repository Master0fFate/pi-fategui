import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLogService } from '../logging/AppLogService';
import { SessionPermissionStore } from './SessionPermissionStore';

const temporaryDirectories: string[] = [];
const intentName = 'session-permissions.intent.json';
const foreignIntent = JSON.stringify({ version: 1, transactionId: '00000000-0000-4000-8000-000000000001', createdAt: 1, stateSha256: 'a'.repeat(64) });

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

  it('distinguishes a genuinely missing file and record from unhealthy storage', async () => {
    const root = await dataRoot();
    const store = new SessionPermissionStore(new AppLogService(), root);
    await expect(store.get('/project', 'missing')).resolves.toBeUndefined();
    await store.set('/project', 'other', 'edit');
    await expect(store.get('/project', 'missing')).resolves.toBeUndefined();
  });

  it.each(['{not-json', '{"version":2,"permissions":{}}', '{"version":1,"permissions":{"bad":{"level":"owner","updatedAt":1}}}'])('refuses malformed state without overwriting it: %s', async (contents) => {
    const root = await dataRoot();
    const file = path.join(root, 'session-permissions.json');
    await writeFile(file, contents, 'utf8');
    const logs = new AppLogService();
    const store = new SessionPermissionStore(logs, root);
    await expect(store.get('/project', 'session-1')).rejects.toThrow(/unreadable or corrupt/);
    await expect(store.set('/project', 'session-1', 'full-access')).rejects.toThrow(/unreadable or corrupt/);
    await expect(store.delete('/project', 'session-1')).rejects.toThrow(/unreadable or corrupt/);
    expect(await readFile(file, 'utf8')).toBe(contents);
    expect(logs.list()).toEqual(expect.arrayContaining([expect.objectContaining({ level: 'warn', scope: 'permissions' })]));
  });

  it('refuses unreadable storage instead of interpreting EACCES as a missing grant', async () => {
    const root = await dataRoot();
    vi.spyOn(fs, 'lstat').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'session-1')).rejects.toThrow(/unreadable or corrupt/);
  });

  it('does not treat disappearance between stat and read as a missing store', async () => {
    const root = await dataRoot();
    await writeFile(path.join(root, 'session-permissions.json'), '{"version":1,"permissions":{}}');
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('removed'), { code: 'ENOENT' }));
    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'session-1')).rejects.toThrow(/unreadable or corrupt/);
  });

  it.each(['directory', 'oversized'])('refuses a %s in place of bounded regular storage', async (kind) => {
    const root = await dataRoot();
    const file = path.join(root, 'session-permissions.json');
    if (kind === 'directory') await mkdir(file);
    else await writeFile(file, ' '.repeat(2 * 1024 * 1024 + 1));
    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'session-1')).rejects.toThrow(/unreadable or corrupt/);
  });

  it('refuses a capacity overflow instead of evicting an old read-only grant into Edit', async () => {
    const root = await dataRoot();
    const file = path.join(root, 'session-permissions.json');
    const seed = new SessionPermissionStore(new AppLogService(), root);
    await seed.set('/project', 'restricted', 'read-only');
    const state = JSON.parse(await readFile(file, 'utf8')) as { version: 1; permissions: Record<string, { level: string; updatedAt: number }> };
    const [restrictedKey] = Object.keys(state.permissions);
    expect(restrictedKey).toBeDefined();
    for (let index = 0; index < 4_999; index++) {
      state.permissions[`other-${index}`] = { level: 'edit', updatedAt: Date.now() + index };
    }
    await writeFile(file, JSON.stringify(state));
    const full = new SessionPermissionStore(new AppLogService(), root);
    await expect(full.get('/project', 'restricted')).resolves.toBe('read-only');
    await expect(full.set('/project', 'overflow', 'edit')).rejects.toThrow(/storage failed/);
    expect((await readFile(file, 'utf8'))).not.toContain('overflow');
    await expect(full.get('/project', 'restricted')).rejects.toThrow(/storage failed/);
    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'restricted')).resolves.toBe('read-only');

    state.permissions['over-limit'] = { level: 'edit', updatedAt: Date.now() };
    await writeFile(file, JSON.stringify(state));
    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'restricted')).rejects.toThrow(/unreadable or corrupt/);
  });

  it('syncs a private intent before writing and syncing the private temporary grant file', async () => {
    const root = await dataRoot();
    const open = fs.open.bind(fs);
    const rename = fs.rename.bind(fs);
    let intentSynced = false;
    let grantSynced = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (args[1] === 'wx') {
        expect(args[2]).toBe(0o600);
        const sync = file.sync.bind(file);
        if (String(args[0]).endsWith(intentName)) {
          vi.spyOn(file, 'sync').mockImplementation(async () => { await sync(); intentSynced = true; });
        } else if (String(args[0]).endsWith('.tmp')) {
          expect(intentSynced).toBe(true);
          vi.spyOn(file, 'sync').mockImplementation(async () => { await sync(); grantSynced = true; });
        }
      }
      return file;
    });
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      expect(intentSynced && grantSynced).toBe(true);
      await rename(...args);
    });
    await new SessionPermissionStore(new AppLogService(), root).set('/project', 'session-1', 'full-access');
    expect(intentSynced && grantSynced).toBe(true);
    await expect(fs.lstat(path.join(root, intentName))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'session-1')).resolves.toBe('full-access');
  });

  it.each(['set', 'delete'] as const)('broadcasts a %s persistence failure once to every observer before rejection', async (operation) => {
    const root = await dataRoot();
    const store = new SessionPermissionStore(new AppLogService(), root);
    await store.set('/project', 'session-1', 'edit');
    const notified: Error[] = [];
    store.onFailure(() => { throw new Error('broken observer'); });
    const unsubscribe = store.onFailure((error) => { notified.push(error); });
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));
    if (operation === 'set') await expect(store.set('/project', 'session-1', 'full-access')).rejects.toThrow(/storage failed/);
    else await expect(store.delete('/project', 'session-1')).rejects.toThrow(/storage failed/);
    expect(notified).toHaveLength(1);
    expect(() => store.assertHealthy()).toThrow(/storage failed/);
    await expect(store.get('/project', 'session-1')).rejects.toThrow(/storage failed/);
    expect(notified).toHaveLength(1);
    const late = vi.fn();
    store.onFailure(late);
    expect(late).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('refuses a grant if the temporary file cannot be synced', async () => {
    const root = await dataRoot();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).endsWith('.tmp')) vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('sync failed'));
      return file;
    });
    const rename = vi.spyOn(fs, 'rename');
    const store = new SessionPermissionStore(new AppLogService(), root);
    await expect(store.set('/project', 'session-1', 'full-access')).rejects.toThrow(/storage failed/);
    expect(rename).not.toHaveBeenCalled();
    await expect(store.get('/project', 'session-1')).rejects.toThrow(/storage failed/);
  });

  it('retains the intent and old grant on pre-rename failure, refusing same-store and fresh-store retries', async () => {
    const root = await dataRoot();
    const target = path.join(root, 'session-permissions.json');
    const store = new SessionPermissionStore(new AppLogService(), root);
    await store.set('/project', 'session-1', 'edit');
    const oldGrant = await readFile(target, 'utf8');
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(store.set('/project', 'session-1', 'full-access')).rejects.toThrow(/storage failed/);
    await expect(store.get('/project', 'session-1')).rejects.toThrow(/storage failed/);
    expect(await readFile(target, 'utf8')).toBe(oldGrant);
    const intent = await readFile(path.join(root, intentName), 'utf8');
    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'session-1')).rejects.toThrow(/write intent/);
    await expect(store.set('/project', 'session-1', 'read-only')).rejects.toThrow(/storage failed/);
    expect(rename).toHaveBeenCalledOnce();
    expect(await readFile(path.join(root, intentName), 'utf8')).toBe(intent);
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    // Explicit operator recovery fixture: verify/restore the known safe grant,
    // then remove the intent while no runtime is using the files and restart.
    await writeFile(target, oldGrant);
    await fs.unlink(path.join(root, intentName));
    await expect(store.get('/project', 'session-1')).rejects.toThrow(/storage failed/);
    const restarted = new SessionPermissionStore(new AppLogService(), root);
    await expect(restarted.get('/project', 'session-1')).resolves.toBe('edit');
    await restarted.set('/project', 'session-1', 'read-only');
    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'session-1')).resolves.toBe('read-only');
  });

  it.each(['open', 'write', 'sync', 'close'] as const)('never replaces the old grant when intent %s fails', async (phase) => {
    const root = await dataRoot();
    const target = path.join(root, 'session-permissions.json');
    const marker = path.join(root, intentName);
    const store = new SessionPermissionStore(new AppLogService(), root);
    await store.set('/project', 'session-1', 'edit');
    const oldGrant = await readFile(target, 'utf8');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (args[0] !== marker || args[1] !== 'wx') return open(...args);
      if (phase === 'open') throw new Error('intent creation denied');
      const file = await open(...args);
      if (phase === 'write') vi.spyOn(file, 'writeFile').mockRejectedValueOnce(new Error('intent write failed'));
      if (phase === 'sync') vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('intent flush failed'));
      if (phase === 'close') {
        const close = file.close.bind(file);
        vi.spyOn(file, 'close').mockImplementationOnce(async () => { await close(); throw new Error('intent close failed'); });
      }
      return file;
    });
    const rename = vi.spyOn(fs, 'rename');
    await expect(store.set('/project', 'session-1', 'full-access')).rejects.toThrow(/storage failed/);
    expect(rename).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe(oldGrant);
    const restarted = new SessionPermissionStore(new AppLogService(), root);
    if (phase === 'open') await expect(restarted.get('/project', 'session-1')).resolves.toBe('edit');
    else {
      expect((await fs.lstat(marker)).isFile()).toBe(true);
      await expect(restarted.get('/project', 'session-1')).rejects.toThrow(/write intent/);
    }
  });

  it('retains the intent on final marker-removal failure so a fresh store refuses the renamed grant', async () => {
    const root = await dataRoot();
    const store = new SessionPermissionStore(new AppLogService(), root);
    await store.set('/project', 'session-1', 'edit');
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('marker cleanup denied'));
    await expect(store.set('/project', 'session-1', 'full-access')).rejects.toThrow(/storage failed/);
    expect(await readFile(path.join(root, 'session-permissions.json'), 'utf8')).toContain('full-access');
    expect((await fs.lstat(path.join(root, intentName))).isFile()).toBe(true);
    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'session-1')).rejects.toThrow(/write intent/);
    await expect(store.set('/project', 'session-1', 'edit')).rejects.toThrow(/storage failed/);
    expect(unlink).toHaveBeenCalledOnce();
  });

  it('performs no fallible filesystem operation after successful marker removal', async () => {
    const root = await dataRoot();
    const unlink = fs.unlink.bind(fs);
    const open = fs.open.bind(fs);
    const lstat = fs.lstat.bind(fs);
    const rename = fs.rename.bind(fs);
    let committed = false;
    vi.spyOn(fs, 'open').mockImplementation((...args) => { if (committed) throw new Error('post-commit open'); return open(...args); });
    vi.spyOn(fs, 'lstat').mockImplementation((...args) => { if (committed) throw new Error('post-commit stat'); return lstat(...args); });
    vi.spyOn(fs, 'rename').mockImplementation((...args) => { if (committed) throw new Error('post-commit rename'); return rename(...args); });
    vi.spyOn(fs, 'unlink').mockImplementation(async (...args) => { await unlink(...args); committed = true; });
    await expect(new SessionPermissionStore(new AppLogService(), root).set('/project', 'session-1', 'full-access')).resolves.toBeUndefined();
    expect(committed).toBe(true);
  });

  it.each(['', '{bad-json', '{"version":2}', '{}', ' '.repeat(4097), foreignIntent])('refuses existing malformed or foreign intent %# without clearing or replaying it', async (contents) => {
    const root = await dataRoot();
    const marker = path.join(root, intentName);
    await writeFile(marker, contents);
    const store = new SessionPermissionStore(new AppLogService(), root);
    await expect(store.get('/project', 'session-1')).rejects.toThrow(/write intent/);
    await expect(store.set('/project', 'session-1', 'full-access')).rejects.toThrow(/write intent/);
    await expect(store.delete('/project', 'session-1')).rejects.toThrow(/write intent/);
    expect(await readFile(marker, 'utf8')).toBe(contents);
    await expect(fs.lstat(path.join(root, 'session-permissions.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses unreadable and non-regular intent files', async () => {
    const root = await dataRoot();
    const marker = path.join(root, intentName);
    await writeFile(marker, foreignIntent);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation((...args) => {
      if (args[0] === marker) return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
      return open(...args);
    });
    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'session-1')).rejects.toThrow(/write intent is unreadable or corrupt/);
    vi.restoreAllMocks();
    await rm(marker);
    await mkdir(marker);
    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'session-1')).rejects.toThrow(/write intent is unreadable or corrupt/);
  });

  it('does not remove an intent replaced by another owner before commit', async () => {
    const root = await dataRoot();
    const marker = path.join(root, intentName);
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => { await rename(...args); await writeFile(marker, foreignIntent); });
    await expect(new SessionPermissionStore(new AppLogService(), root).set('/project', 'session-1', 'full-access')).rejects.toThrow(/storage failed/);
    expect(await readFile(marker, 'utf8')).toBe(foreignIntent);
    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'session-1')).rejects.toThrow(/write intent/);
  });

  it('checks for foreign intent even after the grant state was cached', async () => {
    const root = await dataRoot();
    const marker = path.join(root, intentName);
    const store = new SessionPermissionStore(new AppLogService(), root);
    await store.set('/project', 'session-1', 'edit');
    await writeFile(marker, foreignIntent);
    await expect(store.get('/project', 'session-1')).rejects.toThrow(/write intent/);
    await fs.unlink(marker);
    await expect(store.set('/project', 'session-1', 'full-access')).rejects.toThrow(/write intent/);
  });
});
