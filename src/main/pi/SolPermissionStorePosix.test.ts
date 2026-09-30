// Copied from Sol's independent durability probe. The corrected regression
// tracks the actual grant rename (intent creation adds an earlier directory
// sync) and requires fresh-store refusal while the uncommitted intent remains.
// Simulates POSIX control flow on Windows; not a native power-loss test.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AppLogService } from '../logging/AppLogService';
import { SessionPermissionStore } from './SessionPermissionStore';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it('does not restore a higher grant after an error on directory fsync following rename', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sol-permission-posix-sync-'));
  roots.push(root);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!platform?.configurable) throw new Error('Cannot emulate POSIX directory fsync on this Node runtime');
  const open = fs.open.bind(fs);
  const rename = fs.rename.bind(fs);
  let escalation = false;
  let escalationRenamed = false;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  try {
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (args[0] === root && args[1] === 'r') {
        return {
          sync: async () => { if (escalationRenamed) throw new Error('synthetic directory fsync failure'); },
          close: async () => undefined,
        } as Awaited<ReturnType<typeof fs.open>>;
      }
      return open(...args);
    });
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      await rename(...args);
      if (escalation && args[1] === path.join(root, 'session-permissions.json')) escalationRenamed = true;
    });
    const store = new SessionPermissionStore(new AppLogService(), root);
    await store.set('/project', 'session-1', 'edit');
    escalation = true;
    await expect(store.set('/project', 'session-1', 'full-access')).rejects.toThrow(/storage failed/);
    expect(escalationRenamed).toBe(true);
    expect(await fs.readFile(path.join(root, 'session-permissions.json'), 'utf8')).toContain('full-access');
    await expect(store.get('/project', 'session-1')).rejects.toThrow(/storage failed/);
    const reloaded = new SessionPermissionStore(new AppLogService(), root);
    await expect(reloaded.get('/project', 'session-1')).rejects.toThrow(/write intent/);
    await expect(reloaded.set('/project', 'session-1', 'edit')).rejects.toThrow(/write intent/);
    expect((await fs.stat(path.join(root, 'session-permissions.intent.json'))).isFile()).toBe(true);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

it('does not replace the old grant when the intent directory entry cannot be flushed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sol-permission-intent-sync-'));
  roots.push(root);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!platform?.configurable) throw new Error('Cannot emulate POSIX directory fsync on this Node runtime');
  const open = fs.open.bind(fs);
  let failDirectorySync = false;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  try {
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (args[0] === root && args[1] === 'r') {
        return {
          sync: async () => { if (failDirectorySync) throw new Error('intent directory fsync failure'); },
          close: async () => undefined,
        } as Awaited<ReturnType<typeof fs.open>>;
      }
      return open(...args);
    });
    const store = new SessionPermissionStore(new AppLogService(), root);
    await store.set('/project', 'session-1', 'edit');
    const previous = await fs.readFile(path.join(root, 'session-permissions.json'), 'utf8');
    const rename = vi.spyOn(fs, 'rename');
    failDirectorySync = true;
    await expect(store.set('/project', 'session-1', 'full-access')).rejects.toThrow(/storage failed/);
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, 'session-permissions.json'), 'utf8')).toBe(previous);
    await expect(new SessionPermissionStore(new AppLogService(), root).get('/project', 'session-1')).rejects.toThrow(/write intent/);
  } finally { Object.defineProperty(process, 'platform', platform); }
});
