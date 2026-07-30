import {
  type AgentSession,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  getDocsPath,
  getExamplesPath,
  getReadmePath,
} from '@earendil-works/pi-coding-agent';
import type {
  PermissionLevel,
  SubagentBudget,
  SubagentRole,
  SubagentSkillMode,
  SubagentUsage,
  ThinkingLevel,
} from '../../shared/contracts/ipc';
import { createProjectConfinedTools, type ProjectToolAccess } from './PiToolPolicy';
import { messageText } from './PiEventNormalizer';
import { filterSkillsForChild, type SelectedSubagentSkill } from './SubagentSkills';
import type { ChildToolName, ParentModel } from './SubagentProtocol';

const SUBAGENT_TOOL_NAMES = ['subagent', 'subagent_start', 'subagent_manage', 'subagent_catalog', 'subagent_workflow'] as const;

export interface ChildSessionInput {
  projectPath: string;
  modelRuntime: ModelRuntime;
  model: ParentModel;
  thinkingLevel: ThinkingLevel;
  permissionLevel: PermissionLevel;
  role: SubagentRole;
  agentName: string;
  profileSystemPrompt: string;
  instructions?: string;
  toolNames: ChildToolName[];
  skillMode: SubagentSkillMode;
  selectedSkills: SelectedSubagentSkill[];
}

export type SubagentChildSessionFactory = (input: ChildSessionInput) => Promise<AgentSession>;

function isolatedSettingsManager(projectPath: string): SettingsManager {
  const source = SettingsManager.create(projectPath, getAgentDir(), { projectTrusted: true });
  const snapshots: Record<'global' | 'project', string | undefined> = {
    global: JSON.stringify(source.getGlobalSettings()),
    project: JSON.stringify(source.getProjectSettings()),
  };
  const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
    withLock: (scope, operation) => {
      const next = operation(snapshots[scope]);
      if (next !== undefined) snapshots[scope] = next;
    },
  };
  return SettingsManager.fromStorage(storage, { projectTrusted: true });
}

export function subagentChildBoundary(
  role: SubagentRole,
  agentName: string,
  permissionLevel: PermissionLevel,
  toolNames: readonly ChildToolName[],
): string {
  return [
    'This is an isolated Fate UI child Pi session owned by its parent session.',
    `Delegated role label: ${role}. Agent profile: ${agentName}.`,
    `Enforced authority: ${permissionLevel}. Enabled tools: ${toolNames.join(', ') || 'none'}.`,
    'When the delegated task requests implementation and your authority permits it, perform the edits, commands, and verification directly; do not merely tell the parent how to repeat the work.',
    'Return only the result the parent needs. Exploration logs and intermediate tool output remain in this child session unless the task explicitly asks for them.',
    'Nested Fate subagent orchestration is unavailable in this child.',
  ].join('\n');
}

export async function createSdkChildSession(input: ChildSessionInput): Promise<AgentSession> {
  const settingsManager = isolatedSettingsManager(input.projectPath);
  const selectedNames = input.selectedSkills.map((skill) => skill.name);
  const appendSystemPrompt = [
    ...(input.profileSystemPrompt ? [input.profileSystemPrompt] : []),
    ...(input.instructions ? [input.instructions] : []),
    ...input.selectedSkills.flatMap((skill) => skill.content ? [`<pi-skill name="${skill.name}">\n${skill.content}\n</pi-skill>`] : []),
    subagentChildBoundary(input.role, input.agentName, input.permissionLevel, input.toolNames),
  ];
  const services = await createAgentSessionServices({
    cwd: input.projectPath,
    modelRuntime: input.modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      noThemes: true,
      noExtensions: true,
      noPromptTemplates: true,
      noContextFiles: false,
      appendSystemPrompt,
      skillsOverride: (base) => ({
        ...base,
        skills: filterSkillsForChild(base.skills, input.skillMode, selectedNames),
      }),
    },
  });
  const childSkillNames = new Set(services.resourceLoader.getSkills().skills.map((skill) => skill.name));
  const unavailable = selectedNames.filter((name) => !childSkillNames.has(name));
  if (unavailable.length && input.skillMode !== 'none') {
    throw new Error(`Selected Pi skills are unavailable in the isolated child resource set: ${unavailable.join(', ')}.`);
  }

  const access: ProjectToolAccess = { fullAccess: input.permissionLevel === 'full-access' };
  const confinedTools = await createProjectConfinedTools(
    input.projectPath,
    access,
    () => [
      getReadmePath(),
      getDocsPath(),
      getExamplesPath(),
      ...services.resourceLoader.getSkills().skills.map((skill) => skill.baseDir),
    ],
    { searchTools: true },
  );
  const created = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(input.projectPath),
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    tools: input.toolNames,
    excludeTools: [...SUBAGENT_TOOL_NAMES],
    customTools: confinedTools as unknown as NonNullable<Parameters<typeof createAgentSessionFromServices>[0]['customTools']>,
  });
  created.session.setActiveToolsByName(input.toolNames);
  return created.session;
}

