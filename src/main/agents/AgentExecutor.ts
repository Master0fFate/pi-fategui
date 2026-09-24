import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager,
  type AgentSession, type ModelRuntime, type Skill, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { SavedAgentSession } from '../../shared/contracts/agents';
import { createProjectConfinedTools, type ProjectToolAccess } from '../pi/PiToolPolicy';
import { ApprovalGate, type ApprovalContext } from './ApprovalGate';

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function validateAgentSkills(skills: readonly Skill[], projectPath: string): Promise<void> {
  const roots = await Promise.all([projectPath, getAgentDir(), path.join(os.homedir(), '.agents', 'skills')].map((root) => fs.realpath(root).catch(() => null)));
  for (const skill of skills) {
    const [file, directory, stat] = await Promise.all([fs.realpath(skill.filePath), fs.realpath(skill.baseDir), fs.stat(skill.filePath)]);
    if (!stat.isFile() || stat.size > 65_536 || !inside(directory, file) || !roots.some((root) => root && inside(root, directory))) throw new Error(`Skill ${skill.name} is outside trusted resource roots or exceeds 64 KiB.`);
  }
}

export type AgentExecutionHandle = Pick<AgentSession, 'sessionId' | 'messages' | 'prompt' | 'abort' | 'dispose'>;
export interface AgentExecutionInput {
  preset: SavedAgentSession;
  sessionFile: string;
  modelRuntime: ModelRuntime;
  context: () => ApprovalContext;
  approvals: ApprovalGate;
  approvedSkills?: readonly Skill[];
  contextPrompts?: readonly string[];
  validate?: () => Promise<void>;
}
export async function createAgentExecution(input: AgentExecutionInput): Promise<AgentSession> {
  const { preset, modelRuntime } = input;
  const live = input.context();
  if (!live.trusted) throw new Error('Agent execution requires the current trusted project.');
  const selected = preset.defaults.model;
  const model = selected ? (await modelRuntime.getAvailable()).find((candidate) => candidate.provider === selected.provider && candidate.id === selected.id) : undefined;
  if (!model) throw new Error('Agent model is unavailable or unauthenticated; no fallback was used.');
  const sourceSettings = SettingsManager.create(preset.projectPath, getAgentDir(), { projectTrusted: true });
  // SDK resource resolution can install missing packages even with noExtensions.
  // A background turn may consume vetted local Skills, never install or reload code.
  const settingsManager = SettingsManager.inMemory({ ...sourceSettings.getGlobalSettings(), ...sourceSettings.getProjectSettings(), packages: [], extensions: [], skills: [], prompts: [], themes: [], retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: preset.projectPath, agentDir: getAgentDir(), settingsManager,
    noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, noSkills: true,
    skillsOverride: () => ({ skills: [...(input.approvedSkills ?? [])].filter((skill) => preset.skillRefs.includes(skill.name)), diagnostics: [] }),
    systemPrompt: '', appendSystemPrompt: [],
    appendSystemPromptOverride: () => [...(input.contextPrompts ?? []), `Saved Agent ${preset.name}, definition revision ${preset.revision}.\n${preset.instructions}`],
  });
  await loader.reload();
  const skills = loader.getSkills().skills;
  await validateAgentSkills(skills, preset.projectPath);
  if (preset.skillRefs.some((name) => !skills.some((skill) => skill.name === name))) throw new Error('A selected Agent Skill is unavailable. No substitute was loaded.');
  const permission = () => input.context().permission === 'read-only' || preset.defaults.permission === 'read-only' ? 'read-only' : 'edit';
  const access: ProjectToolAccess = { fullAccess: false, get permissionLevel() { return permission(); } };
  const readableRoots = await Promise.all(skills.map((skill) => fs.realpath(skill.baseDir)));
  const ordinary = await createProjectConfinedTools(preset.projectPath, access, readableRoots, { searchTools: true });
  const names = ['read', 'grep', 'find', 'ls', ...(preset.defaults.permission === 'edit' ? ['write', 'edit'] : [])];
  const tools = (ordinary.filter((tool) => names.includes(tool.name)) as unknown as ToolDefinition[]).map((tool): ToolDefinition => {
    const original = tool.execute;
    return { ...tool, execute: async (callId, params, signal, update, context) => {
      await input.validate?.();
      if (!input.context().trusted) throw new Error('Project trust or the owning live session is no longer available.');
      const effect = async (approved: unknown) => {
        await input.validate?.();
        if (!input.context().trusted) throw new Error('Project trust or live session changed before the effect.');
        return original(callId, approved, signal, update, context);
      };
      if (preset.background && (tool.name === 'write' || tool.name === 'edit')) {
        const id = createHash('sha256').update(`${preset.runId}:${callId}`).digest('hex');
        return input.approvals.execute(id, tool.name, params, effect, signal);
      }
      return effect(params);
    } };
  });
  const { session } = await createAgentSession({
    cwd: preset.projectPath, agentDir: getAgentDir(), modelRuntime, model, thinkingLevel: preset.defaults.thinkingLevel,
    settingsManager, resourceLoader: loader, sessionManager: SessionManager.open(input.sessionFile, undefined, preset.projectPath),
    tools: names, customTools: tools as NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>['customTools']>,
  });
  session.setActiveToolsByName(names);
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = async (model, context, options) => {
    await input.validate?.();
    if (!input.context().trusted) throw new Error('Project trust or live session changed before the provider request.');
    return stream(model, context, options);
  };
  return session;
}
