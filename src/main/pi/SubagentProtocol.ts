import { createHash } from 'node:crypto';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type {
  ModelInfo,
  PermissionLevel,
  SubagentBudget,
  SubagentNotification,
  SubagentRole,
  SubagentSkillMode,
  ThinkingLevel,
} from '../../shared/contracts/ipc';

export const DEFAULT_RUNNING_CONCURRENCY = 4;
export const DEFAULT_TIMEOUT_SECONDS = 0;
export const DEFAULT_MAILBOX_TTL_SECONDS = 5 * 60;
export const DEFAULT_MANAGE_WAIT_SECONDS = 10;

export const permissions = ['read-only', 'edit', 'full-access'] as const;
export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const childToolNames = ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash', 'generate_image'] as const;
export const skillModes = ['all', 'selected', 'none'] as const;
export const notificationModes = ['never', 'next-turn', 'immediate'] as const;
export const childTerminalStatuses = new Set(['completed', 'error', 'cancelled', 'timed-out', 'budget-exceeded', 'skipped', 'interrupted'] as const);

export type ParentModel = NonNullable<AgentSession['model']>;
export type ChildToolName = typeof childToolNames[number];
export type ModelSelection = { provider: string; id: string };

export interface RoutingPolicy {
  fallbackModels: ModelSelection[];
  maxAttempts: number;
}

export interface RequestedTask {
  task: string;
  agent?: string;
  role?: SubagentRole;
  permissionLevel: PermissionLevel;
  model?: ModelSelection;
  thinkingLevel?: ThinkingLevel;
  tools?: ChildToolName[];
  instructions?: string;
  skills: string[];
  skillMode: SubagentSkillMode;
  preloadSkills: boolean;
  timeoutMs: number;
  idleTimeoutMs?: number;
  mailboxTtlMs: number;
  notification: SubagentNotification;
  budget?: SubagentBudget;
  routing: RoutingPolicy;
}

export interface WorkflowNodeRequest extends RequestedTask {
  id: string;
  dependsOn: string[];
  includeDependencyResults: boolean;
  dependencyFailure: 'skip' | 'run';
}

export interface WorkflowStartRequest {
  nodes: WorkflowNodeRequest[];
  maxConcurrency: number;
  notification: SubagentNotification;
  budget?: SubagentBudget;
}

function stringEnum<T extends readonly string[]>(values: T, description: string, defaultValue?: T[number]) {
  return Type.Unsafe<T[number]>({
    type: 'string',
    enum: values,
    description,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  });
}

export const modelSelectionSchema = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 200, description: 'Exact authenticated Pi provider ID.' }),
  id: Type.String({ minLength: 1, maxLength: 500, description: 'Exact authenticated Pi model ID.' }),
}, { additionalProperties: false });

const budgetSchema = Type.Object({
  maxCostUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  maxInputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  maxTotalTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

const routingSchema = Type.Object({
  fallbackModels: Type.Optional(Type.Array(modelSelectionSchema, {
    description: 'Ordered exact fallback models. They are used only after a failed attempt and never inferred automatically.',
  })),
  maxAttempts: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
}, { additionalProperties: false });

export const taskOptions = {
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'Exact reusable agent selector from subagent_catalog. Omit for an unopinionated direct child.' })),
  role: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^[^\\u0000-\\u001F\\u007F]+$', description: 'Arbitrary delegated role label. Fate applies no built-in role policy or scenario behavior.' })),
  permission: Type.Optional(stringEnum(permissions, 'Child authority. It can only narrow the parent session authority.')),
  model: Type.Optional(modelSelectionSchema),
  thinkingLevel: Type.Optional(stringEnum(thinkingLevels, 'Independent reasoning effort. Non-reasoning models use off.')),
  tools: Type.Optional(Type.Array(stringEnum(childToolNames, 'Exact Fate-owned child tool to enable.'), {
    maxItems: childToolNames.length,
    description: 'Exact tool allowlist. It can narrow but never widen parent, permission, profile, or skill requirements.',
  })),
  instructions: Type.Optional(Type.String({ minLength: 1, description: 'User-controlled child system instructions, appended verbatim after the selected agent profile. Admission is based on the receiving model context window.' })),
  skills: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
    description: 'Exact Pi skill names. Selected skill bodies can be preloaded and are shown in run metadata.',
  })),
  skillMode: Type.Optional(stringEnum(skillModes, 'all exposes every discovered skill, selected exposes only skills, none disables skills.', 'all')),
  preloadSkills: Type.Optional(Type.Boolean({ default: true, description: 'Preload the complete selected SKILL.md bodies into the child system context.' })),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, description: 'Optional total wall-clock limit, including retries. Omit or use zero for no automatic runtime limit.' })),
  idleTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0, description: 'Optional no-observable-activity limit. Omit or use zero to disable it.' })),
  mailboxTtlSeconds: Type.Optional(Type.Number({ minimum: 0, description: 'Keep a successful managed child session available for follow-ups. Managed launches default softly to 300 seconds when omitted; workflow nodes are opt-in. Zero disables retention and any positive duration is accepted.' })),
  notifyParent: Type.Optional(stringEnum(notificationModes, 'never sends nothing; next-turn queues model-visible context; immediate also triggers or queues a parent turn.', 'never')),
  budget: Type.Optional(budgetSchema),
  routing: Type.Optional(routingSchema),
};

