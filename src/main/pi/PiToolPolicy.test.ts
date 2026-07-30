import { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFindToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent';
import { createProjectConfinedTools, ProjectPathPolicy } from './PiToolPolicy';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pi-tool-policy-'));
  roots.push(parent);
  const project = path.join(parent, 'project');
  const outside = path.join(parent, 'outside');
  await mkdir(project);
  await mkdir(outside);
  await writeFile(path.join(project, 'inside.txt'), 'inside');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  return { parent, project, outside, policy: await ProjectPathPolicy.create(project) };
}

describe('ProjectPathPolicy', () => {
  it('allows existing and new paths inside the project', async () => {
    const { project, policy } = await fixture();
    expect(await policy.existing('inside.txt')).toBe(await realpath(path.join(project, 'inside.txt')));
    const target = await policy.writable('nested/new.txt');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'new');
    expect(await readFile(path.join(project, 'nested/new.txt'), 'utf8')).toBe('new');
  });

  it('rejects traversal, absolute outside paths, and symlink escapes', async () => {
    const { parent, project, outside, policy } = await fixture();
    await symlink(outside, path.join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(policy.existing('../outside/secret.txt')).rejects.toThrow(/active project/i);
    await expect(policy.existing(path.join(outside, 'secret.txt'))).rejects.toThrow(/active project/i);
    await expect(policy.existing('escape/secret.txt')).rejects.toThrow(/active project/i);
    await expect(policy.writable('escape/new.txt')).rejects.toThrow(/active project/i);
    expect(parent).toBeTruthy();
  });

  it('registers Bash so explicit Full access can activate command execution', async () => {
    const { project } = await fixture();
    const tools = await createProjectConfinedTools(project);

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['bash', 'read', 'write', 'edit', 'generate_image']));
  });

  it('offers project-confined discovery tools to isolated child agents without traversal', async () => {
    const { project } = await fixture();
    const tools = await createProjectConfinedTools(project, { fullAccess: false }, [], { searchTools: true });
    const findTool = tools.find((tool) => tool.name === 'find') as ReturnType<typeof createFindToolDefinition>;
    const lsTool = tools.find((tool) => tool.name === 'ls') as ReturnType<typeof createLsToolDefinition>;

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['grep', 'find', 'ls']));
    await expect(findTool.execute('find-safe', { pattern: '*.txt', path: '.' }, undefined, undefined, {} as never)).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining('inside.txt') })],
    });
    await expect(lsTool.execute('ls-safe', { path: '.' }, undefined, undefined, {} as never)).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining('inside.txt') })],
    });
    await expect(lsTool.execute('ls-escape', { path: '../outside' }, undefined, undefined, {} as never)).rejects.toThrow(/not found|project|read/i);
    await expect(findTool.execute('find-escape', { pattern: '../outside/**', path: '.' }, undefined, undefined, {} as never)).rejects.toThrow(/approved search directory/i);
  });

  it('refuses project-confined writes through multiply-linked files before truncation', async () => {
    const { project, outside } = await fixture();
    const outsideFile = path.join(outside, 'secret.txt');
    await link(outsideFile, path.join(project, 'linked.txt'));
    const tools = await createProjectConfinedTools(project);
    const writeTool = tools.find((tool) => tool.name === 'write') as ReturnType<typeof createWriteToolDefinition>;

    await writeTool.execute('write-safe', { path: 'inside.txt', content: 'updated safely' }, undefined, undefined, {} as never);
    expect(await readFile(path.join(project, 'inside.txt'), 'utf8')).toBe('updated safely');
    await expect(writeTool.execute('write-1', { path: 'linked.txt', content: 'overwritten' }, undefined, undefined, {} as never)).rejects.toThrow(/linked|replaced/i);
    expect(await readFile(outsideFile, 'utf8')).toBe('secret');
  });

  it('allows reads from discovered skill roots without allowing writes or sibling host files', async () => {
    const { project, outside } = await fixture();
    const skillRoot = path.join(outside, 'loaded-skill');
    const skillFile = path.join(skillRoot, 'SKILL.md');
    await mkdir(skillRoot);
    await writeFile(skillFile, '# Loaded skill');
    const policy = await ProjectPathPolicy.create(project, { fullAccess: false }, [skillRoot]);

    expect(await policy.readable(skillFile)).toBe(await realpath(skillFile));
    await expect(policy.readable(path.join(outside, 'secret.txt'))).rejects.toThrow(/loaded skill resources/i);
    await expect(policy.writable(skillFile)).rejects.toThrow(/active project/i);

    const tools = await createProjectConfinedTools(project, { fullAccess: false }, [skillRoot]);
    const readTool = tools.find((tool) => tool.name === 'read') as ReturnType<typeof createReadToolDefinition>;
    await expect(readTool.execute('read-skill', { path: skillFile }, undefined, undefined, {} as never)).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining('Loaded skill') })],
    });
  });

  it('rejects oversized reads before the SDK allocates the entire file', async () => {
    const { project } = await fixture();
    await writeFile(path.join(project, 'huge.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
    const tools = await createProjectConfinedTools(project);
    const readTool = tools.find((tool) => tool.name === 'read') as ReturnType<typeof createReadToolDefinition>;

    await expect(readTool.execute('read-huge', { path: 'huge.txt' }, undefined, undefined, {} as never)).rejects.toThrow(/limited.*8 MiB/i);
  });

  it('unlocks host paths only while explicit full access is active', async () => {
    const { project, outside } = await fixture();
    const access = { fullAccess: false };
    const policy = await ProjectPathPolicy.create(project, access);
    const outsideFile = path.join(outside, 'secret.txt');

    await expect(policy.existing(outsideFile)).rejects.toThrow(/active project/i);
    access.fullAccess = true;
    expect(await policy.existing(outsideFile)).toBe(await realpath(outsideFile));
    expect(await policy.writable(path.join(outside, 'new.txt'))).toBe(path.join(outside, 'new.txt'));
    access.fullAccess = false;
    await expect(policy.writable(path.join(outside, 'new.txt'))).rejects.toThrow(/active project/i);
  });
});
