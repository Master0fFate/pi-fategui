import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRepository } from './AgentRepository';
import { agentDraftSchema, taskTemplateDraftSchema, routineDraftSchema, type AgentDraft } from '../../shared/contracts/agents';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
export const agentDraft: AgentDraft = { scope: 'project', name: 'Reviewer', description: 'Review carefully', instructions: 'Be precise.', skillRefs: [], defaults: { model: null, thinkingLevel: 'high', permission: 'read-only', workspace: 'shared' }, enabled: true };
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agents-repository-')));
  roots.push(root);
  const project = { path: path.join(root, 'project'), trusted: true };
  await fs.mkdir(project.path);
  const repository = new AgentRepository(path.join(root, 'data'));
  return { root, project, repository };
}

describe('Agent Library contracts and trusted repositories', () => {
  it('validates boundaries without allowing task-to-system role conversion or authority widening', () => {
    expect(agentDraftSchema.parse(agentDraft)).toEqual(agentDraft);
    expect(() => agentDraftSchema.parse({ ...agentDraft, defaults: { ...agentDraft.defaults, permission: 'full-access' } })).toThrow();
    expect(() => agentDraftSchema.parse({ ...agentDraft, name: 'bad\nname' })).toThrow();
    expect(() => agentDraftSchema.parse({ ...agentDraft, instructions: 'x'.repeat(65_537) })).toThrow();
    expect(taskTemplateDraftSchema.parse({ scope: 'project', name: 'Task', prompt: 'x'.repeat(200_000), permissionCeiling: 'edit', enabled: true }).prompt).toHaveLength(200_000);
    expect(() => taskTemplateDraftSchema.parse({ scope: 'project', name: 'Task', prompt: 'x'.repeat(200_001), permissionCeiling: 'edit', enabled: true })).toThrow();
    expect(() => taskTemplateDraftSchema.parse({ scope: 'project', name: 'Task', prompt: 'Task', instructions: 'system', permissionCeiling: 'edit', enabled: true })).toThrow();
    expect(() => routineDraftSchema.parse({ name: 'Schedule', agentId: 'not-an-id', timeZone: 'bad', intervalMinutes: 0 })).toThrow();
  });

  it('keeps user and project scope separate, persists rename and rejects stale writes', async () => {
    const { root, project, repository } = await fixture();
    const created = await repository.saveAgent(project, { expected: null, value: agentDraft });
    const user = await repository.saveAgent(project, { expected: null, value: { ...agentDraft, scope: 'user', name: 'Global' } });
    const first = await repository.list(project);
    const expected = first.revisions[`agent:${created.id}`]!;
    await repository.saveAgent(project, { id: created.id, expected, value: { ...agentDraft, name: 'Renamed' } });
    await expect(repository.saveAgent(project, { id: created.id, expected, value: agentDraft })).rejects.toThrow(/conflict/);
    const restarted = new AgentRepository(path.join(root, 'data'));
    expect((await restarted.get(project, 'agent', created.id)).item.name).toBe('Renamed');
    const secondProject = { path: path.join(root, 'other'), trusted: true };
    await fs.mkdir(secondProject.path);
    expect((await restarted.list(secondProject)).agents.map((agent) => agent.id)).toEqual([user.id]);
    expect((await restarted.list(project)).diagnostics).toEqual([]);
  });

  it('preserves unknown frontmatter and refuses scope changes or duplicate names', async () => {
    const { project, repository } = await fixture();
    const created = await repository.saveAgent(project, { expected: null, value: agentDraft });
    const journal = repository.journal(project.path, 'project', 'agent');
    const original = (await journal.read(created.id))!;
    const externallyEdited = await journal.save(created.id, original, { metadata: { ...original.metadata, revision: 2, vendor: { nested: ['kept'] } }, body: original.body });
    await repository.saveAgent(project, { id: created.id, expected: { revision: externallyEdited.revision, digest: externallyEdited.digest }, value: { ...agentDraft, name: 'Renamed' } });
    expect((await repository.get(project, 'agent', created.id)).item.vendor).toEqual({ nested: ['kept'] });
    await expect(repository.saveAgent(project, { expected: null, value: { ...agentDraft, name: 'renamed' } })).rejects.toThrow(/already exists/);
    const updated = await repository.get(project, 'agent', created.id);
    await expect(repository.saveAgent(project, { id: created.id, expected: { revision: updated.snapshot.revision, digest: updated.snapshot.digest }, value: { ...agentDraft, scope: 'user' } })).rejects.toThrow(/Scope/);
  });

  it('retains independent state and home ownership on definition deletion', async () => {
    const { project, repository } = await fixture();
    const agent = await repository.saveAgent(project, { expected: null, value: agentDraft });
    const before = (await repository.get(project, 'agent', agent.id)).snapshot;
    await repository.updateState(agent.id, (state) => ({ ...state, homeSessionId: 'home', homeProjectPath: project.path, appliedRevision: 1 }));
    expect((await repository.get(project, 'agent', agent.id)).snapshot).toEqual(before);
    await repository.remove(project, 'agent', agent.id, before);
    expect((await repository.list(project)).agents).toEqual([]);
    expect(await repository.state(agent.id)).toMatchObject({ homeSessionId: 'home', appliedRevision: 1 });
    await expect(repository.get(project, 'agent', agent.id)).rejects.toThrow(/deleted/);
  });

  it('fails closed for untrusted paths, corrupt storage and linked scope directories', async () => {
    const { root, project, repository } = await fixture();
    await expect(repository.list({ ...project, trusted: false })).rejects.toThrow(/Trust/);
    const agent = await repository.saveAgent(project, { expected: null, value: agentDraft });
    const journal = repository.journal(project.path, 'project', 'agent');
    const original = (await journal.read(agent.id))!;
    await journal.save(agent.id, original, { metadata: { ...original.metadata, schemaVersion: 99, revision: 2 }, body: original.body });
    expect((await repository.list(project)).diagnostics).toHaveLength(1);
    await expect(repository.saveAgent(project, { expected: null, value: { ...agentDraft, name: 'Another' } })).rejects.toThrow(/diagnostics/);
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    const linked = path.join(root, 'linked');
    await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const unsafe = new AgentRepository(linked);
    await expect(unsafe.saveAgent(project, { expected: null, value: agentDraft })).rejects.toThrow(/Linked/);
  });

  it('serializes competing repository catalog writers rather than admitting duplicate names', async () => {
    const { root, project, repository } = await fixture();
    const other = new AgentRepository(path.join(root, 'data'));
    const results = await Promise.allSettled([repository.saveAgent(project, { expected: null, value: agentDraft }), other.saveAgent(project, { expected: null, value: agentDraft })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await repository.list(project)).agents).toHaveLength(1);
  });

  it('recovers a dead home ownership lock without stealing unknown or live locks', async () => {
    const { root, repository } = await fixture();
    const id = 'a392d8b9-76cc-4158-a381-1151ccf818fb';
    const lockDirectory = path.join(root, 'data', 'home-locks', id);
    await fs.mkdir(lockDirectory, { recursive: true });
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    await fs.writeFile(path.join(lockDirectory, 'writer.lock'), JSON.stringify({ token: 'dead', pid: deadPid, host: os.hostname() }));
    await expect(repository.withHomeLock(id, async () => 'opened')).resolves.toBe('opened');
    await fs.writeFile(path.join(lockDirectory, 'writer.lock'), JSON.stringify({ token: 'live', pid: process.pid, host: os.hostname() }));
    await expect(repository.withHomeLock(id, async () => 'blocked')).rejects.toThrow();
  });
});