export const taskSchema = Type.Object({
  task: Type.String({ minLength: 1, description: 'Exact self-contained child task. Admission is based on the receiving model context window.' }),
  ...taskOptions,
}, { additionalProperties: false });

export const launchParameters = Type.Object({
  task: Type.Optional(Type.String({ minLength: 1 })),
  ...taskOptions,
  tasks: Type.Optional(Type.Array(taskSchema, { minItems: 1 })),
}, { additionalProperties: false });

const workflowNodeSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' }),
  dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }))),
  includeDependencyResults: Type.Optional(Type.Boolean({ default: false })),
  dependencyFailure: Type.Optional(stringEnum(['skip', 'run'] as const, 'skip prevents execution after a failed dependency; run executes anyway.', 'skip')),
  task: Type.String({ minLength: 1 }),
  ...taskOptions,
}, { additionalProperties: false });

export const workflowParameters = Type.Union([
  Type.Object({
    action: Type.Literal('start'),
    nodes: Type.Array(workflowNodeSchema, { minItems: 1 }),
    maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, default: DEFAULT_RUNNING_CONCURRENCY })),
    notifyParent: Type.Optional(stringEnum(notificationModes, 'Workflow-level notification after all nodes settle.', 'never')),
    budget: Type.Optional(budgetSchema),
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('list') }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('status'), workflowId: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('cancel'), workflowId: Type.String({ minLength: 1, maxLength: 100 }), reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('resume'), workflowId: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
]);

const runTarget = (description: string) => Type.String({
  minLength: 1,
  maxLength: 100,
  description: `${description} Prefer the stable @handle returned by launch/list; internal run IDs remain accepted for compatibility.`,
});

const managePageOptions = {
  offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Optional zero-based result offset for context-sized status pages.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Optional page size. No maximum is imposed; choose a size that fits the parent model context.' })),
};

export const manageParameters = Type.Union([
  Type.Object({ action: Type.Literal('list'), ...managePageOptions }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('status'),
    runIds: Type.Optional(Type.Array(runTarget('Child targets to inspect.'), { minItems: 1 })),
    ...managePageOptions,
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('wait'),
    runIds: Type.Array(runTarget('Child targets to wait for.'), { minItems: 1 }),
    until: Type.Optional(stringEnum(['any', 'all', 'activity'] as const, 'Return after any settles, all settle, or any selected run changes.', 'any')),
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, default: DEFAULT_MANAGE_WAIT_SECONDS })),
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('steer'), runId: runTarget('Active child target.'), instruction: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('retarget'),
    runId: runTarget('Child target to retarget.'),
    model: Type.Optional(modelSelectionSchema),
    thinkingLevel: Type.Optional(stringEnum(thinkingLevels, 'Reasoning effort for subsequent child turns.')),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('followup'),
    runId: runTarget('Retained child target.'),
    message: Type.String({ minLength: 1 }),
    model: Type.Optional(modelSelectionSchema),
    thinkingLevel: Type.Optional(stringEnum(thinkingLevels, 'Optional retarget before the follow-up.')),
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, description: 'Optional limit for this follow-up turn. Omit or use zero for no automatic runtime limit.' })),
    extendMailboxTtlSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('close'), runIds: Type.Array(runTarget('Retained child targets to close.'), { minItems: 1 }) }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('cancel'),
    runIds: Type.Array(runTarget('Live child targets to cancel.'), { minItems: 1 }),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  }, { additionalProperties: false }),
]);

