import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsSync from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DefaultResourceLoader, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createSdkChildSession } from '../../src/main/pi/SubagentSessionFactory';
import { createAgentExecution } from '../../src/main/agents/AgentExecutor';
import { HomeOwnership } from '../../src/main/agents/HomeOwnership';
import { AgentRepository } from '../../src/main/agents/AgentRepository';
import { ApprovalGate } from '../../src/main/agents/ApprovalGate';
import type { SavedAgentSession } from '../../src/shared/contracts/agents';
import { createDesktopFatePaths } from '../../src/core/FatePaths';
import { createServerProfile } from '../../src/core/storage/ServerProfile';
import { createPiSdkAdapter } from '../../src/main/pi/PiRuntimeService';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const home = path.join(privateTestRoot(), 'home');
const globalSkill = path.join(home, '.agents', 'skills', 'desktop-sentinel');
const name = 'desktop-sentinel';
const physical = path.join(privateTestRoot(), 'different-physical-home');
const physicalSkill = path.join(physical, '.agents', 'skills', 'physical-ancestor');

async function auditedAccess<T>(work: (accesses: string[]) => Promise<T>): Promise<T> {
  const accesses: string[] = [];
  const targets = [path.join(home, '.agents', 'skills'), path.join(physical, '.agents', 'skills'), path.join(physical, 'AGENTS.md')];
  const inspect = (input: fsSync.PathLike, operation: string) => {
    const value = path.resolve(String(input));
    for (const target of targets) {
      const relative = path.relative(target, value);
      if (relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) accesses.push(`${operation}:${value}`);
    }
  };
  const exists = fsSync.existsSync;
  const readdir = fsSync.readdirSync;
  const existsSpy = vi.spyOn(fsSync, 'existsSync').mockImplementation((input) => { inspect(input, 'exists'); return exists(input); });
  const readdirSpy = vi.spyOn(fsSync, 'readdirSync').mockImplementation((input, options) => {
    inspect(input, 'readdir');
    return readdir(input, options);
  });
  syncBuiltinESMExports();
  try { return await work(accesses); }
  finally { existsSpy.mockRestore(); readdirSpy.mockRestore(); syncBuiltinESMExports(); }
}

beforeEach(async () => { await mkdir(path.join(home, '.git'), { recursive: true }); });
afterEach(async () => {
  await rm(path.join(home, '.agents'), { recursive: true, force: true });
  await rm(path.join(home, '.git'), { recursive: true, force: true });
  await rm(physical, { recursive: true, force: true });
});