export function emptyUsage(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function addUsage(left: SubagentUsage, right: SubagentUsage): SubagentUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cost: left.cost + right.cost,
    contextTokens: Math.max(left.contextTokens, right.contextTokens),
    turns: left.turns + right.turns,
  };
}

export function usageFromMessages(messages: readonly unknown[]): SubagentUsage {
  const usage = emptyUsage();
  for (const message of messages) {
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'assistant') continue;
    const value = message as {
      usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; totalTokens?: unknown; cost?: { total?: unknown } };
    };
    const item = value.usage;
    if (!item) continue;
    usage.turns += 1;
    if (typeof item.input === 'number' && item.input >= 0) usage.input += Math.floor(item.input);
    if (typeof item.output === 'number' && item.output >= 0) usage.output += Math.floor(item.output);
    if (typeof item.cacheRead === 'number' && item.cacheRead >= 0) usage.cacheRead += Math.floor(item.cacheRead);
    if (typeof item.cacheWrite === 'number' && item.cacheWrite >= 0) usage.cacheWrite += Math.floor(item.cacheWrite);
    if (typeof item.cost?.total === 'number' && item.cost.total >= 0) usage.cost += item.cost.total;
    if (typeof item.totalTokens === 'number' && item.totalTokens >= 0) usage.contextTokens = Math.floor(item.totalTokens);
  }
  return usage;
}

export function budgetViolation(usage: SubagentUsage, budget: SubagentBudget | undefined): string | undefined {
  if (!budget) return undefined;
  if (budget.maxCostUsd !== undefined && usage.cost > budget.maxCostUsd) return `cost $${usage.cost.toFixed(6)} exceeded $${budget.maxCostUsd.toFixed(6)}`;
  if (budget.maxInputTokens !== undefined && usage.input > budget.maxInputTokens) return `input tokens ${usage.input} exceeded ${budget.maxInputTokens}`;
  if (budget.maxOutputTokens !== undefined && usage.output > budget.maxOutputTokens) return `output tokens ${usage.output} exceeded ${budget.maxOutputTokens}`;
  if (budget.maxTotalTokens !== undefined && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > budget.maxTotalTokens) return `total tokens exceeded ${budget.maxTotalTokens}`;
  if (budget.maxTurns !== undefined && usage.turns > budget.maxTurns) return `turns ${usage.turns} exceeded ${budget.maxTurns}`;
  return undefined;
}

export function finalAssistant(messages: readonly unknown[]): { text: string; stopReason?: string; error?: string } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'assistant') continue;
    const value = message as { stopReason?: unknown; errorMessage?: unknown };
    return {
      text: messageText(message),
      ...(typeof value.stopReason === 'string' ? { stopReason: value.stopReason } : {}),
      ...(typeof value.errorMessage === 'string' ? { error: value.errorMessage } : {}),
    };
  }
  return { text: '' };
}

export function abortError(): Error {
  return Object.assign(new Error('Subagent operation cancelled.'), { name: 'AbortError' });
}

function disposeLateChild(session: AgentSession): void {
  void session.abort().catch(() => undefined).then(() => session.dispose()).catch(() => undefined);
}

export function awaitChildCreation(creation: Promise<AgentSession>, signal: AbortSignal): Promise<AgentSession> {
  if (signal.aborted) {
    void creation.then(disposeLateChild, () => undefined);
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    void creation.then(
      (session) => {
        signal.removeEventListener('abort', abort);
        if (cancelled) disposeLateChild(session);
        else resolve(session);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        if (!cancelled) reject(error);
      },
    );
  });
}