export const catalogParameters = Type.Object({
  section: Type.Optional(stringEnum(['all', 'models', 'agents', 'skills', 'capabilities'] as const, 'Catalog section.', 'all')),
  query: Type.Optional(Type.String({ maxLength: 200 })),
  provider: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, default: 200 })),
}, { additionalProperties: false });

function normalizePermission(value: unknown): PermissionLevel {
  return typeof value === 'string' && (permissions as readonly string[]).includes(value) ? value as PermissionLevel : 'read-only';
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === 'string' && (thinkingLevels as readonly string[]).includes(value) ? value as ThinkingLevel : undefined;
}

export function normalizeModel(value: unknown): ModelSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { provider?: unknown; id?: unknown };
  if (typeof candidate.provider !== 'string' || typeof candidate.id !== 'string') return undefined;
  const provider = candidate.provider.trim();
  const id = candidate.id.trim();
  return provider && id && provider.length <= 200 && id.length <= 500 ? { provider, id } : undefined;
}

function normalizeSeconds(value: unknown, fallback: number | undefined): number | undefined | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) && rounded <= Math.floor(Number.MAX_SAFE_INTEGER / 1_000) ? rounded : null;
}

function normalizeBudget(value: unknown): SubagentBudget | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const budget: SubagentBudget = {};
  const numeric = [
    ['maxCostUsd', false],
    ['maxInputTokens', true],
    ['maxOutputTokens', true],
    ['maxTotalTokens', true],
    ['maxTurns', true],
  ] as const;
  for (const [key, integer] of numeric) {
    const item = candidate[key];
    if (item === undefined) continue;
    if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0 || (integer && !Number.isSafeInteger(item))) return null;
    budget[key] = item;
  }
  if (Object.keys(candidate).some((key) => !numeric.some(([known]) => known === key))) return null;
  return Object.keys(budget).length ? budget : undefined;
}