describe('real Pi SDK global HOME resource policy', () => {
  it('does not enumerate synthetic HOME or a different physical ancestor above registered cwd', async () => {
    expect(process.env.PI_OFFLINE).toBe('1');
    await mkdir(globalSkill, { recursive: true });
    await writeFile(path.join(globalSkill, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic global skill.\n---\nDesktop only.\n`);
    await mkdir(physicalSkill, { recursive: true });
    await writeFile(path.join(physicalSkill, 'SKILL.md'), '---\nname: physical-ancestor\ndescription: Synthetic different host home.\n---\nDo not load.\n');
    const project = path.join(physical, 'registered-project');
    const projectSkill = path.join(project, '.agents', 'skills', 'local-skill');
    await mkdir(projectSkill, { recursive: true });
    await writeFile(path.join(projectSkill, 'SKILL.md'), '---\nname: local-skill\ndescription: Local registered project.\n---\nLocal.\n');
    // No .git boundary. HOME and this synthetic physical ancestor differ.
    const pi = path.join(privateTestRoot(), 'isolated-pi-for-ancestor');
    const server = await createServerProfile({ home, profileId: 'ancestor-probe' });
    await auditedAccess(async (accesses) => {
      const loader = new DefaultResourceLoader({ cwd: project, agentDir: pi,
        settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
        includeHomeAgentSkills: false, noExtensions: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
      await loader.reload();
      const names = loader.getSkills().skills.map((skill) => skill.name);
      expect(names).toContain('local-skill');
      expect(names).not.toContain('physical-ancestor');
      expect(names).not.toContain(name);
      expect(accesses).toEqual([]);
    });
    await auditedAccess(async (accesses) => {
      const adapter = createPiSdkAdapter(server);
      const runtime = await adapter.createRuntime(project, await adapter.createModelRuntime(), true);
      try {
        const names = runtime.session.resourceLoader.getSkills().skills.map((skill) => skill.name);
        expect(names).toContain('local-skill');
        expect(names).not.toContain('physical-ancestor');
        expect(names).not.toContain(name);
        expect(accesses).toEqual([]); // Includes Fate's extension preflight before SDK reload.
      } finally { await runtime.dispose(); }
    });
    await auditedAccess(async (accesses) => {
      const controlProject = path.join(home, 'bounded-desktop-control');
      await mkdir(controlProject, { recursive: true });
      const loader = new DefaultResourceLoader({ cwd: controlProject, agentDir: pi,
        settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
        noExtensions: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
      await loader.reload();
      expect(loader.getSkills().skills.map((skill) => skill.name)).toContain(name);
      expect(accesses.some((entry) => entry.includes(path.join(home, '.agents', 'skills')))).toBe(true);
    });
  });
  it('keeps desktop discovery by default but excludes HOME/.agents/skills before server discovery', async () => {
    await mkdir(globalSkill, { recursive: true });
    await writeFile(path.join(globalSkill, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic isolated HOME skill.\n---\n\nSentinel only.\n`);
    const workspace = path.join(home, 'sdk-resource-workspace');
    const pi = path.join(privateTestRoot(), 'sdk-resource-agent');
    await mkdir(path.join(workspace, '.agents', 'skills', 'project-sentinel'), { recursive: true });
    await writeFile(path.join(workspace, '.agents', 'skills', 'project-sentinel', 'SKILL.md'), '---\nname: project-sentinel\ndescription: Project-only synthetic skill.\n---\n\nProject.\n');
    const load = async (includeHomeAgentSkills?: boolean) => {
      const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
      const loader = new DefaultResourceLoader({ cwd: workspace, agentDir: pi, settingsManager,
        noExtensions: true, noThemes: true, noPromptTemplates: true,
        ...(includeHomeAgentSkills === undefined ? {} : { includeHomeAgentSkills }),
      });
      await loader.reload();
      return loader.getSkills().skills.map((skill) => skill.name);
    };
    expect(await load()).toContain(name);
    expect(await load(false)).not.toContain(name);
    expect(await load(false)).toContain('project-sentinel');
  });

  it('uses immutable profile kind, not a misleading ID, in real root loaders', async () => {
    expect(process.env.PI_OFFLINE).toBe('1');
    await mkdir(globalSkill, { recursive: true });
    await writeFile(path.join(globalSkill, 'SKILL.md'), `---\nname: ${name}\ndescription: Isolated sentinel.\n---\nDesktop only.\n`);
    const project = path.join(home, 'policy-project');
    await mkdir(project, { recursive: true });
    const desktop = createDesktopFatePaths({ profileId: 'renamed-desktop' });
    const server = await createServerProfile({ home, profileId: 'desktop' });
    for (const [paths, expected] of [[desktop, true], [server, false]] as const) {
      const adapter = createPiSdkAdapter(paths);
      const runtime = await adapter.createRuntime(project, await adapter.createModelRuntime(), true);
      try {
        expect(runtime.session.resourceLoader.getSkills().skills.some((skill) => skill.name === name)).toBe(expected);
      } finally { await runtime.dispose(); }
    }
  });

  it('omits HOME sentinel in a real child session and a scheduled-session resource loader', async () => {
    expect(process.env.PI_OFFLINE).toBe('1');
    await mkdir(globalSkill, { recursive: true });
    await writeFile(path.join(globalSkill, 'SKILL.md'), `---\nname: ${name}\ndescription: Isolated sentinel.\n---\nDesktop only.\n`);
    const project = path.join(physical, 'server-child-project');
    await mkdir(physicalSkill, { recursive: true });
    await writeFile(path.join(physicalSkill, 'SKILL.md'), '---\nname: physical-ancestor\ndescription: Never use this ancestor.\n---\nAncestor.\n');
    await writeFile(path.join(physical, 'AGENTS.md'), 'ANCESTOR_CONTEXT_MUST_NOT_BE_READ');
    const root = path.join(privateTestRoot(), 'sdk-server-children');
    const agentDir = path.join(root, 'pi');
    await mkdir(project, { recursive: true });
    await mkdir(root, { recursive: true });
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: null, allowModelNetwork: false });
    const model = modelRuntime.getModels()[0]!;
    await auditedAccess(async (accesses) => {
      const child = await createSdkChildSession({
        projectPath: project, agentDir, serverProfile: true, modelRuntime, model,
        thinkingLevel: 'off', permissionLevel: 'read-only', role: 'test-child', agentName: 'direct',
        profileSystemPrompt: '', toolNames: ['read'], skillMode: 'all', selectedSkills: [],
      });
      try {
        const names = child.resourceLoader.getSkills().skills.map((skill) => skill.name);
        expect(names).not.toContain(name);
        expect(names).not.toContain('physical-ancestor');
        expect(accesses).toEqual([]);
      } finally { child.dispose(); }
    });

    await modelRuntime.setRuntimeApiKey('anthropic', 'local-test-not-a-provider-key');
    const preset: SavedAgentSession = {
      schemaVersion: 1, agentId: 'a392d8b9-76cc-4158-a381-1151ccf818fb', revision: 1,
      name: 'Synthetic', instructions: 'Synthetic offline scheduled session.', skillRefs: [],
      defaults: { model: { provider: 'anthropic', id: 'claude-sonnet-4-5' }, permission: 'read-only', thinkingLevel: 'off', workspace: 'shared' },
      background: true, runId: 'manual:synthetic', projectPath: project,
    };
    const homeSession = await new HomeOwnership(path.join(root, 'sessions')).open({
      agentId: preset.agentId, revision: 1, instructions: preset.instructions, projectPath: project, preset,
    });
    const context = () => ({ trusted: true, permission: 'read-only' as const,
      binding: { runId: 'manual:synthetic', definitionRevision: 1, taskRevision: 1, permissionRevision: 0, projectPath: project } });
    const repository = new AgentRepository(path.join(root, 'data'));
    await auditedAccess(async (accesses) => {
      const scheduled = await createAgentExecution({
        preset, sessionFile: homeSession.file, modelRuntime, context,
        approvals: new ApprovalGate(repository.approvalJournal(project), context, () => undefined),
        agentDir, serverProfile: true,
      });
      try {
        const names = scheduled.resourceLoader.getSkills().skills.map((skill) => skill.name);
        expect(names).not.toContain(name);
        expect(names).not.toContain('physical-ancestor');
        expect(accesses).toEqual([]);
      } finally { scheduled.dispose(); }
    });
  });
});
