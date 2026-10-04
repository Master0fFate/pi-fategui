import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { initializeHostProfile, readHostProfile, writePrivateHostOutput } from '../../src/cli/profile';
import { adminRequestSchema, adminResponseSchema } from '../../src/server/admin/adminMethods';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))); });
describe('T45 isolated host contracts without a listener or provider calls', () => {
  it('explicit initialization starts no engine and records read-only trust outside provider storage', async () => {
    const root = await fs.mkdtemp(path.join(privateTestRoot(), 'host-profile-unit-')); roots.push(root);
    const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
    await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(workspace, { mode: 0o700 });
    await expect(initializeHostProfile({ profileId: 'host', home, workspace, trustAccepted: false })).rejects.toThrow('trust');
    const profile = await initializeHostProfile({ profileId: 'host', home, workspace, trustAccepted: true });
    const saved = await readHostProfile('host', home);
    expect(saved.config.maxPermission).toBe('read-only');
    expect(saved.config.flags).toEqual({ terminal: false, browser: false });
    expect(saved.config.statePersistence).toBeUndefined();
    await expect(fs.stat(profile.paths.dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(profile.paths.piAgentDir)).rejects.toMatchObject({ code: 'ENOENT' });
    const output = path.join(root, 'private-output'); await writePrivateHostOutput(output, 'synthetic');
    await expect(writePrivateHostOutput(output, 'replacement')).rejects.toThrow();
    expect(await fs.readFile(output, 'utf8')).toBe('synthetic');
  });

  it('persists explicit native storage and terminal opt-in without starting a writer or accepting missing warning/cap', async () => {
    const root = await fs.mkdtemp(path.join(privateTestRoot(), 'host-profile-opt-in-')); roots.push(root);
    const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
    await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(workspace, { mode: 0o700 });
    const input = { profileId: 'host', home, workspace, trustAccepted: true };
    await expect(initializeHostProfile({ ...input, manualTerminal: true, maxPermission: 'edit' })).rejects.toThrow();
    await expect(initializeHostProfile({ ...input, manualTerminal: true, acceptUnsandboxedShell: true })).rejects.toThrow();
    const profile = await initializeHostProfile({ ...input, statePersistence: 'native-durable', maxPermission: 'edit',
      manualTerminal: true, acceptUnsandboxedShell: true });
    const saved = await readHostProfile('host', home);
    expect(saved.config.statePersistence).toBe('native-durable');
    expect(saved.config.maxPermission).toBe('edit');
    expect(saved.config.flags).toEqual({ terminal: true, terminalWarningAccepted: true, browser: false });
    await expect(fs.stat(profile.paths.dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(profile.paths.piAgentDir)).rejects.toMatchObject({ code: 'ENOENT' });
    // Existing profiles are never rewritten by init, including authority reductions.
    await expect(initializeHostProfile(input)).rejects.toThrow();
    expect((await readHostProfile('host', home)).config.maxPermission).toBe('edit');
    const descriptor = path.join(path.dirname(profile.paths.dataRoot), 'server.json');
    const bytes = await fs.readFile(descriptor, 'utf8');
    await fs.writeFile(descriptor, bytes.replace('"terminalWarningAccepted": true', '"terminalWarningAccepted": false'));
    await expect(readHostProfile('host', home)).rejects.toThrow();
  });

  it('typed host catalog refuses caller authority, unrestricted methods and full runtime responses', () => {
    expect(adminRequestSchema.safeParse({ method: 'provider.start', input: { providerId: 'anthropic', method: 'api_key', role: 'owner' } }).success).toBe(false);
    expect(adminRequestSchema.safeParse({ method: 'provider.respond', input: { promptId: 'not-an-id', value: 'synthetic' } }).success).toBe(false);
    expect(adminRequestSchema.safeParse({ method: 'eval', input: { source: 'arbitrary' } }).success).toBe(false);
    expect(adminResponseSchema.safeParse({ method: 'provider.state', result: { status: 'idle', providers: [], providerId: null, providerName: null,
      method: null, prompt: null, message: null, deviceCode: null, messages: ['private project prompt'] } }).success).toBe(false);
  });
});