function normalizeTask(candidate: Record<string, unknown>, managed: boolean): RequestedTask | null {
  const task = candidate.task;
  if (typeof task !== 'string' || !task.trim()) return null;
  const timeoutSeconds = normalizeSeconds(candidate.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
  const idleTimeoutSeconds = normalizeSeconds(candidate.idleTimeoutSeconds, undefined);
  const mailboxTtlSeconds = normalizeSeconds(candidate.mailboxTtlSeconds, managed ? DEFAULT_MAILBOX_TTL_SECONDS : 0);
  if (timeoutSeconds === null || timeoutSeconds === undefined || idleTimeoutSeconds === null || mailboxTtlSeconds === null || mailboxTtlSeconds === undefined) return null;

  const agent = typeof candidate.agent === 'string' && candidate.agent.trim() && candidate.agent.length <= 100 ? candidate.agent.trim() : undefined;
  if (candidate.agent !== undefined && !agent) return null;
  const role = typeof candidate.role === 'string' && candidate.role.trim() && candidate.role.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(candidate.role) ? candidate.role.trim() : undefined;
  if (candidate.role !== undefined && !role) return null;
  const instructions = typeof candidate.instructions === 'string' && candidate.instructions.trim() ? candidate.instructions.trim() : undefined;
  if (candidate.instructions !== undefined && !instructions) return null;
  const model = normalizeModel(candidate.model);
  if (candidate.model !== undefined && !model) return null;
  const thinkingLevel = normalizeThinkingLevel(candidate.thinkingLevel);
  if (candidate.thinkingLevel !== undefined && !thinkingLevel) return null;

  let tools: ChildToolName[] | undefined;
  if (candidate.tools !== undefined) {
    if (!Array.isArray(candidate.tools)) return null;
    tools = [...new Set(candidate.tools.flatMap((tool): ChildToolName[] => typeof tool === 'string' && (childToolNames as readonly string[]).includes(tool) ? [tool as ChildToolName] : []))];
    if (tools.length !== candidate.tools.length) return null;
  }

  const skills = candidate.skills === undefined
    ? []
    : Array.isArray(candidate.skills)
      ? [...new Set(candidate.skills.flatMap((skill) => typeof skill === 'string' && skill.trim() && skill.trim().length <= 64 ? [skill.trim()] : []))]
      : [];
  if (candidate.skills !== undefined && (!Array.isArray(candidate.skills) || skills.length !== candidate.skills.length)) return null;
  const skillMode = typeof candidate.skillMode === 'string' && (skillModes as readonly string[]).includes(candidate.skillMode)
    ? candidate.skillMode as SubagentSkillMode
    : 'all';
  if (candidate.skillMode !== undefined && !(skillModes as readonly unknown[]).includes(candidate.skillMode)) return null;
  if (skillMode === 'none' && skills.length) return null;
  if (skillMode === 'selected' && !skills.length) return null;
  const preloadSkills = candidate.preloadSkills === undefined ? true : candidate.preloadSkills;
  if (typeof preloadSkills !== 'boolean') return null;

  const notification = typeof candidate.notifyParent === 'string' && (notificationModes as readonly string[]).includes(candidate.notifyParent)
    ? candidate.notifyParent as SubagentNotification
    : 'never';
  if (candidate.notifyParent !== undefined && !(notificationModes as readonly unknown[]).includes(candidate.notifyParent)) return null;
  const budget = normalizeBudget(candidate.budget);
  if (budget === null) return null;

  let routing: RoutingPolicy = { fallbackModels: [], maxAttempts: 1 };
  if (candidate.routing !== undefined) {
    if (!candidate.routing || typeof candidate.routing !== 'object' || Array.isArray(candidate.routing)) return null;
    const raw = candidate.routing as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !['fallbackModels', 'maxAttempts'].includes(key))) return null;
    const fallbackModels = raw.fallbackModels === undefined
      ? []
      : Array.isArray(raw.fallbackModels)
        ? raw.fallbackModels.flatMap((item) => normalizeModel(item) ? [normalizeModel(item)!] : [])
        : [];
    if (raw.fallbackModels !== undefined && (!Array.isArray(raw.fallbackModels) || fallbackModels.length !== raw.fallbackModels.length)) return null;
    const uniqueModels = [...new Map(fallbackModels.map((item) => [`${item.provider}\0${item.id}`, item])).values()];
    if (uniqueModels.length !== fallbackModels.length) return null;
    const maxAttempts = raw.maxAttempts === undefined ? 1 : raw.maxAttempts;
    if (!Number.isSafeInteger(maxAttempts) || (maxAttempts as number) < 1) return null;
    routing = { fallbackModels: uniqueModels, maxAttempts: maxAttempts as number };
  }

  return {
    task: task.trim(),
    ...(agent ? { agent } : {}),
    ...(role ? { role } : {}),
    permissionLevel: normalizePermission(candidate.permission),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(tools === undefined ? {} : { tools }),
    ...(instructions ? { instructions } : {}),
    skills,
    skillMode,
    preloadSkills,
    timeoutMs: timeoutSeconds * 1_000,
    ...(idleTimeoutSeconds === undefined ? {} : { idleTimeoutMs: idleTimeoutSeconds * 1_000 }),
    mailboxTtlMs: mailboxTtlSeconds * 1_000,
    notification,
    ...(budget ? { budget } : {}),
    routing,
  };
}

export function normalizeLaunchRequests(value: unknown, managed: boolean): RequestedTask[] | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const hasSingle = typeof input.task === 'string' && input.task.trim().length > 0;
  const hasParallel = Array.isArray(input.tasks) && input.tasks.length > 0;
  if (hasSingle === hasParallel) return null;
  const raw = hasSingle ? [{ ...input, task: input.task }] : input.tasks as unknown[];
  const requests = raw.flatMap((item) => item && typeof item === 'object' && !Array.isArray(item) ? [normalizeTask(item as Record<string, unknown>, managed)] : [null]);
  return requests.length && requests.every((item): item is RequestedTask => item !== null) ? requests : null;
}

