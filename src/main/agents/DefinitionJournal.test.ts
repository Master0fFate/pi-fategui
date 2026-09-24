import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeDefinition, DefinitionJournal, encodeDefinition } from './DefinitionJournal';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agents-journal-')));
  roots.push(root);
  return { root, journal: new DefinitionJournal(path.join(root, 'definitions')) };
}
const draft = { metadata: { id: 'agent-1', name: 'Named', vendor: { enabled: false, nested: ['one', 2, null] }, '__unknown__': 'retained' }, body: '# Persona\n\nDo careful work.\n---\nBody delimiter.\n' };

describe('D0-01 append-only canonical Markdown proof', () => {
  it('round-trips known and nested unknown frontmatter and exact body bytes', () => {
    expect(decodeDefinition(encodeDefinition(draft))).toEqual(draft);
  });

  it('survives rename and restart without changing identity or unknown metadata', async () => {
    const { root, journal } = await fixture();
    const first = await journal.save('agent-1', null, draft);
    const renamed = await journal.save('agent-1', first, { ...draft, metadata: { ...first.metadata, name: 'Renamed' } });
    expect(await new DefinitionJournal(path.join(root, 'definitions')).read('agent-1')).toEqual(renamed);
    expect(renamed.metadata.id).toBe('agent-1');
    expect(renamed.metadata.vendor).toEqual(draft.metadata.vendor);
    expect((await fs.readdir(path.join(root, 'definitions', 'agent-1'))).filter((file) => file.endsWith('.md'))).toHaveLength(2);
  });

  it('rejects stale updates while preserving both the head and original source', async () => {
    const { journal } = await fixture();
    const first = await journal.save('agent-1', null, draft);
    const second = await journal.save('agent-1', first, { ...draft, body: 'new body' });
    await expect(journal.save('agent-1', first, draft)).rejects.toThrow(/conflict/i);
    expect(await journal.read('agent-1')).toEqual(second);
  });

  it('detects external edits even when the revision did not change; never overwrites their bytes', async () => {
    const { root, journal } = await fixture();
    const first = await journal.save('agent-1', null, draft);
    const source = path.join(root, 'definitions', 'agent-1', `${first.revision}-${first.digest}.md`);
    const changed = encodeDefinition({ ...draft, body: 'external edit' });
    await fs.writeFile(source, changed);
    await expect(journal.save('agent-1', first, draft)).rejects.toThrow(/conflict/i);
    const external = await journal.read('agent-1');
    expect(external?.body).toBe('external edit');
    await journal.save('agent-1', external, { ...draft, body: 'reviewed update' });
    expect(await fs.readFile(source, 'utf8')).toBe(changed);
  });

  it('admits only one concurrent writer across repository instances', async () => {
    const { root, journal } = await fixture();
    const other = new DefinitionJournal(path.join(root, 'definitions'));
    const results = await Promise.allSettled([journal.save('agent-1', null, draft), other.save('agent-1', null, { ...draft, body: 'other' })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await journal.read('agent-1'))?.revision).toBe(1);
  });

  it('fails closed on corrupt heads without replacing original bytes', async () => {
    const { root, journal } = await fixture();
    await journal.save('agent-1', null, draft);
    const head = path.join(root, 'definitions', 'agent-1', 'head.json');
    await fs.writeFile(head, '{broken');
    await expect(journal.read('agent-1')).rejects.toThrow();
    await expect(journal.save('agent-1', null, draft)).rejects.toThrow();
    expect(await fs.readFile(head, 'utf8')).toBe('{broken');
  });

  it('rejects traversal, linked directories, hardlinked source and unsupported frontmatter', async () => {
    const { root, journal } = await fixture();
    await expect(journal.read('../escape')).rejects.toThrow(/identity/i);
    await fs.mkdir(path.join(root, 'outside'));
    await fs.mkdir(path.join(root, 'definitions'));
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'definitions', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(journal.save('linked', null, draft)).rejects.toThrow(/linked/i);
    const first = await journal.save('agent-1', null, draft);
    await fs.link(path.join(root, 'definitions', 'agent-1', `1-${first.digest}.md`), path.join(root, 'outside', 'copy.md'));
    await expect(journal.read('agent-1')).rejects.toThrow(/unsafe/i);
    expect(() => decodeDefinition('---\nname: YAML not supported\n---\nbody')).toThrow();
    expect(() => encodeDefinition({ metadata: {}, body: 'x'.repeat(1024 * 1024) })).toThrow(/1 MiB/);
  });

  it('recovers an explicitly selected revision while preserving corrupt head and source bytes', async () => {
    const { root, journal } = await fixture();
    const first = await journal.save('agent-1', null, draft);
    const directory = path.join(root, 'definitions', 'agent-1');
    const corrupt = '{interrupted head';
    const headDigest = createHash('sha256').update(corrupt).digest('hex');
    await fs.writeFile(path.join(directory, 'head.json'), corrupt);
    const candidate = (await journal.recoveryCandidates('agent-1'))[0]!;
    expect(candidate.valid).toBe(true);
    await expect(journal.recoverHead('agent-1', 'wrong-preview', candidate)).rejects.toThrow(/changed/);
    await journal.recoverHead('agent-1', headDigest, candidate);
    expect(await journal.read('agent-1')).toMatchObject({ ...draft, revision: 2 });
    expect(await fs.readFile(path.join(directory, `head-backup-${headDigest}.json`), 'utf8')).toBe(corrupt);
    expect(await fs.readFile(path.join(directory, `1-${first.digest}.md`), 'utf8')).toBe(encodeDefinition(draft));
  });

  it('rejects changed/malformed recovery candidates without discarding any bytes', async () => {
    const { root, journal } = await fixture();
    const first = await journal.save('agent-1', null, draft);
    const directory = path.join(root, 'definitions', 'agent-1');
    const head = await fs.readFile(path.join(directory, 'head.json'), 'utf8');
    const headDigest = createHash('sha256').update(head).digest('hex');
    const candidate = (await journal.recoveryCandidates('agent-1'))[0]!;
    await fs.writeFile(path.join(directory, candidate.file), 'malformed external draft');
    await expect(journal.recoverHead('agent-1', headDigest, candidate)).rejects.toThrow(/candidate changed/);
    expect((await journal.recoveryCandidates('agent-1'))[0]?.valid).toBe(false);
    expect(await fs.readFile(path.join(directory, 'head.json'), 'utf8')).toBe(head);
    expect(first.revision).toBe(1);
  });

  it('recovers a lock only after exact preview matching and proven local writer death', async () => {
    const { root, journal } = await fixture();
    await journal.save('agent-1', null, draft);
    const lock = path.join(root, 'definitions', 'agent-1', 'writer.lock');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const alive = JSON.stringify({ token: 'live-owner', pid: process.pid, host: os.hostname() });
    await fs.writeFile(lock, alive);
    await expect(journal.recoverWriterLock('agent-1', hash(alive))).rejects.toThrow(/still alive/);
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    const dead = JSON.stringify({ token: 'dead-owner', pid: deadPid, host: os.hostname() });
    await fs.writeFile(lock, dead);
    await expect(journal.recoverWriterLock('agent-1', hash(alive))).rejects.toThrow(/changed/);
    await journal.recoverWriterLock('agent-1', hash(dead));
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await journal.read('agent-1'))?.metadata).toEqual(draft.metadata);
  });

  it('does not steal a crashed or sleeping writer lock', async () => {
    const { root, journal } = await fixture();
    await journal.save('agent-1', null, draft);
    const lock = path.join(root, 'definitions', 'agent-1', 'writer.lock');
    await fs.writeFile(lock, 'unknown-owner');
    await expect(journal.save('agent-1', await journal.read('agent-1'), draft)).rejects.toThrow(/locked/i);
    expect(await fs.readFile(lock, 'utf8')).toBe('unknown-owner');
  });
});
