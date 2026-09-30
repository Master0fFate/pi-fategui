import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionProfileStore } from '../../src/main/connections/ConnectionProfileStore';
import { ConnectionProfileEditor } from '../../src/main/connections/ConnectionProfileEditor';

let root: string, credential: string, file: string;
const token = `fc1_${'a'.repeat(43)}`;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-editor-')); await fs.chmod(root, 0o700);
  credential = path.join(root, 'credential.json'); file = path.join(root, 'profiles.json'); await fs.writeFile(credential, token, { mode: 0o600 }); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const fields = () => ({ label: 'Linux host', hostId: randomUUID(), sshAlias: 'fate-fixture', remotePort: 47119,
  workspaceId: randomUUID(), workspaceGeneration: 1, trust: true });

describe('main-owned SSH profile editor', () => {
  it('returns only an opaque choice and saves metadata without copying the credential', async () => {
    const store = new ConnectionProfileStore(), editor = new ConnectionProfileEditor(store, file, async () => credential);
    const picked = await editor.pick(7, () => true);
    expect(Object.keys(picked!)).toEqual(['selectionId']);
    const result = await editor.save(7, () => true, { ...fields(), ...picked });
    expect(Object.keys(result).sort()).toEqual(['hostId', 'id', 'label']);
    const content = await fs.readFile(file, 'utf8');
    expect(content).not.toContain(token); expect(store.list()).toEqual([result]);
    expect(await (await ConnectionProfileStore.fromFile(file)).credential(result.id)).toBe(token);
    expect(await fs.readFile(credential, 'utf8')).toBe(token);
    await expect(editor.save(7, () => true, { ...fields(), ...picked })).rejects.toThrow();
  });
  it('fences the original document while its native picker is open', async () => {
    let live = true;
    const editor = new ConnectionProfileEditor(new ConnectionProfileStore(), file, async () => { live = false; return credential; });
    await expect(editor.pick(7, () => live)).rejects.toThrow();
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects another window or a replaced document before persistence', async () => {
    let live = true;
    const editor = new ConnectionProfileEditor(new ConnectionProfileStore(), file, async () => credential);
    const first = await editor.pick(7, () => live);
    await expect(editor.save(8, () => true, { ...fields(), ...first })).rejects.toThrow();
    const second = await editor.pick(7, () => live); live = false;
    await expect(editor.save(7, () => true, { ...fields(), ...second })).rejects.toThrow();
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('returns cancellation and replaces earlier opaque choices from the same window', async () => {
    const editor = new ConnectionProfileEditor(new ConnectionProfileStore(), file, async () => credential);
    const first = await editor.pick(7, () => true); await editor.pick(7, () => true);
    await expect(editor.save(7, () => true, { ...fields(), ...first })).rejects.toThrow();
    expect(await new ConnectionProfileEditor(new ConnectionProfileStore(), file, async () => null).pick(7, () => true)).toBeNull();
  });
  it('rejects private paths supplied by a renderer and requires explicit host trust', async () => {
    const editor = new ConnectionProfileEditor(new ConnectionProfileStore(), file, async () => credential);
    const picked = await editor.pick(7, () => true);
    await expect(editor.save(7, () => true, { ...fields(), ...picked, credentialRef: credential })).rejects.toThrow();
    await expect(editor.save(7, () => true, { ...fields(), ...picked, trust: false })).rejects.toThrow();
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a selected symbolic link and rechecks a changed credential at save', async () => {
    const link = path.join(root, 'alias.json'); await fs.symlink(credential, link);
    await expect(new ConnectionProfileEditor(new ConnectionProfileStore(), file, async () => link).pick(7, () => true)).rejects.toThrow();
    const editor = new ConnectionProfileEditor(new ConnectionProfileStore(), file, async () => credential);
    const picked = await editor.pick(7, () => true); await fs.writeFile(credential, 'invalid');
    await expect(editor.save(7, () => true, { ...fields(), ...picked })).rejects.toThrow();
  });
  it('does not publish a canceled save into its live store', async () => {
    const store = new ConnectionProfileStore();
    const { trust: _trust, ...storedFields } = fields();
    await expect(store.saveSsh({ ...storedFields, id: randomUUID(), approved: true, transport: 'ssh', credentialRef: credential }, file, () => false)).rejects.toThrow();
    expect(store.list()).toEqual([]); await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