export function normalizeWorkflowStart(value: unknown): WorkflowStartRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.action !== 'start' || !Array.isArray(input.nodes) || !input.nodes.length) return null;
  const nodes: WorkflowNodeRequest[] = [];
  for (const raw of input.nodes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const candidate = raw as Record<string, unknown>;
    const request = normalizeTask(candidate, false);
    const id = typeof candidate.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(candidate.id) && candidate.id.length <= 80 ? candidate.id : undefined;
    const dependsOn = candidate.dependsOn === undefined
      ? []
      : Array.isArray(candidate.dependsOn)
        ? [...new Set(candidate.dependsOn.flatMap((item) => typeof item === 'string' && item.length <= 80 ? [item] : []))]
        : [];
    if (!request || !id || (candidate.dependsOn !== undefined && (!Array.isArray(candidate.dependsOn) || dependsOn.length !== candidate.dependsOn.length))) return null;
    const includeDependencyResults = candidate.includeDependencyResults ?? false;
    const dependencyFailure = candidate.dependencyFailure ?? 'skip';
    if (typeof includeDependencyResults !== 'boolean' || !['skip', 'run'].includes(String(dependencyFailure))) return null;
    nodes.push({ ...request, id, dependsOn, includeDependencyResults, dependencyFailure: dependencyFailure as 'skip' | 'run' });
  }
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) return null;
  const ids = new Set(nodes.map((node) => node.id));
  if (nodes.some((node) => node.dependsOn.some((dependency) => !ids.has(dependency) || dependency === node.id))) return null;
  const dependentCounts = new Map(nodes.map((node) => [node.id, 0]));
  const dependents = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const node of nodes) {
    dependentCounts.set(node.id, node.dependsOn.length);
    for (const dependency of node.dependsOn) dependents.get(dependency)!.push(node.id);
  }
  const ready = nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id);
  let visited = 0;
  for (let index = 0; index < ready.length; index += 1) {
    const id = ready[index]!;
    visited += 1;
    for (const dependent of dependents.get(id)!) {
      const remaining = dependentCounts.get(dependent)! - 1;
      dependentCounts.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  if (visited !== nodes.length) return null;

  const maxConcurrency = input.maxConcurrency === undefined ? DEFAULT_RUNNING_CONCURRENCY : input.maxConcurrency;
  if (!Number.isSafeInteger(maxConcurrency) || (maxConcurrency as number) < 1) return null;
  const notification = typeof input.notifyParent === 'string' && (notificationModes as readonly string[]).includes(input.notifyParent)
    ? input.notifyParent as SubagentNotification
    : 'never';
  if (input.notifyParent !== undefined && !(notificationModes as readonly unknown[]).includes(input.notifyParent)) return null;
  const budget = normalizeBudget(input.budget);
  if (budget === null) return null;
  return { nodes, maxConcurrency: maxConcurrency as number, notification, ...(budget ? { budget } : {}) };
}

export function modelInfo(model: ParentModel): ModelInfo {
  return {
    provider: model.provider.slice(0, 200),
    id: model.id.slice(0, 500),
    name: model.name.slice(0, 500),
    reasoning: model.reasoning,
    contextWindow: Math.min(2_147_483_647, Math.max(1, Math.floor(model.contextWindow))),
    supportsImages: model.input?.includes('image') ?? false,
  };
}

export function modelKey(model: Pick<ParentModel, 'provider' | 'id'>): string {
  return `${model.provider}\0${model.id}`;
}

export function modelThinkingLevels(model: ParentModel): ThinkingLevel[] {
  if (!model.reasoning) return ['off'];
  return thinkingLevels.filter((level) => level === 'off' || model.thinkingLevelMap?.[level] !== null);
}

export function deterministicRunId(parentSessionId: string, toolCallId: string, index: number): string {
  const digest = createHash('sha256').update(`${parentSessionId}\0${toolCallId}\0${index}`).digest('hex').slice(0, 32);
  return `subagent-${digest}`;
}

export function deterministicWorkflowId(parentSessionId: string, toolCallId: string): string {
  const digest = createHash('sha256').update(`workflow\0${parentSessionId}\0${toolCallId}`).digest('hex').slice(0, 32);
  return `workflow-${digest}`;
}
