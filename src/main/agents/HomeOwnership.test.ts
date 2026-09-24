import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeOwnership } from './HomeOwnership';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agents-home-')));
  roots.push(root);
  const projectPath = path.join(root, 'project');
  await fs.mkdir(projectPath);
  return { root, owner: { agentId: randomUUID(), revision: 1, instructions: 'Original persona.', projectPath } };
}

describe('D0-03 supported SDK home ownership proof', () => {
  it('demonstrates that normal new-session metadata alone is not durable before an assistant response', async () => {
    const { root, owner } = await fixture();
    const manager = SessionManager.create(owner.projectPath, path.join(root, 'ordinary'));
    manager.appendCustomEntry('fate-agent-home-v1', owner);
    manager.appendSessionInfo('Agent home');
    await expect(fs.stat(manager.getSessionFile()!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('durably initializes through the public empty-file open path, without a fabricated assistant', async () => {
    const { root, owner } = await fixture();
    const directory = path.join(root, 'homes');
    const first = await new HomeOwnership(directory).open(owner);
    const resumed = await new HomeOwnership(directory).open({ ...owner, revision: 2, instructions: 'Changed persona.' });
    expect(resumed).toEqual(first);
    const manager = SessionManager.open(first.file, directory, owner.projectPath);
    expect(manager.buildSessionContext().messages).toEqual([]);
    expect(manager.getEntries()).toEqual([expect.objectContaining({ type: 'custom', data: owner })]);
    // Names, disable and delete operate on definitions, not the retained ownership file.
    expect(await fs.readFile(first.file, 'utf8')).toContain(owner.agentId);
    expect(first.appliedRevision).toBe(1);
  });

  it('prevents concurrent initializers from producing duplicate durable homes', async () => {
    const { root, owner } = await fixture();
    const directory = path.join(root, 'homes');
    const results = await Promise.allSettled([new HomeOwnership(directory).open(owner), new HomeOwnership(directory).open(owner)]);
    expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect((await fs.readdir(directory)).filter((name) => name.endsWith('.jsonl'))).toEqual([`${owner.agentId}.jsonl`]);
    const fulfilled = results.find((result) => result.status === 'fulfilled');
    if (fulfilled?.status !== 'fulfilled') throw new Error('No initializer succeeded.');
    expect(await new HomeOwnership(directory).open(owner)).toEqual(fulfilled.value);
  });

  it('rejects a session copied from another Agent and retains its bytes', async () => {
    const { root, owner } = await fixture();
    const directory = path.join(root, 'homes');
    const first = await new HomeOwnership(directory).open(owner);
    const other = { ...owner, agentId: randomUUID() };
    const target = path.join(directory, `${other.agentId}.jsonl`);
    await fs.copyFile(first.file, target);
    const original = await fs.readFile(target, 'utf8');
    await expect(new HomeOwnership(directory).open(other)).rejects.toThrow(/another Agent/);
    expect(await fs.readFile(target, 'utf8')).toBe(original);
  });

  it('blocks disabled/deleted Agent actions while retaining the home byte-for-byte', async () => {
    const { root, owner } = await fixture();
    const homes = new HomeOwnership(path.join(root, 'homes'));
    const home = await homes.open(owner);
    const source = await fs.readFile(home.file, 'utf8');
    await expect(homes.open(owner, { enabled: false, deleted: false })).rejects.toThrow(/retained/);
    await expect(homes.open(owner, { enabled: false, deleted: true })).rejects.toThrow(/retained/);
    expect(await fs.readFile(home.file, 'utf8')).toBe(source);
    expect(await homes.open(owner)).toEqual(home);
  });

  it('ignores and preserves interrupted temporary bootstraps without creating duplicate visible homes', async () => {
    const { root, owner } = await fixture();
    const directory = path.join(root, 'homes');
    await fs.mkdir(directory);
    const interrupted = path.join(directory, `${randomUUID()}.tmp`);
    await fs.writeFile(interrupted, '');
    const manager = SessionManager.open(interrupted, directory, owner.projectPath);
    manager.appendCustomEntry('fate-agent-home-v1', owner);
    const bytes = await fs.readFile(interrupted, 'utf8');
    const home = await new HomeOwnership(directory).open(owner);
    expect(await fs.readFile(interrupted, 'utf8')).toBe(bytes);
    expect((await fs.readdir(directory)).filter((file) => file.endsWith('.jsonl'))).toEqual([`${owner.agentId}.jsonl`]);
    expect(home.sessionId).not.toBe(manager.getSessionId());
  });

  it('preserves real SDK conversation context and original instructions across restart', async () => {
    const { root, owner } = await fixture();
    const directory = path.join(root, 'homes');
    const first = await new HomeOwnership(directory).open(owner);
    SessionManager.open(first.file, directory, owner.projectPath).appendMessage({ role: 'user', content: 'First durable turn.', timestamp: 1 });
    const resumed = await new HomeOwnership(directory).open({ ...owner, revision: 2, instructions: 'Do not rewrite old context.' });
    const manager = SessionManager.open(resumed.file, directory, owner.projectPath);
    expect(manager.buildSessionContext().messages).toEqual([expect.objectContaining({ role: 'user', content: 'First durable turn.' })]);
    expect(manager.getEntries().find((entry) => entry.type === 'custom')).toMatchObject({ data: { instructions: owner.instructions, revision: 1 } });
    expect(resumed.sessionId).toBe(first.sessionId);
  });

  it('reopens legitimate mature homes beyond the old 8 MiB prototype cap', async () => {
    const { root, owner } = await fixture();
    const directory = path.join(root, 'homes');
    const homes = new HomeOwnership(directory);
    const home = await homes.open(owner);
    SessionManager.open(home.file, directory, owner.projectPath).appendCustomEntry('large-history-fixture', { content: 'x'.repeat(9 * 1024 * 1024) });
    expect(await homes.open(owner)).toEqual(home);
  });

  it('does not silently reconstruct empty/corrupt ownership after a crash', async () => {
    const { root, owner } = await fixture();
    const directory = path.join(root, 'homes');
    await fs.mkdir(directory);
    const target = path.join(directory, `${owner.agentId}.jsonl`);
    await fs.writeFile(target, '');
    await expect(new HomeOwnership(directory).open(owner)).rejects.toThrow(/ambiguous/);
    expect(await fs.readFile(target, 'utf8')).toBe('');
  });

  it('requires an exactly matching saved session before product homes lose their ordinary-session fallback', async () => {
    const { root, owner } = await fixture();
    const directory = path.join(root, 'homes');
    const preset = { schemaVersion: 1 as const, agentId: owner.agentId, revision: 1, name: 'Reviewer', instructions: owner.instructions, skillRefs: [], defaults: { model: null, permission: 'read-only' as const, thinkingLevel: 'high' as const, workspace: 'shared' as const }, background: false, runId: null as null, projectPath: owner.projectPath };
    const home = await new HomeOwnership(directory).open({ ...owner, preset });
    const source = await fs.readFile(home.file, 'utf8');
    const tampered = source.split('\n').filter((line) => !line.includes('fate-saved-agent-v1')).join('\n');
    expect(tampered).not.toBe(source);
    await fs.writeFile(home.file, tampered);
    await expect(new HomeOwnership(directory).open({ ...owner, preset }, { enabled: true, deleted: false, requirePreset: true })).rejects.toThrow(/missing or corrupt/);
    expect(await fs.readFile(home.file, 'utf8')).toBe(tampered);
    await expect(new HomeOwnership(directory).open(owner, { enabled: true, deleted: false, requirePreset: true })).rejects.toThrow(/missing or corrupt/);
  });

  it('recovers a dead writer home lock instead of blocking future opens forever', async () => {
    const { spawn } = await import('node:child_process');
    const { root, owner } = await fixture();
    const directory = path.join(root, 'homes');
    await fs.mkdir(directory);
    const dead = spawn(process.execPath, ['--version'], { stdio: 'ignore' });
    await new Promise<void>((resolve) => dead.on('exit', () => resolve()));
    await fs.writeFile(path.join(directory, `${owner.agentId}.jsonl.lock`), JSON.stringify({ token: 'stale', pid: dead.pid, host: os.hostname() }));
    const home = await new HomeOwnership(directory).open(owner);
    expect(home.sessionId).toBeTruthy();
    expect(await fs.readdir(directory).then((names) => names.filter((name) => name.endsWith('.lock')))).toEqual([]);
  });

  it('refuses to steal a live writer home lock', async () => {
    const { root, owner } = await fixture();
    const directory = path.join(root, 'homes');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, `${owner.agentId}.jsonl.lock`), JSON.stringify({ token: 'live', pid: process.pid, host: os.hostname() }));
    await expect(new HomeOwnership(directory).open(owner)).rejects.toThrow(/already in progress/);
    expect(await fs.readFile(path.join(directory, `${owner.agentId}.jsonl.lock`), 'utf8')).toContain('live');
  });
});
