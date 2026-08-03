import { randomUUID } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ToolDefinition,
  DefaultPackageManager,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  getDocsPath,
  getExamplesPath,
  getReadmePath,
  initTheme,
} from '@earendil-works/pi-coding-agent';
import type {
  AppError,
  ExtensionUiState,
  ModelInfo,
  PermissionLevel,
  PiEvent,
  ProjectState,
  PromptAcceptance,
  PromptInput,
  QueuedMessage,
  QueueMutationInput,
  QueueMutationResult,
  RuntimeMessage,
  RuntimeState,
  RuntimeTokenTelemetry,
  RuntimeTool,
  SessionAttention,
  SessionSummary,
  SubagentControlInput,
  SubagentParentLivenessReport,
  SubagentNotification,
  ThinkingLevel,
} from '../../shared/contracts/ipc';
import { PiEventBatcher } from './PiEventBatcher';
import { PiEventNormalizer, messageImages, messageText, safeText, subagentRunIds } from './PiEventNormalizer';
import { createToolProvenance } from './ToolProvenance';
import { expandMultipleSkillCommands, promoteInlineResourceCommand } from './PiInlineCommands';
import { createPiExtensionUiBridge, emptyExtensionUiState, type ExtensionNoticeLevel, type PiExtensionUiBridge } from './PiExtensionUi';
import { PiDesktopError, authRequiredError, normalizeError } from './errors';
import { PiSessionRepository, sessionDisplayTitle } from './PiSessionRepository';
import { PiSessionTitleGenerator, type SessionTitleGenerator } from './PiSessionTitleGenerator';
import { activeToolsForPermission, createProjectConfinedTools, type ProjectToolAccess } from './PiToolPolicy';
import { validatePromptImages } from './PiPromptImages';
import { appendProjectResourceContext, hasProjectResourceTags } from './ProjectResourceTags';
import { SubagentCoordinator } from './SubagentCoordinator';
import { createSdkChildSession } from './SubagentSessionFactory';
import type { ImageGenerationSettingsResolver } from './PiImageTool';
import { defaultImageGenerationSettings } from '../../shared/imageGeneration';
import { AgentTeamCoordinator } from './multi-agent/AgentTeamCoordinator';
import type { AgentTeamControlInput } from '../../shared/contracts/multiAgent';
import { InMemorySessionPermissionStore, type SessionPermissionPersistence } from './SessionPermissionStore';

export interface SessionDefaults {
  thinkingLevel: ThinkingLevel;
  defaultModel: string | null;
  agentTeamMode?: 'legacy' | 'v2';
}

export interface PiSdkAdapter {
  supportsClone?: boolean;
  createModelRuntime: () => Promise<ModelRuntime>;
  createRuntime: (cwd: string, modelRuntime: ModelRuntime, projectTrusted?: boolean, customTools?: ToolDefinition[], getImageGenerationSettings?: ImageGenerationSettingsResolver) => Promise<AgentSessionRuntime>;
}

const MAX_HYDRATED_HISTORY_ENTRIES = 5_000;
const MAX_HYDRATED_TIMELINE_ENTITIES = 5_000;
const MAX_HYDRATED_TEXT_CHARACTERS = 8 * 1024 * 1024;
const MAX_HYDRATED_IMAGE_CHARACTERS = 20_000_000;
const MAX_CONTEXT_FILE_BYTES = 256 * 1024;
const MAX_MESSAGE_CONTENT_BLOCKS = 1_000;
const MAX_QUEUED_MESSAGES = 100;
const MAX_LIVE_RUNTIME_SLOTS = 4;
const MAX_SESSION_ATTENTION_ENTRIES = 1_000;
const MAX_MANUAL_SESSION_NAME_CLAIMS = 5_000;
const MAX_COLD_PENDING_MODELS = 1_000;
const MAX_TOKEN_USAGE_HISTORY = 120;
const MAX_TOKEN_TELEMETRY_COST = 1_000_000_000;

type SessionModel = NonNullable<AgentSession['model']>;
interface StagedModel {
  token: string;
  model: SessionModel;
  info: ModelInfo;
}
interface StagedThinkingLevel {
  token: string;
  level: ThinkingLevel;
}
type QueuedMessageRecord = QueuedMessage & {
  transportText: string;
  boundModel?: StagedModel;
  boundThinkingLevel?: StagedThinkingLevel;
};

interface SessionAttentionRecord {
  value: SessionAttention | null;
  revision: number;
}

const MAX_LENGTH_CONTINUATIONS_PER_USER_TURN = 8;
const LENGTH_CONTINUATION_PROMPT = 'The previous assistant turn reached its output limit before completing the active user request. Continue the unfinished work from exactly where it stopped. Do not repeat completed work and do not wait for another user message.';

type SessionCustomMessage = Parameters<AgentSession['sendCustomMessage']>[0];
type ActiveCustomMessageDelivery = 'steer' | 'followUp';
type SessionTurnPhase = 'idle' | 'active' | 'ending';
interface DeferredChildMessage {
  message: SessionCustomMessage;
  activeDelivery: ActiveCustomMessageDelivery;
}

interface RuntimeSlot {
  runtime: AgentSessionRuntime;
  projectGeneration: number;
  sessionGeneration: number;
  sessionInvalidated: boolean;
  boundSession: AgentSession | null;
  bindingSession: AgentSession | null;
  bindingPromise: Promise<void> | null;
  unsubscribeSession: (() => void) | null;
  disposeModelBoundary: (() => void) | null;
  normalizer: PiEventNormalizer;
  activeRunId: string | null;
  objective: string;
  queuedMessages: QueuedMessageRecord[];
  recentlyDequeued: QueuedMessageRecord[];
  queueMutationActive: boolean;
  queueMutationQueue: Promise<void>;
  permissionLevel: PermissionLevel;
  stateError: AppError | null;
  contextUsageEstimate: number | null;
  pendingModel: StagedModel | null;
  pendingThinkingLevel: StagedThinkingLevel | null;
  boundaryModelOverride: StagedModel | null;
  extensionUi: PiExtensionUiBridge | null;
  extensionUiState: ExtensionUiState;
  attention: SessionAttention | null;
  runFailed: boolean;
  sessionTurnPhase: SessionTurnPhase;
  deferredChildMessages: DeferredChildMessage[];
  lengthContinuationCount: number;
  firstPromptText: string;
  firstTitleStarted: boolean;
  createdAt: string;
  modifiedAt: string;
  disposed: boolean;
  disposePromise: Promise<void> | null;
}

export { activeToolsForPermission } from './PiToolPolicy';

const LEGACY_ORCHESTRATION_TOOLS = ['subagent', 'subagent_start', 'subagent_manage', 'subagent_workflow', 'subagent_catalog'] as const;
const V2_ORCHESTRATION_TOOLS = ['spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'interrupt_agent', 'list_agents', 'subagent_catalog'] as const;
const ALL_ORCHESTRATION_TOOLS = new Set<string>([...LEGACY_ORCHESTRATION_TOOLS, ...V2_ORCHESTRATION_TOOLS]);

const toolAccessBySession = new WeakMap<AgentSession, ProjectToolAccess>();
const ownedCustomToolsBySession = new WeakMap<AgentSession, readonly ToolDefinition[]>();

export function assertOwnedToolDefinitions(
  session: Pick<AgentSession, 'getToolDefinition'>,
  ownedTools: readonly ToolDefinition[],
): void {
  for (const ownedTool of ownedTools) {
    if (session.getToolDefinition(ownedTool.name) === ownedTool) continue;
    throw new PiDesktopError({
      code: 'PI_RUNTIME_ERROR',
      message: `Pi refused to start because an extension replaced Fate UI's owned ${ownedTool.name} tool.`,
      retryable: false,
    });
  }
}

export function selectUserExtensionPaths(resources: readonly { path: string; enabled: boolean; metadata: { scope: string } }[]): string[] {
  return resources
    .filter((resource) => resource.enabled && resource.metadata.scope === 'user')
    .map((resource) => resource.path);
}

export function isCanonicalPathInside(root: string, candidate: string): boolean {
  try {
    const canonical = path.normalize(realpathSync(candidate));
    const relative = path.relative(root, canonical);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

async function boundedContextPrompts(directory: string, label: string): Promise<string[]> {
  for (const name of ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']) {
    const candidate = path.join(directory, name);
    let handle;
    try {
      const link = await fs.lstat(candidate);
      if (!link.isFile() || link.isSymbolicLink() || link.size > MAX_CONTEXT_FILE_BYTES) continue;
      handle = await fs.open(candidate, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_CONTEXT_FILE_BYTES) continue;
      const content = await handle.readFile('utf8');
      return [`${label} context (${name}):\n${content}`];
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    } finally {
      await handle?.close();
    }
  }
  return [];
}

const realPiSdkAdapter: PiSdkAdapter = {
  // Verified against SDK 0.83.0: clone is runtime.fork(currentLeaf, { position: 'at' }).
  supportsClone: true,
  createModelRuntime: () => ModelRuntime.create(),
  async createRuntime(cwd, modelRuntime, projectTrusted, customTools = [], getImageGenerationSettings) {
    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd: effectiveCwd, sessionManager, sessionStartEvent }) => {
      // Project trust is decided by Fate UI's main-process prompt before the SDK
      // runtime exists. Pass that decision through so global extensions observe
      // the same trusted state and project settings/resources follow Pi semantics.
      const settingsManager = SettingsManager.create(effectiveCwd, getAgentDir(), { projectTrusted: projectTrusted === true });
      const resolvedResources = await new DefaultPackageManager({
        cwd: effectiveCwd,
        agentDir: getAgentDir(),
        settingsManager,
      }).resolve();
      const userExtensionPaths = selectUserExtensionPaths(resolvedResources.extensions);
      const appendSystemPrompt = [
        ...await boundedContextPrompts(getAgentDir(), 'Global'),
        ...await boundedContextPrompts(effectiveCwd, 'Project'),
      ];
      const services = await createAgentSessionServices({
        cwd: effectiveCwd,
        modelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          noThemes: true,
          // User-installed global extensions remain available. Project-local
          // executable code is never loaded by the desktop trust decision.
          noExtensions: true,
          noContextFiles: true,
          additionalExtensionPaths: userExtensionPaths,
          appendSystemPrompt,
        },
      });
      const toolAccess: ProjectToolAccess = { fullAccess: false };
      const confinedTools = await createProjectConfinedTools(
        effectiveCwd,
        toolAccess,
        () => [
          getReadmePath(),
          getDocsPath(),
          getExamplesPath(),
          ...services.resourceLoader.getSkills().skills.map((skill) => skill.baseDir),
        ],
        { ...(getImageGenerationSettings ? { getImageGenerationSettings } : {}) },
      );
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        // The SDK declares heterogeneous ToolDefinition arguments as
        // unknown, which is invariant under strictFunctionTypes. Each tool
        // still comes from the SDK's typed public factories.
        customTools: [...confinedTools, ...customTools] as unknown as NonNullable<Parameters<typeof createAgentSessionFromServices>[0]['customTools']>,
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
      });
      toolAccessBySession.set(created.session, toolAccess);
      ownedCustomToolsBySession.set(created.session, customTools);
      // Gate only Fate UI's controlled tools. User-installed extension tools keep
      // the activation state selected by Pi and their owning extensions.
      created.session.setActiveToolsByName(activeToolsForPermission(created.session.getActiveToolNames(), 'edit'));
      return {
        ...created,
        services,
        diagnostics: services.diagnostics,
      };
    };
    return createAgentSessionRuntime(factory, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager: SessionManager.create(cwd),
    });
  },
};

function toModelInfo(model: { provider: string; id: string; name: string; reasoning: boolean; contextWindow: number; input?: readonly string[]; api?: string }): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    supportsImages: model.input?.includes('image') ?? false,
    ...(model.api ? { api: model.api } : {}),
  };
}

function toMessage(message: unknown, id: string, timelinePosition: number): RuntimeMessage | null {
  if (!message || typeof message !== 'object') return null;
  const value = message as { role?: unknown; timestamp?: unknown; isError?: unknown; stopReason?: unknown; content?: unknown; display?: unknown; customType?: unknown; omittedEntries?: unknown };
  const role = value.role === 'user'
    ? 'user'
    : value.role === 'assistant'
      ? 'assistant'
      : value.role === 'custom' && value.display === true
        ? 'system'
        : null;
  if (!role) return null;
  const timestamp = typeof value.timestamp === 'number' ? value.timestamp : 0;
  const result: RuntimeMessage = { id, role, text: safeText(messageText(message)), timestamp, timelinePosition };
  if (value.customType === 'history-boundary' && typeof value.omittedEntries === 'number') {
    result.historyOmitted = Math.max(1, Math.floor(value.omittedEntries));
  }
  if (Array.isArray(value.content)) {
    let reasoning = '';
    for (let index = 0; index < Math.min(value.content.length, MAX_MESSAGE_CONTENT_BLOCKS); index += 1) {
      const part = value.content[index];
      if (!part || typeof part !== 'object') continue;
      const block = part as { type?: unknown; thinking?: unknown };
      if (block.type !== 'thinking' || typeof block.thinking !== 'string') continue;
      reasoning += block.thinking.slice(0, 64_000 - reasoning.length);
      if (reasoning.length >= 64_000) break;
    }
    if (reasoning) result.reasoning = safeText(reasoning);
    const images = messageImages(message, role === 'user' ? 'Attached image' : 'Generated image');
    if (images.length) result.images = images;
  }
  if (value.isError === true || value.stopReason === 'error') result.error = true;
  return result;
}

function toTools(messages: readonly unknown[]): RuntimeTool[] {
  const tools = new Map<string, RuntimeTool>();
  messages.forEach((message, messageIndex) => {
    if (!message || typeof message !== 'object') return;
    const value = message as { role?: unknown; content?: unknown; timestamp?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown; details?: unknown };
    const timestamp = typeof value.timestamp === 'number' ? value.timestamp : 0;
    if (value.role === 'assistant' && Array.isArray(value.content)) {
      const content = value.content;
      content.slice(0, MAX_MESSAGE_CONTENT_BLOCKS).forEach((part, partIndex) => {
        if (!part || typeof part !== 'object') return;
        const block = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (block.type !== 'toolCall' || typeof block.id !== 'string' || typeof block.name !== 'string') return;
        const provenance = createToolProvenance(block.name, block.arguments, { kind: 'root' });
        tools.set(block.id, {
          id: block.id,
          name: block.name,
          input: safeText(block.arguments ?? {}),
          output: '',
          outputTruncated: false,
          status: 'running',
          startedAt: timestamp,
          updatedAt: timestamp,
          timelinePosition: messageIndex + (partIndex + 1) / (content.length + 1),
          ...(provenance ? { provenance } : {}),
        });
      });
      return;
    }
    if (value.role !== 'toolResult' || typeof value.toolCallId !== 'string') return;
    const existing = tools.get(value.toolCallId);
    const images = messageImages(message);
    const output = safeText(messageText(message) || (value.details === undefined ? '' : value.details));
    const runIds = subagentRunIds({ details: value.details });
    tools.set(value.toolCallId, {
      id: value.toolCallId,
      name: typeof value.toolName === 'string' ? value.toolName : existing?.name ?? 'Tool',
      input: existing?.input ?? '',
      output,
      outputTruncated: output.includes('… output truncated by Pi Desktop'),
      status: value.isError === true ? 'error' : 'succeeded',
      startedAt: existing?.startedAt ?? timestamp,
      updatedAt: timestamp,
      endedAt: timestamp,
      timelinePosition: existing?.timelinePosition ?? messageIndex,
      ...(images.length ? { images } : {}),
      ...(runIds ? { subagentRunIds: runIds } : {}),
      ...(existing?.provenance ? { provenance: existing.provenance } : {}),
    });
  });
  return [...tools.values()];
}

function historyBoundary(omittedEntries: number, scope = 'history'): Record<string, unknown> {
  return {
    role: 'custom',
    customType: 'history-boundary',
    content: `${omittedEntries.toLocaleString()} earlier ${scope} entries remain in the Pi session file and were omitted from this view to keep Fate UI responsive.`,
    omittedEntries,
    display: true,
    timestamp: 0,
  };
}

function validTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function tokenUsageSample(usage: unknown, timestamp: unknown): RuntimeTokenTelemetry['history'][number] | null {
  if (!usage || typeof usage !== 'object' || !validTokenCount(timestamp)) return null;
  const value = usage as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    reasoning?: unknown;
    totalTokens?: unknown;
    cost?: unknown;
  };
  if (
    !validTokenCount(value.input)
    || !validTokenCount(value.output)
    || !validTokenCount(value.cacheRead)
    || !validTokenCount(value.cacheWrite)
    || !validTokenCount(value.totalTokens)
  ) return null;
  const cost = typeof value.cost === 'number'
    ? value.cost
    : value.cost && typeof value.cost === 'object'
      ? (value.cost as { total?: unknown }).total
      : undefined;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || cost > MAX_TOKEN_TELEMETRY_COST) return null;
  const reasoning = validTokenCount(value.reasoning) && value.reasoning <= value.output ? value.reasoning : undefined;
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    ...(reasoning !== undefined ? { reasoning } : {}),
    totalTokens: value.totalTokens,
    cost,
    timestamp,
  };
}

function sessionTokenTelemetry(session: AgentSession): RuntimeTokenTelemetry | undefined {
  let stats: unknown;
  try {
    stats = session.getSessionStats();
  } catch {
    return undefined;
  }
  if (!stats || typeof stats !== 'object') return undefined;
  const value = stats as { assistantMessages?: unknown; tokens?: unknown; cost?: unknown };
  const tokens = value.tokens && typeof value.tokens === 'object'
    ? value.tokens as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; total?: unknown }
    : null;
  if (
    !tokens
    || !validTokenCount(tokens.input)
    || !validTokenCount(tokens.output)
    || !validTokenCount(tokens.cacheRead)
    || !validTokenCount(tokens.cacheWrite)
    || !validTokenCount(tokens.total)
    || !validTokenCount(value.assistantMessages)
    || typeof value.cost !== 'number'
    || !Number.isFinite(value.cost)
    || value.cost < 0
    || value.cost > MAX_TOKEN_TELEMETRY_COST
  ) return undefined;

  let branch: readonly unknown[] = [];
  try {
    const persisted = session.sessionManager?.getBranch?.();
    branch = Array.isArray(persisted) && persisted.length > 0 ? persisted : session.messages;
  } catch {
    branch = session.messages;
  }
  const history: RuntimeTokenTelemetry['history'] = [];
  for (let index = branch.length - 1; index >= 0 && history.length < MAX_TOKEN_USAGE_HISTORY; index -= 1) {
    const item = branch[index];
    if (!item || typeof item !== 'object') continue;
    const entry = item as { type?: unknown; timestamp?: unknown; message?: unknown };
    const message = entry.type === 'message' ? entry.message : item;
    if (!message || typeof message !== 'object') continue;
    const assistant = message as { role?: unknown; timestamp?: unknown; usage?: unknown };
    if (assistant.role !== 'assistant') continue;
    const persistedTimestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined;
    const sample = tokenUsageSample(
      assistant.usage,
      validTokenCount(assistant.timestamp) ? assistant.timestamp : persistedTimestamp,
    );
    if (sample) history.push(sample);
  }
  history.sort((left, right) => left.timestamp - right.timestamp);
  return {
    session: {
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      totalTokens: tokens.total,
      cost: value.cost,
      turns: value.assistantMessages,
    },
    latest: history.at(-1) ?? null,
    history,
  };
}

function sessionHistory(session: AgentSession): readonly unknown[] {
  const branch = session.sessionManager?.getBranch?.() ?? [];
  const projected: unknown[] = [];
  if (branch.length === 0) {
    const omittedEntries = Math.max(0, session.messages.length - (MAX_HYDRATED_HISTORY_ENTRIES - 1));
    if (omittedEntries > 0) projected.push(historyBoundary(omittedEntries));
    projected.push(...(omittedEntries > 0 ? session.messages.slice(-(MAX_HYDRATED_HISTORY_ENTRIES - 1)) : session.messages));
  } else {
    const omittedBranchEntries = Math.max(0, branch.length - (MAX_HYDRATED_HISTORY_ENTRIES - 1));
    if (omittedBranchEntries > 0) {
      projected.push(historyBoundary(omittedBranchEntries, 'branch'));
    }
    const visibleBranch = omittedBranchEntries > 0 ? branch.slice(-(MAX_HYDRATED_HISTORY_ENTRIES - 1)) : branch;
    for (const entry of visibleBranch) {
      const timestamp = Date.parse(entry.timestamp);
      if (entry.type === 'message') {
        const message: unknown = entry.message;
        projected.push(message && typeof message === 'object' && !('timestamp' in message)
          ? { ...(message as Record<string, unknown>), timestamp: Number.isFinite(timestamp) ? timestamp : 0 }
          : message);
      } else if (entry.type === 'custom_message') {
        projected.push({
          role: 'custom',
          customType: entry.customType,
          content: entry.content,
          display: entry.display,
          timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        });
      } else if (entry.type === 'compaction') {
        projected.push({
          role: 'custom',
          customType: 'context-compaction',
          content: 'Context compacted',
          display: true,
          timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        });
      }
    }
  }

  // Pi owns the active partial message outside the persisted branch. Read the
  // authoritative streaming slot rather than duplicating the last completed
  // session message during tool turns.
  const liveTail = session.isStreaming
    ? (session as AgentSession & { agent?: { state?: { streamingMessage?: unknown } } }).agent?.state?.streamingMessage
    : undefined;
  if (liveTail && !projected.includes(liveTail)) projected.push(liveTail);
  return projected.length > 0 ? projected : session.messages;
}

function hydrationCost(message: unknown): { text: number; images: number } {
  if (!message || typeof message !== 'object') return { text: 0, images: 0 };
  const value = message as { content?: unknown; details?: unknown };
  let text = safeText(messageText(message)).length;
  if (Array.isArray(value.content)) {
    for (let index = 0; index < Math.min(value.content.length, MAX_MESSAGE_CONTENT_BLOCKS); index += 1) {
      const part = value.content[index];
      if (!part || typeof part !== 'object') continue;
      const block = part as { type?: unknown; thinking?: unknown; arguments?: unknown };
      if (block.type === 'thinking' && typeof block.thinking === 'string') text += Math.min(block.thinking.length, 64_000);
      if (block.type === 'toolCall') text += safeText(block.arguments ?? {}).length;
    }
  }
  if (value.details !== undefined) text += safeText(value.details).length;
  const images = messageImages(message).reduce((total, image) => total + image.data.length, 0);
  return { text, images };
}

function representedHistoryEntries(message: unknown): number {
  if (!message || typeof message !== 'object') return 1;
  const boundary = message as { customType?: unknown; omittedEntries?: unknown };
  return boundary.customType === 'history-boundary' && typeof boundary.omittedEntries === 'number'
    ? Math.max(1, Math.floor(boundary.omittedEntries))
    : 1;
}

function hydrationEntities(message: unknown): number {
  if (!message || typeof message !== 'object') return 0;
  const value = message as { role?: unknown; display?: unknown; content?: unknown };
  let entities = value.role === 'user' || value.role === 'assistant' || (value.role === 'custom' && value.display === true) ? 1 : 0;
  if (value.role === 'toolResult') entities += 1;
  if (Array.isArray(value.content)) {
    let hasThinking = false;
    for (let index = 0; index < Math.min(value.content.length, MAX_MESSAGE_CONTENT_BLOCKS); index += 1) {
      const part = value.content[index];
      if (!part || typeof part !== 'object') continue;
      const type = (part as { type?: unknown }).type;
      if (type === 'thinking') hasThinking = true;
      else if (type === 'toolCall') entities += 1;
    }
    if (hasThinking) entities += 1;
  }
  return Math.min(MAX_HYDRATED_TIMELINE_ENTITIES, entities);
}

function boundedSessionHistory(messages: readonly unknown[]): readonly unknown[] {
  if (messages.length === 0) return messages;
  const selected: unknown[] = [];
  let selectedEntities = 0;
  let textCharacters = 0;
  let imageCharacters = 0;
  let omitted = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const cost = hydrationCost(message);
    const entities = hydrationEntities(message);
    if (
      selected.length >= MAX_HYDRATED_HISTORY_ENTRIES
      || selectedEntities + entities > MAX_HYDRATED_TIMELINE_ENTITIES - 1
      || textCharacters + cost.text > MAX_HYDRATED_TEXT_CHARACTERS
      || imageCharacters + cost.images > MAX_HYDRATED_IMAGE_CHARACTERS
    ) {
      omitted = index + 1;
      break;
    }
    selected.push(message);
    selectedEntities += entities;
    textCharacters += cost.text;
    imageCharacters += cost.images;
  }
  selected.reverse();
  if (omitted > 0) {
    let omittedEntries = messages.slice(0, omitted).reduce<number>((total, message) => total + representedHistoryEntries(message), 0);
    while (selected.length >= MAX_HYDRATED_HISTORY_ENTRIES || selectedEntities >= MAX_HYDRATED_TIMELINE_ENTITIES) {
      const removed = selected.shift();
      omittedEntries += representedHistoryEntries(removed);
      selectedEntities -= hydrationEntities(removed);
    }
    selected.unshift(historyBoundary(omittedEntries));
  }
  return selected;
}

export class PiRuntimeService {
  private project: ProjectState | null = null;
  private selectedSlot: RuntimeSlot | null = null;
  private readonly liveSlots = new Set<RuntimeSlot>();
  private readonly pendingDisposals = new Set<Promise<void>>();
  private readonly sessionAttention = new Map<string, SessionAttentionRecord>();
  private readonly manualSessionNames = new Set<string>();
  private readonly coldPendingModels = new Map<string, ModelInfo>();
  private readonly coldPendingThinkingLevels = new Map<string, ThinkingLevel>();
  private modelRuntime: ModelRuntime | null = null;
  private models: ModelInfo[] = [];
  private fallbackPermissionLevel: PermissionLevel = 'full-access';
  private status: RuntimeState['status'] = 'disconnected';
  private fallbackStateError: AppError | null = null;
  private eventSink: (events: PiEvent[]) => void = () => undefined;
  private readonly batcher: PiEventBatcher;
  private readonly subagents: SubagentCoordinator;
  private readonly agentTeams: AgentTeamCoordinator;
  private readonly disconnectedNormalizer = new PiEventNormalizer(() => null);
  private initialization = 0;
  private sessions: SessionSummary[] = [];
  private replacementQueue: Promise<void> = Promise.resolve();
  private replacementActive = false;
  private replacementGeneration = 0;
  private sessionRefreshGeneration = 0;
  private sessionRefreshLoad: { projectPath: string; forced: boolean; promise: Promise<SessionSummary[]> } | null = null;
  private attentionRevision = 0;
  private eventCursor = 0;
  private agentTeamMode: 'legacy' | 'v2' = 'legacy';

  private get runtime(): AgentSessionRuntime | null { return this.selectedSlot?.runtime ?? null; }
  private get permissionLevel(): PermissionLevel { return this.selectedSlot?.permissionLevel ?? this.fallbackPermissionLevel; }
  private get stateError(): AppError | null { return this.selectedSlot?.stateError ?? this.fallbackStateError; }
  private set stateError(error: AppError | null) {
    if (this.selectedSlot) this.selectedSlot.stateError = error;
    else this.fallbackStateError = error;
  }
  private get normalizer(): PiEventNormalizer { return this.selectedSlot?.normalizer ?? this.disconnectedNormalizer; }
  private get objective(): string { return this.selectedSlot?.objective ?? ''; }
  private set objective(objective: string) { if (this.selectedSlot) this.selectedSlot.objective = objective; }

  constructor(
    private readonly adapter: PiSdkAdapter = realPiSdkAdapter,
    private readonly sessionRepository = new PiSessionRepository(),
    private readonly sessionPermissions: SessionPermissionPersistence = new InMemorySessionPermissionStore(),
    private readonly sessionTitleGenerator: SessionTitleGenerator = new PiSessionTitleGenerator(),
    private readonly getImageGenerationSettings: ImageGenerationSettingsResolver = () => defaultImageGenerationSettings,
  ) {
    this.batcher = new PiEventBatcher((events) => this.eventSink(events));
    const childSessionFactory = (input: Parameters<typeof createSdkChildSession>[0]) => createSdkChildSession({
      ...input,
      getImageGenerationSettings: this.getImageGenerationSettings,
    });
    this.agentTeams = new AgentTeamCoordinator({
      resolveRoot: (sessionId) => {
        const slot = this.findLiveSlot(sessionId);
        if (!slot || !this.project) return null;
        return { projectPath: this.project.path, session: slot.runtime.session, permissionLevel: slot.permissionLevel };
      },
      sendRootMessage: (rootSessionId, message, activeDelivery, triggerWhenIdle) => {
        const slot = this.findLiveSlot(rootSessionId);
        if (!slot || slot.disposed) return Promise.resolve();
        return this.sendChildGeneratedMessage(slot, slot.runtime.session, message, activeDelivery, triggerWhenIdle);
      },
      emit: (rootSessionId, team) => {
        const slot = this.findLiveSlot(rootSessionId);
        if (this.selectedSlot === slot) this.enqueue({ type: 'agent-team.updated', team, timestamp: team.updatedAt });
        else if (slot && team.nodes.some((node) => node.depth > 0 && (node.status === 'active' || node.status === 'creating'))) {
          this.setSessionAttention(slot, 'running');
          this.mergeLiveSessionSummaries();
          this.emitState();
        }
      },
      persist: (rootSessionId, event) => {
        const slot = this.findLiveSlot(rootSessionId);
        if (!slot || slot.disposed) return;
        slot.runtime.session.sessionManager.appendCustomEntry('fate-agent-team-event', event);
        slot.modifiedAt = new Date().toISOString();
      },
      settled: (rootSessionId) => {
        const slot = this.findLiveSlot(rootSessionId);
        if (!slot || slot.disposed) return;
        if (this.selectedSlot === slot) this.emitState();
        else if (!this.agentTeams.hasOwnedWork(rootSessionId) && !this.subagents.hasOwnedWork(rootSessionId) && !this.sessionHasActiveWork(slot.runtime.session)) this.settleInactiveSlot(slot);
      },
    }, undefined, childSessionFactory);
    this.subagents = new SubagentCoordinator({
      resolveParent: (sessionId) => {
        const slot = this.findLiveSlot(sessionId);
        if (!slot || !this.project) return null;
        return { projectPath: this.project.path, session: slot.runtime.session, permissionLevel: slot.permissionLevel };
      },
      emit: (parentSessionId, event) => {
        const slot = this.findLiveSlot(parentSessionId);
        if (this.selectedSlot === slot) {
          this.enqueue(event);
        } else if (slot && event.type === 'subagent.started') {
          this.setSessionAttention(slot, 'running');
          this.mergeLiveSessionSummaries();
          this.emitState();
        } else if (slot && event.type === 'subagent.completed' && (event.run.status === 'error' || event.run.status === 'timed-out' || event.run.status === 'budget-exceeded')) {
          slot.runFailed = true;
        } else if (slot && event.type === 'subagent.workflow.updated' && event.workflow.status === 'error') {
          slot.runFailed = true;
        }
      },
      persist: (parentSessionId, run) => {
        const slot = this.findLiveSlot(parentSessionId);
        if (!slot || slot.disposed) return;
        slot.runtime.session.sessionManager.appendCustomEntry('fate-subagent-run', {
          kind: 'fate-subagent-snapshot', version: 2, run,
        });
        slot.modifiedAt = new Date().toISOString();
      },
      persistWorkflow: (parentSessionId, workflow) => {
        const slot = this.findLiveSlot(parentSessionId);
        if (!slot || slot.disposed) return;
        slot.runtime.session.sessionManager.appendCustomEntry('fate-subagent-workflow', {
          kind: 'fate-subagent-workflow-snapshot', version: 1, workflow,
        });
        slot.modifiedAt = new Date().toISOString();
      },
      notifyParent: async (parentSessionId, mode: SubagentNotification, text, runIds, workflowId, livenessReport?: SubagentParentLivenessReport) => {
        // Liveness has a dedicated structured Pi event and inspector surface. Never
        // enqueue it into the model loop, where delivery can outlive the child turn.
        if (livenessReport) return;
        const slot = this.findLiveSlot(parentSessionId);
        if (!slot || slot.disposed || mode === 'never') return;
        const session = slot.runtime.session;
        const message = {
          customType: 'fate-subagent-notification',
          content: [{ type: 'text' as const, text }],
          display: false,
          details: { runIds, ...(workflowId ? { workflowId } : {}) },
        };
        if (mode === 'next-turn') {
          await session.sendCustomMessage(message, { triggerTurn: false, deliverAs: 'nextTurn' });
          return;
        }
        await this.sendChildGeneratedMessage(slot, session, message, 'followUp', true);
      },
      settled: (parentSessionId) => {
        const slot = this.findLiveSlot(parentSessionId);
        if (!slot || slot.disposed) return;
        if (this.selectedSlot === slot) {
          this.emitState();
        } else if (!this.subagents.hasOwnedWork(parentSessionId) && !this.agentTeams.hasOwnedWork(parentSessionId) && !this.sessionHasActiveWork(slot.runtime.session)) {
          this.settleInactiveSlot(slot);
        }
      },
    }, childSessionFactory);
  }

  setEventSink(sink: (events: PiEvent[]) => void): void {
    this.eventSink = sink;
  }

  getState(includeMessages = true): RuntimeState {
    const session = this.runtime?.session;
    const allMessages = session && includeMessages ? boundedSessionHistory(sessionHistory(session)) : [];
    const streamingMessage = session?.isStreaming
      ? (session as AgentSession & { agent?: { state?: { streamingMessage?: unknown } } }).agent?.state?.streamingMessage
      : undefined;
    const activeAssistantId = this.normalizer.currentAssistantMessageId();
    const messages = allMessages
      .map((message, index) => toMessage(
        message,
        message === streamingMessage && activeAssistantId ? activeAssistantId : this.normalizer.messageId(message),
        index,
      ))
      .filter((message): message is RuntimeMessage => message !== null);
    const tools = toTools(allMessages);
    let objective = this.objective;
    if (includeMessages) {
      objective = '';
      for (let index = allMessages.length - 1; index >= 0; index -= 1) {
        const message = allMessages[index] as { role?: unknown } | undefined;
        if (message?.role === 'user') { objective = messageText(message).trim().slice(0, 500); break; }
      }
      this.objective = objective;
    }
    const reportedContextUsage = session?.getContextUsage?.();
    const contextUsageEstimate = this.selectedSlot?.contextUsageEstimate;
    const contextWindow = reportedContextUsage?.contextWindow ?? session?.model?.contextWindow;
    let contextUsage: RuntimeState['contextUsage'] = reportedContextUsage;
    if (
      contextUsageEstimate !== null
      && contextUsageEstimate !== undefined
      && (!reportedContextUsage || reportedContextUsage.tokens === null)
      && contextWindow
    ) {
      contextUsage = {
        tokens: contextUsageEstimate,
        contextWindow,
        percent: contextUsageEstimate / contextWindow * 100,
        estimated: true,
      };
    } else if (reportedContextUsage?.tokens !== null && reportedContextUsage?.tokens !== undefined && this.selectedSlot) {
      this.selectedSlot.contextUsageEstimate = null;
    }
    const tokenTelemetry = session ? sessionTokenTelemetry(session) : undefined;
    const queue = {
      steering: session?.getSteeringMessages?.().length ?? 0,
      followUp: session?.getFollowUpMessages?.().length ?? 0,
      items: (this.selectedSlot?.queuedMessages ?? []).slice(0, MAX_QUEUED_MESSAGES).map(({ transportText: _transportText, boundModel: _boundModel, boundThinkingLevel: _boundThinkingLevel, ...item }) => item),
    };
    const skills = this.runtime?.services?.resourceLoader?.getSkills?.().skills.slice(0, 5_000).map((skill) => ({ name: skill.name.slice(0, 500), description: skill.description.slice(0, 2_000) }));
    return {
      status: this.status,
      project: this.project,
      sessionId: session?.sessionId ?? null,
      sessionFile: session?.sessionFile ?? null,
      streaming: session?.isStreaming ?? false,
      activeSessionRunning: session ? this.sessionHasActiveWork(session) : false,
      runningSessionCount: this.runningSessionCount(),
      model: session?.model ? toModelInfo(session.model) : null,
      pendingModel: this.selectedSlot?.pendingModel?.info ?? null,
      models: this.models,
      thinkingLevel: session?.thinkingLevel ?? 'medium',
      pendingThinkingLevel: this.selectedSlot?.pendingThinkingLevel?.level ?? null,
      permissionLevel: this.permissionLevel,
      messages,
      tools,
      commands: this.getCommands(session),
      skills: skills ?? [],
      ...(objective ? { objective } : {}),
      ...(contextUsage ? { contextUsage } : {}),
      ...(tokenTelemetry ? { tokenTelemetry } : {}),
      queue,
      extensionUi: this.selectedSlot?.extensionUiState ?? emptyExtensionUiState(),
      sessions: this.sessions,
      subagents: session ? this.subagents.getRuns(session.sessionId) : [],
      subagentWorkflows: session ? this.subagents.getWorkflowViews(session.sessionId) : [],
      agentTeams: session ? this.agentTeams.getTeams(session.sessionId) : [],
      ...(includeMessages && session ? { branches: this.sessionRepository.branches(session) } : {}),
      ...(session && typeof session.getUserMessagesForForking === 'function'
        ? { forkPoints: session.getUserMessagesForForking().slice(-2_000).filter((point) => point.entryId.length <= 500).map((point) => ({ ...point, text: point.text.slice(0, 2_000) })) }
        : {}),
      sessionCapabilities: {
        fork: typeof this.runtime?.fork === 'function',
        clone: this.adapter.supportsClone === true
          && typeof this.runtime?.fork === 'function'
          && typeof session?.sessionManager?.getLeafId === 'function'
          && Boolean(session.sessionManager.getLeafId()),
        import: typeof this.runtime?.importFromJsonl === 'function',
        compact: typeof session?.compact === 'function',
      },
      sessionOperation: this.replacementActive,
      eventCursor: this.eventCursor,
      error: this.stateError,
    };
  }

  getHydrationState(): RuntimeState {
    // Establish an event-batch boundary before exposing the cursor. The
    // renderer reconciles buffered events against this authoritative snapshot.
    this.batcher.flush();
    return this.getState();
  }

  async closeProject(): Promise<RuntimeState> {
    const generation = ++this.initialization;
    this.replacementGeneration += 1;
    this.replacementQueue = Promise.resolve();
    this.replacementActive = false;
    await this.disposeRuntime();
    if (generation !== this.initialization) return this.getState();
    this.subagents.reset();
    this.agentTeams.reset();
    this.project = null;
    this.modelRuntime = null;
    this.fallbackPermissionLevel = 'full-access';
    this.models = [];
    this.sessions = [];
    this.sessionAttention.clear();
    this.manualSessionNames.clear();
    this.coldPendingModels.clear();
    this.coldPendingThinkingLevels.clear();
    this.status = 'disconnected';
    this.fallbackStateError = null;
    return this.emitState();
  }

  async openProject(project: ProjectState, defaults?: SessionDefaults): Promise<RuntimeState> {
    const generation = ++this.initialization;
    this.replacementGeneration += 1;
    this.replacementQueue = Promise.resolve();
    this.replacementActive = false;
    await this.disposeRuntime();
    if (generation !== this.initialization) return this.getState();
    this.subagents.reset();
    this.agentTeams.reset();
    this.project = project;
    this.fallbackPermissionLevel = 'full-access';
    this.models = [];
    this.sessions = [];
    this.sessionAttention.clear();
    this.manualSessionNames.clear();
    this.coldPendingModels.clear();
    this.coldPendingThinkingLevels.clear();
    this.fallbackStateError = null;
    if (!project.trusted) {
      this.status = 'disconnected';
      this.stateError = {
        code: 'PROJECT_NOT_TRUSTED',
        message: 'This project is open without Pi access.',
        actionable: 'Reopen it and choose “Trust and open” to initialize Pi.',
        retryable: true,
      };
      this.emitState();
      return this.getState();
    }

    this.status = 'initializing';
    this.emitState();
    try {
      // The SDK's headless tool and extension paths still use its global theme
      // proxy while rendering calls. Pi Desktop does not run InteractiveMode,
      // so initialize a stable theme explicitly without starting its watcher.
      initTheme('dark', false);
      const modelRuntime = await this.adapter.createModelRuntime();
      if (generation !== this.initialization) return this.getState();
      this.modelRuntime = modelRuntime;

      // Build project-bound services before checking availability: enabled global
      // user extensions may register providers and models during runtime creation.
      this.agentTeamMode = defaults?.agentTeamMode ?? 'legacy';
      const runtime = await this.adapter.createRuntime(project.path, modelRuntime, project.trusted, this.orchestrationTools(modelRuntime), this.getImageGenerationSettings);
      if (generation !== this.initialization) {
        await runtime.dispose();
        return this.getState();
      }
      const slot = this.createSlot(runtime, generation);
      this.liveSlots.add(slot);
      this.selectedSlot = slot;
      this.configureRuntimeSlot(slot);
      await this.replaceSession(slot, runtime.session);
      if (generation !== this.initialization || this.selectedSlot !== slot) return this.getState();
      await this.refreshSessions();
      if (generation !== this.initialization || this.selectedSlot !== slot) return this.getState();
      const available = await modelRuntime.getAvailable();
      if (generation !== this.initialization || this.selectedSlot !== slot) return this.getState();
      this.models = available.slice(0, 2_000).map(toModelInfo);
      await this.applySessionDefaults(runtime.session, defaults);
      if (generation !== this.initialization || this.selectedSlot !== slot) return this.getState();
      this.status = available.length > 0 ? 'ready' : 'auth-required';
      this.stateError = available.length > 0 ? null : authRequiredError();
      const diagnostic = runtime.diagnostics.find((item) => item.type === 'error');
      if (diagnostic) this.emitError({ code: 'PI_RUNTIME_ERROR', message: diagnostic.message, retryable: true });
      return this.emitState(true);
    } catch (error) {
      if (generation !== this.initialization) return this.getState();
      let normalized = normalizeError(error);
      try {
        await this.disposeRuntime();
      } catch (cleanupError) {
        normalized = {
          ...normalized,
          message: `${normalized.message} Failed runtime cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        };
      }
      if (generation !== this.initialization) return this.getState();
      this.modelRuntime = null;
      this.models = [];
      this.status = normalized.code === 'AUTH_REQUIRED' ? 'auth-required' : 'error';
      this.stateError = normalized;
      this.emitError(normalized);
      this.emitState();
      return this.getState();
    }
  }

  async prompt(input: PromptInput): Promise<PromptAcceptance> {
    const session = this.requireSession();
    const slot = this.selectedSlot!;
    if (this.replacementActive) {
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'Wait for the session change to finish before sending a prompt.', retryable: true });
    }
    const initialization = this.initialization;
    const runId = randomUUID();
    const commandPrompt = expandMultipleSkillCommands(input.text, session.resourceLoader.getSkills().skills)
      ?? promoteInlineResourceCommand(input.text, this.getCommands(session));
    const includesProjectResources = hasProjectResourceTags(input.text);
    const promptText = includesProjectResources
      ? await appendProjectResourceContext(commandPrompt, this.project?.path ?? null, input.text)
      : commandPrompt;
    if (
      includesProjectResources
      && (initialization !== this.initialization || slot.disposed || this.selectedSlot !== slot || slot.runtime.session !== session)
    ) throw this.replacementSuperseded();
    validatePromptImages(input.images);
    const images = input.images?.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType }));
    const queuedBehavior = session.isStreaming && input.behavior !== 'prompt' ? input.behavior : null;
    if (queuedBehavior && slot.queuedMessages.length >= MAX_QUEUED_MESSAGES) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The message queue is full. Cancel or wait for a queued message before adding another.', retryable: true });
    }
    if (session.isStreaming && input.behavior === 'prompt' && !promptText.trimStart().startsWith('/')) {
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'Pi is already working. Steer it or queue a follow-up instead.', retryable: true });
    }

    const stagedModel = slot.pendingModel;
    const stagedThinkingLevel = slot.pendingThinkingLevel;
    const effectiveModel = stagedModel?.model ?? session.model;
    if (images?.length && !effectiveModel?.input.includes('image')) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The model selected for this message does not support image input.', retryable: true });
    }
    const startsRun = !session.isStreaming;
    const ownsSlot = () => initialization === this.initialization
      && !slot.disposed
      && this.liveSlots.has(slot)
      && slot.runtime.session === session;
    const restoreStagedModel = (staged: StagedModel): void => {
      if (initialization !== this.initialization) return;
      if (slot.disposed || slot.runtime.session !== session) {
        this.rememberColdPendingModel(session.sessionId, staged.info);
      } else if (!slot.pendingModel) {
        slot.pendingModel = staged;
      }
    };
    const restoreStagedThinkingLevel = (staged: StagedThinkingLevel): void => {
      if (initialization !== this.initialization) return;
      if (slot.disposed || slot.runtime.session !== session) {
        this.rememberColdPendingThinkingLevel(session.sessionId, staged.level);
      } else if (!slot.pendingThinkingLevel) {
        slot.pendingThinkingLevel = staged;
      }
    };
    const clearRunReservation = (): void => {
      if (!startsRun || slot.activeRunId !== runId) return;
      slot.activeRunId = null;
      slot.objective = '';
    };
    const isFirstUserPrompt = startsRun && !slot.firstTitleStarted && !sessionHistory(session).some((message) => (
      Boolean(message) && typeof message === 'object' && (message as { role?: unknown }).role === 'user'
    ));
    if (startsRun) {
      slot.activeRunId = runId;
      slot.objective = input.text.trim().slice(0, 500);
      if (stagedModel || stagedThinkingLevel) {
        if (stagedModel) {
          slot.pendingModel = null;
          this.coldPendingModels.delete(session.sessionId);
        }
        if (stagedThinkingLevel) {
          slot.pendingThinkingLevel = null;
          this.coldPendingThinkingLevels.delete(session.sessionId);
        }
        try {
          if (stagedModel) await session.setModel(stagedModel.model);
          // Apply reasoning after the staged model so Pi validates it against
          // the model that will actually receive the next user message.
          if (stagedThinkingLevel) session.setThinkingLevel(stagedThinkingLevel.level);
        } catch (error) {
          if (stagedModel) restoreStagedModel(stagedModel);
          if (stagedThinkingLevel) restoreStagedThinkingLevel(stagedThinkingLevel);
          clearRunReservation();
          throw error;
        }
      }
    }
    if (!ownsSlot() || this.selectedSlot !== slot) {
      if (startsRun && stagedModel) restoreStagedModel(stagedModel);
      if (startsRun && stagedThinkingLevel) restoreStagedThinkingLevel(stagedThinkingLevel);
      clearRunReservation();
      throw this.replacementSuperseded();
    }

    const queuedCountBefore = queuedBehavior === 'steer'
      ? session.getSteeringMessages?.().length ?? 0
      : queuedBehavior === 'followUp'
        ? session.getFollowUpMessages?.().length ?? 0
        : 0;
    const queuedRecord: QueuedMessageRecord | null = queuedBehavior
      ? {
          id: randomUUID(),
          behavior: queuedBehavior,
          text: input.text,
          transportText: promptText,
          ...(stagedModel ? { boundModel: stagedModel } : {}),
          ...(stagedThinkingLevel ? { boundThinkingLevel: stagedThinkingLevel } : {}),
          ...(input.images?.length ? { images: input.images.map((image) => ({ ...image })) } : {}),
          createdAt: Date.now(),
        }
      : null;
    let queuedReservationActive = queuedRecord !== null;
    if (queuedRecord) {
      slot.queuedMessages.push(queuedRecord);
      if (stagedModel && slot.pendingModel?.token === stagedModel.token) {
        slot.pendingModel = null;
        this.coldPendingModels.delete(session.sessionId);
      }
      if (stagedThinkingLevel && slot.pendingThinkingLevel?.token === stagedThinkingLevel.token) {
        slot.pendingThinkingLevel = null;
        this.coldPendingThinkingLevels.delete(session.sessionId);
      }
    }

    slot.stateError = null;
    let settled = false;
    return new Promise<PromptAcceptance>((resolve) => {
      const releaseQueuedReservation = (restoreModel: boolean): void => {
        if (!queuedRecord || !queuedReservationActive) return;
        queuedReservationActive = false;
        slot.queuedMessages = slot.queuedMessages.filter((item) => item.id !== queuedRecord.id);
        if (restoreModel && queuedRecord.boundModel) restoreStagedModel(queuedRecord.boundModel);
        if (restoreModel && queuedRecord.boundThinkingLevel) restoreStagedThinkingLevel(queuedRecord.boundThinkingLevel);
      };
      const rejectReservation = (): void => {
        releaseQueuedReservation(true);
        if (startsRun && stagedModel) restoreStagedModel(stagedModel);
        if (startsRun && stagedThinkingLevel) restoreStagedThinkingLevel(stagedThinkingLevel);
        clearRunReservation();
      };
      const accept = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        if (!ownsSlot()) {
          rejectReservation();
          resolve({ accepted: false, runId });
          return;
        }
        if (accepted) {
          if (queuedRecord && queuedBehavior) {
            const queuedTexts = queuedBehavior === 'steer' ? session.getSteeringMessages?.() ?? [] : session.getFollowUpMessages?.() ?? [];
            if (queuedTexts.length > queuedCountBefore) {
              queuedRecord.transportText = queuedTexts.at(-1) ?? queuedRecord.transportText;
              queuedReservationActive = false;
            } else {
              // Extension commands execute immediately even when a streaming
              // behavior is supplied; they must not leave a phantom queue item
              // or consume the model staged for the next actual user turn.
              releaseQueuedReservation(true);
            }
          }
          slot.modifiedAt = new Date().toISOString();
          if (isFirstUserPrompt) {
            slot.firstTitleStarted = true;
            slot.firstPromptText = input.text;
            this.mergeLiveSessionSummaries();
            void this.generateFirstPromptTitle(slot, session, input.text, initialization);
          }
          if (this.selectedSlot === slot) {
            this.enqueue({ type: 'run.accepted', runId, timestamp: Date.now() });
            this.emitState();
          }
        } else {
          rejectReservation();
          if (this.selectedSlot === slot) this.emitError({ code: 'INVALID_REQUEST', message: 'Pi rejected the prompt before starting.', retryable: true });
        }
        resolve({ accepted, runId });
      };
      void session.prompt(promptText, {
        ...(images ? { images } : {}),
        ...(input.behavior === 'prompt' ? {} : { streamingBehavior: input.behavior }),
        preflightResult: accept,
      }).catch((error: unknown) => {
        if (!ownsSlot()) {
          accept(false);
          return;
        }
        const normalized = normalizeError(error);
        if (!settled) accept(false);
        slot.stateError = normalized;
        slot.runFailed = true;
        if (this.selectedSlot === slot) this.emitError(normalized);
      }).finally(() => {
        if (startsRun && slot.activeRunId === runId) slot.activeRunId = null;
        if (ownsSlot() && this.selectedSlot === slot) this.emitState();
      });
    });
  }

  private async generateFirstPromptTitle(
    slot: RuntimeSlot,
    session: AgentSession,
    prompt: string,
    initialization: number,
  ): Promise<void> {
    const projectPath = this.project?.path;
    const modelRuntime = this.modelRuntime;
    if (!projectPath || !modelRuntime) return;
    try {
      const title = await this.sessionTitleGenerator.generate(prompt, modelRuntime, session);
      const claimKey = this.sessionClaimKey(projectPath, session.sessionId);
      if (
        !title
        || initialization !== this.initialization
        || this.project?.path !== projectPath
        || this.manualSessionNames.has(claimKey)
        || session.sessionName?.trim()
        || session.sessionManager?.getSessionName?.()?.trim()
      ) return;
      // The owning manager already knows the not-yet-listable JSONL path. Append
      // directly instead of racing SessionManager.list() through the repository.
      if (typeof session.sessionManager?.appendSessionInfo === 'function') session.sessionManager.appendSessionInfo(title);
      else session.setSessionName(title);
      slot.modifiedAt = new Date().toISOString();
      const liveSummary = this.liveSessionSummary(slot, session, prompt);
      const summaryIndex = this.sessions.findIndex((summary) => summary.id === session.sessionId);
      if (summaryIndex >= 0) this.sessions[summaryIndex] = liveSummary;
      else this.sessions = [liveSummary, ...this.sessions].slice(0, 1_000);
      await this.refreshSessions(true);
      if (initialization === this.initialization) this.emitState();
    } catch {
      // Title generation is a non-blocking enhancement; the bounded prompt fallback remains usable.
    }
  }

  forkPrompt(entryId: string): string {
    const session = this.requireRuntimeIdleSession('creating an isolated worktree session');
    const point = session.getUserMessagesForForking?.().find((candidate) => candidate.entryId === entryId);
    if (!point) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'That prompt is not part of the active session.', retryable: true });
    return point.text.slice(0, 2_000);
  }

  async abort(): Promise<{ aborted: boolean }> {
    const session = this.runtime?.session;
    if (!session) return { aborted: false };
    const hasChildren = this.subagents.hasActiveRuns(session.sessionId) || this.agentTeams.hasActiveWork(session.sessionId);
    if (!session.isStreaming && !hasChildren) return { aborted: false };
    const [parentAbort] = await Promise.allSettled([
      session.isStreaming ? session.abort() : Promise.resolve(),
      this.subagents.cancelParent(session.sessionId),
      this.agentTeams.cancelRoot(session.sessionId),
    ]);
    if (parentAbort.status === 'rejected') throw parentAbort.reason;
    return { aborted: true };
  }

  async controlSubagent(input: SubagentControlInput): Promise<RuntimeState> {
    const session = this.requireSession();
    if (!this.modelRuntime) {
      throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'The model runtime is unavailable for child controls.', retryable: true });
    }
    await this.subagents.controlRun(session.sessionId, input, this.modelRuntime);
    return this.getState(false);
  }

  async controlAgentTeam(input: AgentTeamControlInput): Promise<RuntimeState> {
    const session = this.requireSession();
    if (!this.modelRuntime) throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'The model runtime is unavailable for Agent Team controls.', retryable: true });
    await this.agentTeams.control(session.sessionId, input, this.modelRuntime);
    return this.getState(false);
  }

  async setModel(provider: string, id: string): Promise<RuntimeState> {
    this.requireSession();
    const slot = this.selectedSlot!;
    const model = this.modelRuntime?.getModel(provider, id);
    if (!model || !this.models.some((candidate) => candidate.provider === provider && candidate.id === id)) {
      throw new PiDesktopError({ code: 'AUTH_REQUIRED', message: `Model ${provider}/${id} is unavailable or not authenticated.`, actionable: 'Authenticate its provider with the Pi CLI /login command.', retryable: true });
    }
    slot.pendingModel = { token: randomUUID(), model, info: toModelInfo(model) };
    this.coldPendingModels.delete(slot.runtime.session.sessionId);
    if (!model.reasoning) {
      slot.pendingThinkingLevel = null;
      this.coldPendingThinkingLevels.delete(slot.runtime.session.sessionId);
    }
    slot.stateError = null;
    this.emitState();
    return this.getState(false);
  }

  setThinkingLevel(level: ThinkingLevel): RuntimeState {
    const session = this.requireSession();
    const slot = this.selectedSlot!;
    const effectiveModel = slot.pendingModel?.model ?? session.model;
    if (level !== 'off' && !effectiveModel?.reasoning) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The model selected for the next message does not support reasoning.', retryable: true });
    }
    slot.pendingThinkingLevel = { token: randomUUID(), level };
    this.coldPendingThinkingLevels.delete(session.sessionId);
    slot.stateError = null;
    this.emitState();
    return this.getState(false);
  }

  async setPermissionLevel(level: PermissionLevel): Promise<RuntimeState> {
    const session = this.requireIdleSession('changing the permission level');
    const slot = this.selectedSlot!;
    const projectPath = this.project?.path;
    if (!projectPath) throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a project before changing permissions.', retryable: true });
    const initialization = this.initialization;
    const sessionGeneration = slot.sessionGeneration;
    const ownsSession = () => initialization === this.initialization
      && sessionGeneration === slot.sessionGeneration
      && !slot.disposed
      && this.selectedSlot === slot
      && slot.runtime.session === session;
    const access = toolAccessBySession.get(session);
    // Keep the filesystem boundary fail-closed if the SDK rejects a tool set,
    // while preserving active tools owned by trusted global extensions.
    session.setActiveToolsByName(activeToolsForPermission(session.getActiveToolNames(), level));
    if (access) access.fullAccess = level === 'full-access';
    slot.permissionLevel = level;
    this.agentTeams.lowerRootPermission(session.sessionId, level);
    try {
      await this.sessionPermissions.set(projectPath, session.sessionId, level);
    } catch (error) {
      if (ownsSession()) this.emitSystemMessage(`The session permission changed but could not be saved: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    }
    if (!ownsSession()) throw this.replacementSuperseded();
    this.emitState();
    return this.getState(false);
  }

  mutateQueuedMessage(input: QueueMutationInput): Promise<QueueMutationResult> {
    this.requireSession();
    const slot = this.selectedSlot!;
    const operation = slot.queueMutationQueue.then(() => this.applyQueueMutation(input, slot));
    slot.queueMutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  newSession(defaults?: SessionDefaults): Promise<RuntimeState> {
    const activeSession = this.runtime?.session;
    const sourceSlot = this.selectedSlot;
    const stagedModel = sourceSlot?.pendingModel ?? null;
    const stagedThinkingLevel = sourceSlot?.pendingThinkingLevel ?? null;
    const activeModel = activeSession?.model;
    const nextModel = stagedModel?.model ?? activeModel;
    const nextDefaults = activeSession
      ? {
          thinkingLevel: stagedThinkingLevel?.level ?? activeSession.thinkingLevel,
          defaultModel: nextModel ? `${nextModel.provider}/${nextModel.id}` : defaults?.defaultModel ?? null,
        }
      : defaults;
    const sourceSessionId = activeSession?.sessionId;
    const consumeStagedSettings = (slot: RuntimeSlot): void => {
      if (stagedModel && slot.pendingModel?.token === stagedModel.token) slot.pendingModel = null;
      if (stagedThinkingLevel && slot.pendingThinkingLevel?.token === stagedThinkingLevel.token) slot.pendingThinkingLevel = null;
      if (sourceSessionId) {
        this.coldPendingModels.delete(sourceSessionId);
        this.coldPendingThinkingLevels.delete(sourceSessionId);
      }
    };
    return this.runReplacement(async (runtime, slot) => {
      const hasManagedChildren = this.subagents.hasOwnedWork(slot.runtime.session.sessionId) || this.agentTeams.hasOwnedWork(slot.runtime.session.sessionId);
      if (!slot.runtime.session.isStreaming && this.sessionHasNonStreamingWork(slot.runtime.session)) throw this.activeOperationError('creating a session');
      if (slot.runtime.session.isStreaming || hasManagedChildren) {
        const created = await this.createAdditionalSlot();
        await this.applySessionDefaults(created.runtime.session, nextDefaults, created);
        await this.selectRuntimeSlot(created);
        consumeStagedSettings(slot);
        return;
      }
      if ((await runtime.newSession())?.cancelled) throw this.replacementCancelled('New session');
      await this.applySessionDefaults(runtime.session, nextDefaults, slot);
      consumeStagedSettings(slot);
    });
  }

  async listSessions(query = ''): Promise<SessionSummary[]> {
    const project = this.project;
    const slot = this.selectedSlot;
    if (!project || !slot) return [];
    const generation = this.initialization;
    const persisted = await this.sessionRepository.list(project.path, slot.runtime.session.sessionId, query);
    if (
      generation !== this.initialization
      || this.project?.path !== project.path
      || !this.selectedSlot
    ) return [];
    return this.mergeSessionSummaries(persisted, query).slice(0, 1_000);
  }

  switchSession(sessionId: string): Promise<RuntimeState> {
    const projectPath = this.project?.path;
    if (!projectPath) return Promise.reject(new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a project before switching sessions.', retryable: true }));
    return this.runReplacement(async (runtime, slot) => {
      const hasManagedChildren = this.subagents.hasOwnedWork(slot.runtime.session.sessionId) || this.agentTeams.hasOwnedWork(slot.runtime.session.sessionId);
      if (!slot.runtime.session.isStreaming && this.sessionHasNonStreamingWork(slot.runtime.session)) throw this.activeOperationError('switching sessions');
      if (runtime.session.sessionId === sessionId) {
        this.acknowledgeSession(sessionId);
        return;
      }
      const live = this.findLiveSlot(sessionId);
      if (live) {
        await this.selectRuntimeSlot(live);
        return;
      }
      // The sidebar summary already owns the validated session path. Avoid a
      // second project-wide SessionManager.list() scan on every selection.
      const session = this.summaryForSessionId(sessionId) ?? await this.sessionRepository.resolve(projectPath, sessionId);
      if (this.project?.path !== projectPath || slot.disposed || this.selectedSlot !== slot) throw this.replacementSuperseded();
      if (!session || session.path.startsWith('live:')) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The selected session no longer exists.', retryable: true });
      if (slot.runtime.session.isStreaming || hasManagedChildren) {
        const opened = await this.createAdditionalSlot(session.path);
        await this.selectRuntimeSlot(opened);
        return;
      }
      if ((await runtime.switchSession(session.path, { cwdOverride: projectPath }))?.cancelled) throw this.replacementCancelled('Session switch');
    }, false);
  }

  async renameSession(sessionId: string, name: string): Promise<RuntimeState> {
    this.requireRuntimeSession();
    const projectPath = this.project?.path;
    if (!projectPath) throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a project before renaming a session.', retryable: true });
    if (this.replacementActive) throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'Wait for the active session operation to finish before renaming.', retryable: true });
    const initialization = this.initialization;
    const normalizedName = name.trim();
    const live = this.findLiveSlot(sessionId);
    if (live) live.runtime.session.setSessionName(normalizedName);
    else await this.sessionRepository.rename(projectPath, sessionId, normalizedName);
    if (initialization !== this.initialization || this.project?.path !== projectPath) throw this.replacementSuperseded();
    this.manualSessionNames.add(this.sessionClaimKey(projectPath, sessionId));
    while (this.manualSessionNames.size > MAX_MANUAL_SESSION_NAME_CLAIMS) this.manualSessionNames.delete(this.manualSessionNames.values().next().value!);
    await this.refreshSessions(true);
    if (initialization !== this.initialization || this.project?.path !== projectPath) throw this.replacementSuperseded();
    this.emitState();
    return this.getState(false);
  }

  async deleteSession(sessionId: string): Promise<RuntimeState> {
    const session = this.requireRuntimeSession();
    const projectPath = this.project?.path;
    if (!projectPath) throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a project before deleting a session.', retryable: true });
    if (session.sessionId === sessionId) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'Switch to another session before deleting this one.', retryable: true });
    if (this.findLiveSlot(sessionId)) throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'Wait for that session to finish before deleting it.', retryable: true });
    const initialization = this.initialization;
    await this.sessionRepository.delete(projectPath, sessionId);
    if (initialization !== this.initialization || this.project?.path !== projectPath) throw this.replacementSuperseded();
    this.manualSessionNames.add(this.sessionClaimKey(projectPath, sessionId));
    while (this.manualSessionNames.size > MAX_MANUAL_SESSION_NAME_CLAIMS) this.manualSessionNames.delete(this.manualSessionNames.values().next().value!);
    try {
      await this.sessionPermissions.delete(projectPath, sessionId);
    } catch (error) {
      if (initialization === this.initialization && this.project?.path === projectPath) {
        this.emitSystemMessage(`Deleted session permission metadata could not be removed: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      }
    }
    if (initialization !== this.initialization || this.project?.path !== projectPath) throw this.replacementSuperseded();
    this.sessionAttention.delete(sessionId);
    this.coldPendingModels.delete(sessionId);
    this.subagents.releaseParent(sessionId);
    this.agentTeams.releaseRoot(sessionId);
    await this.refreshSessions();
    if (initialization !== this.initialization || this.project?.path !== projectPath) throw this.replacementSuperseded();
    this.emitState();
    return this.getState(false);
  }

  async forkSession(entryId: string): Promise<{ state: RuntimeState; selectedText?: string }> {
    let selectedText: string | undefined;
    const state = await this.runReplacement(async (runtime) => {
      if (this.sessionHasActiveWork(runtime.session) || this.subagents.hasOwnedWork(runtime.session.sessionId) || this.agentTeams.hasOwnedWork(runtime.session.sessionId)) throw this.activeOperationError('forking this session');
      if (typeof runtime.fork !== 'function') throw this.unsupported('Session branching');
      const points = runtime.session.getUserMessagesForForking?.() ?? [];
      if (!points.some((point) => point.entryId === entryId)) {
        throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'That branch point is not part of the active session.', retryable: true });
      }
      const result = await runtime.fork(entryId);
      if (result?.cancelled) throw this.replacementCancelled('Session fork');
      selectedText = result.selectedText;
    });
    return { state, ...(selectedText === undefined ? {} : { selectedText }) };
  }

  cloneSession(): Promise<RuntimeState> {
    return this.runReplacement(async (runtime) => {
      if (this.sessionHasActiveWork(runtime.session) || this.subagents.hasOwnedWork(runtime.session.sessionId) || this.agentTeams.hasOwnedWork(runtime.session.sessionId)) throw this.activeOperationError('cloning this session');
      if (this.adapter.supportsClone !== true || typeof runtime.fork !== 'function') throw this.unsupported('Session cloning');
      const leafId = runtime.session.sessionManager?.getLeafId?.();
      if (!leafId) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The current session has no conversation to clone.', retryable: true });
      if ((await runtime.fork(leafId, { position: 'at' }))?.cancelled) throw this.replacementCancelled('Session clone');
    });
  }

  importSession(filePath: string): Promise<RuntimeState> {
    return this.runReplacement(async (runtime) => {
      if (this.sessionHasActiveWork(runtime.session) || this.subagents.hasOwnedWork(runtime.session.sessionId) || this.agentTeams.hasOwnedWork(runtime.session.sessionId)) throw this.activeOperationError('importing a session');
      if (typeof runtime.importFromJsonl !== 'function') throw this.unsupported('Session import');
      if ((await runtime.importFromJsonl(filePath, this.project!.path))?.cancelled) throw this.replacementCancelled('Session import');
    });
  }

  async compact(instructions?: string): Promise<RuntimeState> {
    const session = this.requireIdleSession('compacting context');
    if (this.subagents.hasOwnedWork(session.sessionId) || this.agentTeams.hasOwnedWork(session.sessionId)) throw this.activeOperationError('compacting context while child sessions or Agent Team nodes are live');
    const slot = this.selectedSlot!;
    const initialization = this.initialization;
    const sessionGeneration = slot.sessionGeneration;
    const ownsSession = () => initialization === this.initialization
      && sessionGeneration === slot.sessionGeneration
      && !slot.disposed
      && this.selectedSlot === slot
      && slot.runtime.session === session;
    if (typeof session.compact !== 'function') throw this.unsupported('Context compaction');
    try {
      await session.compact(instructions);
    } catch (error) {
      const normalized = normalizeError(error);
      slot.stateError = normalized;
      if (ownsSession()) this.emitState();
      throw new PiDesktopError(normalized);
    }
    if (!ownsSession()) throw this.replacementSuperseded();
    slot.stateError = null;
    await this.refreshSessions();
    if (!ownsSession()) throw this.replacementSuperseded();
    this.emitState();
    return this.getState(false);
  }

  async dispose(): Promise<void> {
    ++this.initialization;
    this.replacementGeneration += 1;
    this.replacementQueue = Promise.resolve();
    this.replacementActive = false;
    const failures: unknown[] = [];
    try {
      await this.disposeRuntime();
    } catch (error) {
      failures.push(error);
    }
    const pending = await Promise.allSettled([...this.pendingDisposals]);
    failures.push(...pending.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
    this.subagents.reset();
    this.agentTeams.reset();
    this.batcher.dispose();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Pi runtime shutdown was incomplete.');
  }

  private createSlot(runtime: AgentSessionRuntime, projectGeneration: number): RuntimeSlot {
    const owner: { slot: RuntimeSlot | null } = { slot: null };
    const now = new Date().toISOString();
    const slot: RuntimeSlot = {
      runtime,
      projectGeneration,
      sessionGeneration: 0,
      sessionInvalidated: false,
      boundSession: null,
      bindingSession: null,
      bindingPromise: null,
      unsubscribeSession: null,
      disposeModelBoundary: null,
      normalizer: new PiEventNormalizer(() => owner.slot?.activeRunId ?? null),
      activeRunId: null,
      objective: '',
      queuedMessages: [],
      recentlyDequeued: [],
      queueMutationActive: false,
      queueMutationQueue: Promise.resolve(),
      permissionLevel: 'full-access',
      stateError: null,
      contextUsageEstimate: null,
      pendingModel: null,
      pendingThinkingLevel: null,
      boundaryModelOverride: null,
      extensionUi: null,
      extensionUiState: emptyExtensionUiState(),
      attention: null,
      runFailed: false,
      sessionTurnPhase: 'idle',
      deferredChildMessages: [],
      lengthContinuationCount: 0,
      firstPromptText: '',
      firstTitleStarted: false,
      createdAt: now,
      modifiedAt: now,
      disposed: false,
      disposePromise: null,
    };
    owner.slot = slot;
    return slot;
  }

  private configureRuntimeSlot(slot: RuntimeSlot): void {
    const { runtime, projectGeneration } = slot;
    runtime.setBeforeSessionInvalidate?.(() => {
      if (this.initialization === projectGeneration && !slot.disposed && slot.runtime === runtime) this.invalidateSession(slot);
    });
    runtime.setRebindSession(async (session) => {
      if (this.initialization !== projectGeneration || slot.disposed || runtime.session !== session) return;
      await this.replaceSession(slot, session);
      if (this.initialization !== projectGeneration || slot.disposed || runtime.session !== session) return;
      if (!this.replacementActive) {
        await this.refreshSessions(true, true);
        if (this.initialization === projectGeneration && !slot.disposed) this.emitState(this.selectedSlot === slot);
      }
    });
  }

  private invalidateSession(slot: RuntimeSlot | null = this.selectedSlot): void {
    if (!slot) return;
    const invalidatedSession = slot.boundSession ?? slot.runtime.session;
    slot.sessionGeneration += 1;
    if (slot.pendingModel) this.rememberColdPendingModel(invalidatedSession.sessionId, slot.pendingModel.info);
    if (slot.pendingThinkingLevel) this.rememberColdPendingThinkingLevel(invalidatedSession.sessionId, slot.pendingThinkingLevel.level);
    slot.unsubscribeSession?.();
    slot.unsubscribeSession = null;
    slot.disposeModelBoundary?.();
    slot.disposeModelBoundary = null;
    slot.extensionUi?.clear();
    slot.extensionUi = null;
    slot.extensionUiState = emptyExtensionUiState();
    slot.boundSession = null;
    slot.bindingSession = null;
    slot.sessionInvalidated = true;
    slot.activeRunId = null;
    slot.objective = '';
    slot.queuedMessages = [];
    slot.recentlyDequeued = [];
    slot.queueMutationActive = false;
    slot.queueMutationQueue = Promise.resolve();
    slot.permissionLevel = 'full-access';
    slot.stateError = null;
    slot.contextUsageEstimate = null;
    slot.pendingModel = null;
    slot.pendingThinkingLevel = null;
    slot.boundaryModelOverride = null;
    slot.attention = null;
    slot.runFailed = false;
    slot.sessionTurnPhase = 'idle';
    slot.deferredChildMessages = [];
    slot.firstPromptText = '';
    slot.firstTitleStarted = false;
    slot.createdAt = new Date().toISOString();
    slot.modifiedAt = slot.createdAt;
    slot.normalizer.resetSession();
    this.subagents.releaseParent(invalidatedSession.sessionId);
    this.agentTeams.releaseRoot(invalidatedSession.sessionId);
    if (this.selectedSlot === slot) this.batcher.clear();
  }

  private replaceSession(slot: RuntimeSlot, session: AgentSession): Promise<void> {
    if (slot.disposed || slot.runtime.session !== session) return Promise.resolve();
    if (slot.bindingSession === session && slot.bindingPromise) return slot.bindingPromise;
    // Real AgentSessionRuntime invalidates synchronously. This fallback keeps
    // custom adapters safe when they only invoke the rebind callback.
    if (!slot.sessionInvalidated) this.invalidateSession(slot);
    const binding = Promise.resolve().then(() => this.bindSession(slot, session));
    let tracked: Promise<void>;
    tracked = binding.finally(() => {
      if (slot.bindingPromise !== tracked) return;
      slot.bindingPromise = null;
      slot.bindingSession = null;
    });
    slot.bindingSession = session;
    slot.bindingPromise = tracked;
    return tracked;
  }

  private async bindSession(slot: RuntimeSlot, session: AgentSession): Promise<void> {
    if (slot.disposed || slot.runtime.session !== session) return;
    const generation = slot.sessionGeneration;
    const runtime = slot.runtime;
    const runtimeCwd = (runtime as AgentSessionRuntime & { cwd?: unknown }).cwd;
    if (this.project && typeof runtimeCwd === 'string' && path.resolve(runtimeCwd) !== path.resolve(this.project.path)) {
      throw new PiDesktopError({ code: 'INVALID_PROJECT', message: 'Pi refused a session whose working directory differs from the active project.', retryable: false });
    }
    const ownsSession = () => this.initialization === slot.projectGeneration
      && !slot.disposed
      && generation === slot.sessionGeneration
      && slot.runtime === runtime
      && runtime.session === session;
    const replaceFromExtension = async (
      feature: string,
      operation: () => Promise<{ cancelled?: boolean }>,
    ): Promise<{ cancelled: boolean }> => {
      if (!ownsSession() || this.selectedSlot !== slot || this.sessionHasActiveWork(session) || this.subagents.hasOwnedWork(session.sessionId) || this.agentTeams.hasOwnedWork(session.sessionId)) return { cancelled: true };
      try {
        await this.runReplacement(async (current, currentSlot) => {
          if (current !== runtime || currentSlot !== slot || !ownsSession()) throw this.replacementSuperseded();
          if ((await operation()).cancelled) throw this.replacementCancelled(feature);
        });
        return { cancelled: false };
      } catch (error) {
        if (!ownsSession() || (error instanceof PiDesktopError && /cancelled|superseded/u.test(error.normalized.message))) return { cancelled: true };
        throw error;
      }
    };

    const extensionUi = createPiExtensionUiBridge({
      notify: (message, level) => { if (ownsSession() && this.selectedSlot === slot) this.emitSystemMessage(message, level); },
      onStateChange: (state) => {
        if (!ownsSession()) return;
        slot.extensionUiState = state;
        if (this.selectedSlot === slot) this.emitState();
      },
    });
    slot.extensionUi = extensionUi;
    slot.extensionUiState = extensionUi.getState();
    await session.bindExtensions({
      uiContext: extensionUi.context,
      mode: 'rpc',
      commandContextActions: {
        waitForIdle: () => ownsSession() ? session.waitForIdle() : Promise.resolve(),
        newSession: async (options) => replaceFromExtension('New session', async () => runtime.newSession(options)),
        fork: async (entryId, options) => replaceFromExtension('Session fork', async () => runtime.fork(entryId, options)),
        navigateTree: async (targetId, options) => replaceFromExtension('Branch navigation', () => session.navigateTree(targetId, options)),
        switchSession: async (sessionPath, options) => replaceFromExtension('Session switch', async () => runtime.switchSession(sessionPath, { ...options, cwdOverride: this.project!.path })),
        reload: async () => {
          await replaceFromExtension('Session reload', async () => {
            extensionUi.clear();
            await session.reload();
            return { cancelled: false };
          });
        },
      },
      shutdownHandler: () => { if (ownsSession() && this.selectedSlot === slot) this.emitSystemMessage('An extension requested shutdown. Close Fate UI when you are ready.', 'warning'); },
      onError: (error) => { if (ownsSession() && this.selectedSlot === slot) this.emitSystemMessage(`Extension error: ${error.error}`, 'error'); },
    });
    if (!ownsSession()) return;
    assertOwnedToolDefinitions(session, ownedCustomToolsBySession.get(session) ?? []);
    const access = toolAccessBySession.get(session);
    const coldPendingModel = this.coldPendingModels.get(session.sessionId);
    if (coldPendingModel) {
      const model = this.modelRuntime?.getModel(coldPendingModel.provider, coldPendingModel.id);
      if (model && this.models.some((candidate) => candidate.provider === coldPendingModel.provider && candidate.id === coldPendingModel.id)) {
        slot.pendingModel = { token: randomUUID(), model, info: toModelInfo(model) };
      }
      this.coldPendingModels.delete(session.sessionId);
    }
    const coldPendingThinkingLevel = this.coldPendingThinkingLevels.get(session.sessionId);
    if (coldPendingThinkingLevel) {
      slot.pendingThinkingLevel = { token: randomUUID(), level: coldPendingThinkingLevel };
      this.coldPendingThinkingLevels.delete(session.sessionId);
    }
    slot.permissionLevel = await this.permissionForSession(session, slot);
    if (!ownsSession()) return;
    session.setActiveToolsByName(activeToolsForPermission(session.getActiveToolNames(), slot.permissionLevel));
    this.subagents.restoreParent(session);
    this.agentTeams.restoreRoot(session);
    const restoredV2 = this.agentTeams.getTeams(session.sessionId).length > 0;
    const restoredLegacy = this.subagents.getRuns(session.sessionId).length > 0 || this.subagents.getWorkflowViews(session.sessionId).length > 0;
    const orchestrationMode = restoredV2 ? 'v2' : restoredLegacy ? 'legacy' : this.agentTeamMode;
    const selectedOrchestration = orchestrationMode === 'v2' ? V2_ORCHESTRATION_TOOLS : LEGACY_ORCHESTRATION_TOOLS;
    const ordinaryActiveTools = session.getActiveToolNames().filter((name) => !ALL_ORCHESTRATION_TOOLS.has(name));
    session.setActiveToolsByName(activeToolsForPermission([...ordinaryActiveTools, ...selectedOrchestration], slot.permissionLevel));
    if (access) access.fullAccess = slot.permissionLevel === 'full-access';
    this.installModelBoundary(slot, session, ownsSession);
    slot.sessionTurnPhase = session.isStreaming ? 'active' : 'idle';
    slot.unsubscribeSession = session.subscribe((event: AgentSessionEvent) => this.handleSessionEvent(slot, session, generation, event));
    slot.boundSession = session;
    slot.sessionInvalidated = false;
    const existingSummary = this.summaryForSessionId(session.sessionId);
    slot.createdAt = existingSummary?.createdAt ?? slot.createdAt;
    // Loading a session is navigation, not activity. Keep persisted recency so
    // the Recently modified list changes only after the session does work.
    slot.modifiedAt = existingSummary?.modifiedAt ?? slot.modifiedAt;
  }

  private installModelBoundary(slot: RuntimeSlot, session: AgentSession, ownsSession: () => boolean): void {
    slot.disposeModelBoundary?.();
    slot.disposeModelBoundary = null;
    const agent = session.agent;
    if (!agent || typeof agent.subscribe !== 'function' || typeof agent.streamFunction !== 'function') return;
    const originalStreamFunction = agent.streamFunction;
    const wrappedStreamFunction: typeof agent.streamFunction = (model, context, options) => {
      const staged = slot.boundaryModelOverride;
      slot.boundaryModelOverride = null;
      if (!staged) return originalStreamFunction(model, context, options);
      // The loop resolved auth for its captured (previous) model before invoking
      // streamFunction. Drop that key so ModelRuntime resolves credentials for
      // the staged provider rather than forwarding credentials across providers.
      const { apiKey: _previousApiKey, reasoning: _previousReasoning, ...optionsWithoutCapturedModel } = options ?? {};
      const nextOptions = staged.model.reasoning && session.thinkingLevel !== 'off'
        ? { ...optionsWithoutCapturedModel, reasoning: session.thinkingLevel }
        : optionsWithoutCapturedModel;
      return originalStreamFunction(staged.model, context, nextOptions);
    };
    agent.streamFunction = wrappedStreamFunction;
    const unsubscribe = agent.subscribe(async (event) => {
      if (!ownsSession()) return;
      if (event.type === 'agent_start' || event.type === 'agent_end') {
        slot.boundaryModelOverride = null;
        slot.recentlyDequeued = [];
        return;
      }
      if (event.type !== 'message_start' || event.message.role !== 'user') {
        if (event.type !== 'message_end' || event.message.role !== 'user') slot.recentlyDequeued = [];
        return;
      }
      slot.boundaryModelOverride = null;
      let queued = slot.recentlyDequeued.shift();
      if (!queued) {
        const text = messageText(event.message);
        const index = slot.queuedMessages.findIndex((item) => item.transportText === text);
        if (index >= 0) queued = slot.queuedMessages.splice(index, 1)[0];
      }
      if (!queued?.boundModel && !queued?.boundThinkingLevel) return;
      try {
        if (queued.boundModel) await session.setModel(queued.boundModel.model);
        if (!ownsSession()) return;
        if (queued.boundThinkingLevel) session.setThinkingLevel(queued.boundThinkingLevel.level);
        slot.boundaryModelOverride = queued.boundModel ?? null;
        slot.stateError = null;
        if (this.selectedSlot === slot) this.emitState();
      } catch (error) {
        const normalized = normalizeError(error);
        slot.runFailed = true;
        slot.stateError = normalized;
        if (this.selectedSlot === slot) this.emitError(normalized);
        throw error;
      }
    });
    slot.disposeModelBoundary = () => {
      unsubscribe();
      if (agent.streamFunction === wrappedStreamFunction) agent.streamFunction = originalStreamFunction;
    };
  }

  private sendChildGeneratedMessage(
    slot: RuntimeSlot,
    session: AgentSession,
    message: SessionCustomMessage,
    activeDelivery: ActiveCustomMessageDelivery,
    triggerWhenIdle: boolean,
  ): Promise<void> {
    if (slot.disposed || slot.runtime.session !== session) return Promise.resolve();
    if (session.isStreaming && slot.sessionTurnPhase !== 'active') {
      // Pi's loop has emitted agent_end but AgentSession still reports streaming
      // until agent_settled. Queueing a steer/follow-up in this window makes the
      // SDK call continue() with an assistant as the final context message.
      slot.deferredChildMessages.push({ message, activeDelivery });
      return Promise.resolve();
    }
    return session.sendCustomMessage(
      message,
      session.isStreaming
        ? { triggerTurn: triggerWhenIdle, deliverAs: activeDelivery }
        : { triggerTurn: triggerWhenIdle },
    );
  }

  private customMessageWasAccepted(session: AgentSession, message: SessionCustomMessage): boolean {
    return session.messages.some((candidate) => candidate.role === 'custom'
      && candidate.customType === message.customType
      && candidate.content === message.content
      && candidate.details === message.details);
  }

  private flushDeferredChildMessages(slot: RuntimeSlot, session: AgentSession, generation: number): void {
    if (slot.deferredChildMessages.length === 0) return;
    const pending = slot.deferredChildMessages.splice(0);
    const ownsSession = () => this.initialization === slot.projectGeneration
      && !slot.disposed
      && generation === slot.sessionGeneration
      && slot.runtime.session === session;
    void (async () => {
      let submitted = 0;
      try {
        if (session.isStreaming) {
          for (const item of pending) {
            if (!ownsSession()) return;
            await session.sendCustomMessage(item.message, { triggerTurn: true, deliverAs: item.activeDelivery });
            submitted += 1;
          }
          return;
        }
        for (let index = 0; index < pending.length; index += 1) {
          if (!ownsSession()) return;
          // Append every deferred report before waking the model once. This
          // preserves all child results without racing multiple parent turns.
          await session.sendCustomMessage(pending[index]!.message, { triggerTurn: index === pending.length - 1 });
          submitted = index + 1;
        }
      } catch (error) {
        // A child notification is never allowed to fail the root run. If Pi
        // accepted the current custom message before its triggered turn failed,
        // do not duplicate it; otherwise retain it for the next direct turn.
        if (submitted < pending.length && this.customMessageWasAccepted(session, pending[submitted]!.message)) submitted += 1;
        let fallbackFailed = false;
        for (const item of pending.slice(submitted)) {
          if (!ownsSession()) return;
          try {
            await session.sendCustomMessage(item.message, { triggerTurn: false, deliverAs: 'nextTurn' });
          } catch {
            fallbackFailed = true;
          }
        }
        if (fallbackFailed && this.selectedSlot === slot) {
          this.emitSystemMessage(
            `A child report could not be attached to the parent model turn: ${error instanceof Error ? error.message : String(error)}. The child result remains available in the Agents inspector.`,
            'warning',
          );
        }
      }
    })();
  }

  private handleSessionEvent(slot: RuntimeSlot, session: AgentSession, generation: number, event: AgentSessionEvent): void {
    if (this.initialization !== slot.projectGeneration || slot.disposed || generation !== slot.sessionGeneration || slot.runtime.session !== session) return;
    if (event.type === 'agent_start') slot.sessionTurnPhase = 'active';
    else if (event.type === 'agent_end') slot.sessionTurnPhase = 'ending';
    else if (event.type === 'agent_settled') slot.sessionTurnPhase = 'idle';
    const selected = this.selectedSlot === slot;
    if (event.type === 'message_end' || event.type === 'session_info_changed' || event.type === 'compaction_end') {
      slot.modifiedAt = new Date().toISOString();
    }
    if (event.type === 'compaction_end' && !event.aborted && !event.errorMessage) {
      const estimatedTokensAfter = event.result?.estimatedTokensAfter;
      slot.contextUsageEstimate = typeof estimatedTokensAfter === 'number' && Number.isFinite(estimatedTokensAfter) && estimatedTokensAfter >= 0
        ? Math.round(estimatedTokensAfter)
        : null;
    }
    if (event.type === 'queue_update' && !slot.queueMutationActive) {
      this.reconcileQueuedMessagesForSlot(slot, event.steering.length, event.followUp.length, true);
    }
    if (event.type === 'agent_start') {
      slot.runFailed = false;
      if (selected) this.acknowledgeSession(session.sessionId);
      else this.setSessionAttention(slot, 'running');
    }
    if (event.type === 'message_start' && event.message.role === 'user') {
      slot.lengthContinuationCount = 0;
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const message = event.message as typeof event.message & { isError?: unknown; stopReason?: unknown };
      // A recovered parent turn supersedes an earlier provider or child failure.
      slot.runFailed = message.isError === true || message.stopReason === 'error';
      const queuedUserRequest = slot.queuedMessages.length > 0
        || (session.getSteeringMessages?.().length ?? 0) > 0
        || (session.getFollowUpMessages?.().length ?? 0) > 0;
      if (message.stopReason === 'length' && message.isError !== true && !queuedUserRequest) {
        if (slot.lengthContinuationCount < MAX_LENGTH_CONTINUATIONS_PER_USER_TURN) {
          slot.lengthContinuationCount += 1;
          void session.sendCustomMessage({
            customType: 'fate-length-continuation',
            content: [{ type: 'text', text: LENGTH_CONTINUATION_PROMPT }],
            display: false,
            details: { attempt: slot.lengthContinuationCount },
          }, { deliverAs: 'followUp' }).catch((error: unknown) => {
            if (
              this.initialization !== slot.projectGeneration
              || slot.disposed
              || generation !== slot.sessionGeneration
              || slot.runtime.session !== session
            ) return;
            slot.runFailed = true;
            slot.stateError = normalizeError(error);
            if (this.selectedSlot === slot) this.emitError(slot.stateError);
          });
        } else {
          slot.runFailed = true;
          slot.stateError = {
            code: 'INVALID_REQUEST',
            message: 'The model reached its output limit repeatedly and could not finish automatically.',
            actionable: 'Send “continue” to resume, or choose a model with a larger output limit.',
            retryable: true,
          };
          if (selected) this.emitError(slot.stateError);
        }
      }
    }

    if (selected) {
      const normalizedEvents = slot.normalizer.normalize(event);
      const visibleEvents = event.type === 'agent_end' && event.willRetry
        ? normalizedEvents.filter((normalizedEvent) => normalizedEvent.type !== 'run.completed')
        : normalizedEvents;
      for (const normalizedEvent of visibleEvents) {
        if (normalizedEvent.type === 'error') {
          slot.stateError = normalizedEvent.error;
          slot.runFailed = true;
        }
      }
      this.enqueueMany(visibleEvents);
    }

    if (event.type === 'agent_start') {
      this.mergeLiveSessionSummaries();
      this.emitState();
      return;
    }
    if (event.type === 'compaction_end' && selected && !event.errorMessage) {
      this.emitState();
      return;
    }
    if (event.type === 'agent_settled') {
      this.flushDeferredChildMessages(slot, session, generation);
      // An agent_settled extension handler may synchronously start another run.
      // Keep that slot live and yellow instead of disposing the successor run.
      if (this.sessionHasActiveWork(session)) {
        if (!selected) this.setSessionAttention(slot, 'running');
        this.mergeLiveSessionSummaries();
        this.emitState();
      } else if (selected) {
        this.mergeLiveSessionSummaries();
        this.emitState();
        this.refreshSettledSlot(slot, session, generation);
      } else {
        this.settleInactiveSlot(slot);
      }
      return;
    }
    if (event.type === 'thinking_level_changed' && selected) {
      this.emitState();
      return;
    }
    if (event.type === 'session_info_changed') {
      this.mergeLiveSessionSummaries();
      this.emitState();
    }
  }

  private refreshSettledSlot(slot: RuntimeSlot, session: AgentSession, generation: number): void {
    const initialization = this.initialization;
    void this.refreshSessions(true, true).then(() => {
      if (
        initialization === this.initialization
        && !slot.disposed
        && generation === slot.sessionGeneration
        && slot.runtime.session === session
      ) this.emitState();
    }).catch((error: unknown) => {
      if (
        initialization !== this.initialization
        || slot.disposed
        || generation !== slot.sessionGeneration
        || slot.runtime.session !== session
        || this.selectedSlot !== slot
      ) return;
      this.emitSystemMessage(`The session list could not be refreshed: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    });
  }

  private settleInactiveSlot(slot: RuntimeSlot): void {
    if (slot.disposed || this.selectedSlot === slot || this.sessionHasActiveWork(slot.runtime.session) || this.subagents.hasOwnedWork(slot.runtime.session.sessionId) || this.agentTeams.hasOwnedWork(slot.runtime.session.sessionId)) return;
    const initialization = this.initialization;
    const sessionId = slot.runtime.session.sessionId;
    const attentionRevision = this.setSessionAttention(slot, slot.runFailed ? 'error' : 'completed');
    this.mergeLiveSessionSummaries();
    this.emitState();

    void this.disposeSlot(slot, false).then(() => {
      if (initialization !== this.initialization) return;
      void this.refreshSessions(true, true).then(() => {
        if (initialization === this.initialization) this.emitState();
      }).catch(() => undefined);
    }, (error: unknown) => {
      if (
        initialization !== this.initialization
        || this.sessionAttentionRevision(sessionId) !== attentionRevision
      ) return;
      if (this.selectedSlot?.runtime.session.sessionId === sessionId) {
        this.acknowledgeSession(sessionId);
        this.emitSystemMessage(`The previous live session could not be fully released: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      } else {
        this.setSessionAttention(slot, 'error');
      }
      this.mergeLiveSessionSummaries();
      this.emitState();
    });
  }

  private requireRuntimeSession(): AgentSession {
    if (!this.runtime) {
      throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open and trust a project before using Pi.', retryable: true });
    }
    return this.runtime.session;
  }

  private requireRuntimeIdleSession(action: string): AgentSession {
    const session = this.requireRuntimeSession();
    if (this.replacementActive || this.sessionHasActiveWork(session)) {
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: `Wait for the active Pi operation to finish before ${action}.`, retryable: true });
    }
    return session;
  }

  private requireSession(): AgentSession {
    if (this.status === 'auth-required') throw new PiDesktopError(this.stateError ?? authRequiredError());
    return this.requireRuntimeSession();
  }

  private requireIdleSession(action: string): AgentSession {
    const session = this.requireSession();
    if (this.replacementActive || this.sessionHasActiveWork(session)) {
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: `Wait for the active Pi operation to finish before ${action}.`, retryable: true });
    }
    return session;
  }

  private sessionHasNonStreamingWork(session: AgentSession): boolean {
    return session.isCompacting === true || session.isBashRunning === true;
  }

  private sessionHasActiveWork(session: AgentSession): boolean {
    return session.isStreaming === true || this.sessionHasNonStreamingWork(session);
  }

  private runReplacement(operation: (runtime: AgentSessionRuntime, slot: RuntimeSlot) => Promise<void>, refreshSessionList = true): Promise<RuntimeState> {
    this.requireRuntimeSession();
    const replacementGeneration = this.replacementGeneration;
    const ownsGeneration = () => replacementGeneration === this.replacementGeneration;
    const execute = async (): Promise<RuntimeState> => {
      if (!ownsGeneration()) throw this.replacementSuperseded();
      const slot = this.selectedSlot;
      if (!slot || slot.disposed) throw this.replacementSuperseded();
      const runtime = slot.runtime;
      this.replacementActive = true;
      slot.stateError = null;
      this.emitState();
      let failure: AppError | null = null;
      let includeHistory = false;
      let finalState: RuntimeState | null = null;
      try {
        await operation(runtime, slot);
        if (!ownsGeneration()) throw this.replacementSuperseded();
        const currentSlot = this.selectedSlot;
        if (!currentSlot || currentSlot.disposed) throw this.replacementSuperseded();
        this.acknowledgeSession(currentSlot.runtime.session.sessionId);
        if (refreshSessionList) {
          try {
            await this.refreshSessions(true);
          } catch (error) {
            if (!ownsGeneration()) throw this.replacementSuperseded();
            this.emitSystemMessage(`The session list could not be refreshed: ${error instanceof Error ? error.message : String(error)}`, 'warning');
          }
        } else {
          // Switching does not mutate the persistent session index. Re-project
          // the active/live flags synchronously and leave disk refreshes to the
          // existing lifecycle refresh points.
          this.mergeLiveSessionSummaries();
        }
        if (!ownsGeneration()) throw this.replacementSuperseded();
        this.status = this.models.length > 0 ? 'ready' : 'auth-required';
        includeHistory = true;
      } catch (error) {
        if (!ownsGeneration()) throw this.replacementSuperseded();
        failure = error instanceof PiDesktopError ? error.normalized : normalizeError(error);
        const runtimeUnusable = !(error instanceof PiDesktopError) && slot.sessionInvalidated && this.selectedSlot === slot;
        if (runtimeUnusable) {
          this.selectedSlot = null;
          await this.disposeSlot(slot, true).catch(() => undefined);
          if (!ownsGeneration()) throw this.replacementSuperseded();
          this.status = 'error';
        } else {
          this.status = this.models.length > 0 ? 'ready' : 'auth-required';
        }
        this.emitError(failure);
      } finally {
        if (ownsGeneration()) {
          this.replacementActive = false;
          finalState = this.emitState(includeHistory);
        }
      }
      if (failure) throw new PiDesktopError(failure);
      return finalState ?? this.getState();
    };
    const result = this.replacementQueue.then(execute, execute);
    this.replacementQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private getCommands(session: AgentSession | undefined): NonNullable<RuntimeState['commands']> {
    if (!session) return [];
    const extensionCommands = session.extensionRunner?.getRegisteredCommands?.().map((command) => ({
      name: command.invocationName.slice(0, 500),
      description: (command.description ?? '').slice(0, 2_000),
      source: 'extension' as const,
    })) ?? [];
    const promptCommands = session.promptTemplates?.map((command) => ({
      name: command.name.slice(0, 500),
      description: (command.description ?? '').slice(0, 2_000),
      source: 'prompt' as const,
    })) ?? [];
    const skillCommands = this.runtime?.services?.resourceLoader?.getSkills?.().skills.map((skill) => ({
      name: `skill:${skill.name}`.slice(0, 500),
      description: skill.description.slice(0, 2_000),
      source: 'skill' as const,
    })) ?? [];
    return [...extensionCommands, ...promptCommands, ...skillCommands].slice(0, 5_000);
  }

  private async applyQueueMutation(input: QueueMutationInput, slot: RuntimeSlot): Promise<QueueMutationResult> {
    if (this.selectedSlot !== slot || slot.disposed) throw this.replacementSuperseded();
    if (this.status === 'auth-required') throw new PiDesktopError(this.stateError ?? authRequiredError());
    const session = slot.runtime.session;
    const initialization = this.initialization;
    const sessionGeneration = slot.sessionGeneration;
    const ownsSession = () => initialization === this.initialization
      && !slot.disposed
      && sessionGeneration === slot.sessionGeneration
      && this.selectedSlot === slot
      && slot.runtime.session === session;
    if (this.replacementActive) {
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'Wait for the session change to finish before editing queued messages.', retryable: true });
    }
    const target = slot.queuedMessages.find((item) => item.id === input.id);
    if (!target) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'That queued message is no longer waiting.', retryable: true });
    }
    const steeringCount = session.getSteeringMessages?.().length ?? 0;
    const followUpCount = session.getFollowUpMessages?.().length ?? 0;
    const mirroredSteering = slot.queuedMessages.filter((item) => item.behavior === 'steer').length;
    const mirroredFollowUp = slot.queuedMessages.filter((item) => item.behavior === 'followUp').length;
    if (!session.isStreaming || steeringCount !== mirroredSteering || followUpCount !== mirroredFollowUp) {
      this.reconcileQueuedMessagesForSlot(slot, steeringCount, followUpCount, false);
      this.emitState();
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'That message is already being sent. The queue has been refreshed.', retryable: true });
    }

    const next = slot.queuedMessages.flatMap((item): QueuedMessageRecord[] => {
      if (item.id !== input.id) return [item];
      if (input.action === 'cancel' || input.action === 'edit') return [];
      return [{ ...item, behavior: input.action }];
    });
    const restored = input.action === 'edit'
      ? { text: target.text, ...(target.images?.length ? { images: target.images.map((image) => ({ ...image })) } : {}) }
      : undefined;

    slot.queueMutationActive = true;
    try {
      session.clearQueue();
      if (!ownsSession()) throw this.replacementSuperseded();
      // From this point onward the SDK queue no longer matches the old mirror.
      // Track the intended survivors so partial requeue failures can still be
      // reconciled against Pi's authoritative public queue counts.
      slot.queuedMessages = next;
      for (const item of next.filter((queued) => queued.behavior === 'steer')) {
        await session.steer(item.transportText, item.images?.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })));
        if (!ownsSession()) throw this.replacementSuperseded();
      }
      for (const item of next.filter((queued) => queued.behavior === 'followUp')) {
        await session.followUp(item.transportText, item.images?.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })));
        if (!ownsSession()) throw this.replacementSuperseded();
      }
      this.reconcileQueuedMessagesForSlot(slot, session.getSteeringMessages?.().length ?? 0, session.getFollowUpMessages?.().length ?? 0, false);
      if (input.action === 'edit' && target.boundModel && !slot.pendingModel) slot.pendingModel = target.boundModel;
      if (input.action === 'edit' && target.boundThinkingLevel && !slot.pendingThinkingLevel) slot.pendingThinkingLevel = target.boundThinkingLevel;
      slot.stateError = null;
      this.emitState();
      return { state: this.getState(false), ...(restored ? { restored } : {}) };
    } catch (error) {
      if (ownsSession()) {
        this.reconcileQueuedMessagesForSlot(slot, session.getSteeringMessages?.().length ?? 0, session.getFollowUpMessages?.().length ?? 0, false);
        if (input.action === 'edit' && target.boundModel && !slot.pendingModel) slot.pendingModel = target.boundModel;
        if (input.action === 'edit' && target.boundThinkingLevel && !slot.pendingThinkingLevel) slot.pendingThinkingLevel = target.boundThinkingLevel;
        this.emitState();
      }
      throw error;
    } finally {
      slot.queueMutationActive = false;
    }
  }

  private reconcileQueuedMessagesForSlot(slot: RuntimeSlot, steeringCount: number, followUpCount: number, captureDequeued: boolean): void {
    const steering = slot.queuedMessages.filter((item) => item.behavior === 'steer');
    const followUp = slot.queuedMessages.filter((item) => item.behavior === 'followUp');
    const retained = new Set([
      ...(steeringCount === 0 ? [] : steering.slice(-steeringCount).map((item) => item.id)),
      ...(followUpCount === 0 ? [] : followUp.slice(-followUpCount).map((item) => item.id)),
    ]);
    const removed = slot.queuedMessages.filter((item) => !retained.has(item.id));
    slot.queuedMessages = slot.queuedMessages.filter((item) => retained.has(item.id));
    if (captureDequeued && removed.length > 0) slot.recentlyDequeued = [...slot.recentlyDequeued, ...removed].slice(-MAX_QUEUED_MESSAGES);
  }

  private async createAdditionalSlot(sessionPath?: string): Promise<RuntimeSlot> {
    if (!this.project || !this.modelRuntime) throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open and trust a project before using Pi.', retryable: true });
    for (const slot of [...this.liveSlots]) {
      if (slot !== this.selectedSlot && !this.sessionHasActiveWork(slot.runtime.session) && !this.subagents.hasOwnedWork(slot.runtime.session.sessionId) && !this.agentTeams.hasOwnedWork(slot.runtime.session.sessionId)) await this.disposeSlot(slot, false);
    }
    if (this.liveSlots.size + this.pendingDisposals.size >= MAX_LIVE_RUNTIME_SLOTS) {
      throw new PiDesktopError({
        code: 'RUN_ACTIVE',
        message: `Up to ${MAX_LIVE_RUNTIME_SLOTS} Pi sessions can be live at once. Wait for a background session to finish before starting another.`,
        retryable: true,
      });
    }
    const generation = this.initialization;
    const runtime = await this.adapter.createRuntime(this.project.path, this.modelRuntime, this.project.trusted, this.orchestrationTools(this.modelRuntime), this.getImageGenerationSettings);
    if (generation !== this.initialization) {
      await runtime.dispose().catch(() => undefined);
      throw this.replacementSuperseded();
    }
    const slot = this.createSlot(runtime, generation);
    this.liveSlots.add(slot);
    this.configureRuntimeSlot(slot);
    try {
      if (sessionPath) {
        const result = await runtime.switchSession(sessionPath, { cwdOverride: this.project.path });
        if (result?.cancelled) throw this.replacementCancelled('Session switch');
      }
      if (slot.boundSession !== runtime.session) await this.replaceSession(slot, runtime.session);
      if (generation !== this.initialization || slot.disposed) throw this.replacementSuperseded();
      return slot;
    } catch (error) {
      await this.disposeSlot(slot, true).catch(() => undefined);
      throw error;
    }
  }

  private async selectRuntimeSlot(slot: RuntimeSlot): Promise<void> {
    if (slot.disposed || !this.liveSlots.has(slot)) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'That live session is no longer available.', retryable: true });
    const previous = this.selectedSlot;
    if (previous === slot) {
      this.acknowledgeSession(slot.runtime.session.sessionId);
      this.mergeLiveSessionSummaries();
      return;
    }
    this.selectedSlot = slot;
    this.acknowledgeSession(slot.runtime.session.sessionId);
    slot.attention = null;
    this.batcher.clear();
    if (previous && !previous.disposed) {
      if (this.sessionHasActiveWork(previous.runtime.session) || this.subagents.hasOwnedWork(previous.runtime.session.sessionId) || this.agentTeams.hasOwnedWork(previous.runtime.session.sessionId)) {
        this.setSessionAttention(previous, 'running');
      } else {
        const initialization = this.initialization;
        const promotedSession = slot.runtime.session;
        const promotedGeneration = slot.sessionGeneration;
        // disposeSlot detaches synchronously. Do not make promotion wait on
        // extension shutdown or filesystem cleanup from the previous session.
        void this.disposeSlot(previous, false).catch((error: unknown) => {
          if (
            initialization === this.initialization
            && this.selectedSlot === slot
            && !slot.disposed
            && slot.sessionGeneration === promotedGeneration
            && slot.runtime.session === promotedSession
          ) {
            this.emitSystemMessage(`The previous live session could not be fully released: ${error instanceof Error ? error.message : String(error)}`, 'warning');
          }
        });
      }
    }
    this.mergeLiveSessionSummaries();
  }

  private orchestrationTools(modelRuntime: ModelRuntime): ToolDefinition[] {
    const legacy = this.subagents.createTools(modelRuntime);
    const v2 = this.agentTeams.createRootTools(modelRuntime);
    return [...legacy, ...v2];
  }

  private findLiveSlot(sessionId: string): RuntimeSlot | undefined {
    for (const slot of this.liveSlots) {
      if (!slot.disposed && slot.runtime.session.sessionId === sessionId) return slot;
    }
    return undefined;
  }

  private runningSessionCount(): number {
    let count = 0;
    for (const slot of this.liveSlots) {
      if (!slot.disposed && (this.sessionHasActiveWork(slot.runtime.session) || this.subagents.hasActiveRuns(slot.runtime.session.sessionId) || this.agentTeams.hasActiveWork(slot.runtime.session.sessionId))) count += 1;
    }
    return count;
  }

  private sessionClaimKey(projectPath: string, sessionId: string): string {
    return `${projectPath}\0${sessionId}`;
  }

  private rememberColdPendingModel(sessionId: string, model: ModelInfo): void {
    this.coldPendingModels.delete(sessionId);
    this.coldPendingModels.set(sessionId, model);
    while (this.coldPendingModels.size > MAX_COLD_PENDING_MODELS) this.coldPendingModels.delete(this.coldPendingModels.keys().next().value!);
  }

  private rememberColdPendingThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    this.coldPendingThinkingLevels.delete(sessionId);
    this.coldPendingThinkingLevels.set(sessionId, level);
    while (this.coldPendingThinkingLevels.size > MAX_COLD_PENDING_MODELS) this.coldPendingThinkingLevels.delete(this.coldPendingThinkingLevels.keys().next().value!);
  }

  private recordSessionAttention(sessionId: string, value: SessionAttention | null): number {
    const revision = ++this.attentionRevision;
    this.sessionAttention.delete(sessionId);
    this.sessionAttention.set(sessionId, { value, revision });
    while (this.sessionAttention.size > MAX_SESSION_ATTENTION_ENTRIES) this.sessionAttention.delete(this.sessionAttention.keys().next().value!);
    return revision;
  }

  private setSessionAttention(slot: RuntimeSlot, attention: SessionAttention): number {
    const sessionId = slot.runtime.session.sessionId;
    if (this.selectedSlot === slot) return this.acknowledgeSession(sessionId);
    slot.attention = attention;
    return this.recordSessionAttention(sessionId, attention);
  }

  private acknowledgeSession(sessionId: string): number {
    const revision = this.recordSessionAttention(sessionId, null);
    const slot = this.findLiveSlot(sessionId);
    if (slot) slot.attention = null;
    this.sessions = this.sessions.map((summary) => summary.id === sessionId ? { ...summary, attention: null } : summary);
    return revision;
  }

  private sessionAttentionRevision(sessionId: string): number {
    return this.sessionAttention.get(sessionId)?.revision ?? 0;
  }

  private sessionAttentionValue(sessionId: string, fallback: SessionAttention | null): SessionAttention | null {
    const record = this.sessionAttention.get(sessionId);
    return record ? record.value : fallback;
  }

  private liveSessionSummary(slot: RuntimeSlot, session = slot.runtime.session, promptOverride = slot.firstPromptText): SessionSummary {
    const existing = this.summaryForSessionId(session.sessionId);
    let firstMessage = promptOverride;
    if (!firstMessage) {
      const first = session.messages.find((message) => Boolean(message) && typeof message === 'object' && (message as { role?: unknown }).role === 'user');
      if (first) firstMessage = messageText(first);
    }
    firstMessage = firstMessage.trim().slice(0, 2_000) || existing?.firstMessage || '(no messages)';
    const explicitName = session.sessionName ?? session.sessionManager?.getSessionName?.();
    const title = explicitName?.trim()
      ? sessionDisplayTitle(explicitName, firstMessage)
      : existing?.title && existing.title !== 'Untitled session'
        ? sessionDisplayTitle(existing.title, firstMessage)
        : sessionDisplayTitle(undefined, firstMessage);
    const selected = this.selectedSlot === slot && slot.runtime.session === session;
    return {
      id: session.sessionId.slice(0, 500),
      title,
      firstMessage,
      path: (session.sessionFile ?? existing?.path ?? `live:${session.sessionId}`).slice(0, 32_768),
      createdAt: existing?.createdAt ?? slot.createdAt,
      modifiedAt: slot.modifiedAt,
      messageCount: Math.max(existing?.messageCount ?? 0, session.messages.length),
      ...(existing?.parentSessionPath ? { parentSessionPath: existing.parentSessionPath } : {}),
      active: selected,
      attention: selected ? null : this.sessionAttentionValue(session.sessionId, slot.attention),
    };
  }

  private summaryForSessionId(sessionId: string): SessionSummary | undefined {
    return this.sessions.find((summary) => summary.id === sessionId);
  }

  private mergeSessionSummaries(persisted: readonly SessionSummary[], query = ''): SessionSummary[] {
    const selectedId = this.selectedSlot?.runtime.session.sessionId ?? null;
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const summaries: SessionSummary[] = persisted
      .filter((summary) => summary.messageCount > 0)
      .map((summary) => {
        const attention = this.sessionAttention.get(summary.id);
        return {
          ...summary,
          active: summary.id === selectedId,
          attention: summary.id === selectedId ? null : attention ? attention.value : summary.attention ?? null,
        };
      });
    const indexById = new Map(summaries.map((summary, index) => [summary.id, index]));
    for (const [sessionId, attention] of this.sessionAttention) {
      if (attention.value === null || indexById.has(sessionId)) continue;
      const cached = this.summaryForSessionId(sessionId);
      if (cached && (!normalizedQuery || `${cached.title}\n${cached.firstMessage}`.toLocaleLowerCase().includes(normalizedQuery))) {
        indexById.set(sessionId, summaries.length);
        summaries.push({ ...cached, active: false, attention: attention.value });
      }
    }
    const missingLive: SessionSummary[] = [];
    for (const slot of this.liveSlots) {
      if (slot.disposed) continue;
      const session = slot.runtime.session;
      const hasFirstPrompt = slot.firstTitleStarted || sessionHistory(session).some((message) => (
        Boolean(message) && typeof message === 'object' && (message as { role?: unknown }).role === 'user'
      ));
      if (!hasFirstPrompt) continue;
      const live = this.liveSessionSummary(slot, session);
      const index = indexById.get(live.id);
      if (index !== undefined) summaries[index] = { ...summaries[index]!, ...live };
      else if (!normalizedQuery || `${live.title}\n${live.firstMessage}`.toLocaleLowerCase().includes(normalizedQuery)) missingLive.push(live);
    }
    return [...missingLive, ...summaries].slice(0, 1_000);
  }

  private mergeLiveSessionSummaries(): void {
    this.sessions = this.mergeSessionSummaries(this.sessions);
  }

  private async permissionForSession(session: AgentSession, slot = this.selectedSlot): Promise<PermissionLevel> {
    if (!this.project) return 'full-access';
    try {
      return await this.sessionPermissions.get(this.project.path, session.sessionId) ?? 'full-access';
    } catch (error) {
      if (slot && this.selectedSlot === slot) this.emitSystemMessage(`Saved session permission could not be restored; Full access remains active: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      return 'full-access';
    }
  }

  private async applySessionDefaults(session: AgentSession, defaults: SessionDefaults | undefined, slot = this.selectedSlot): Promise<void> {
    if (!defaults) return;
    try {
      if (defaults.defaultModel) {
        const separator = defaults.defaultModel.indexOf('/');
        if (separator > 0) {
          const provider = defaults.defaultModel.slice(0, separator);
          const id = defaults.defaultModel.slice(separator + 1);
          const model = this.modelRuntime?.getModel(provider, id);
          if (model && this.models.some((candidate) => candidate.provider === provider && candidate.id === id)) await session.setModel(model);
        }
      }
      // Apply thinking after the target model so Pi validates/clamps against
      // the model the user actually selected.
      session.setThinkingLevel(defaults.thinkingLevel);
    } catch (error) {
      if (slot && !slot.disposed && this.selectedSlot === slot && slot.runtime.session === session) {
        this.emitSystemMessage(`Saved agent defaults could not be applied: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      }
    }
  }

  private activeOperationError(action: string): PiDesktopError {
    return new PiDesktopError({ code: 'RUN_ACTIVE', message: `Wait for the active Pi operation to finish before ${action}.`, retryable: true });
  }

  private replacementSuperseded(): PiDesktopError {
    return new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The session change was superseded by a newer project.', retryable: true });
  }

  private replacementCancelled(feature: string): PiDesktopError {
    return new PiDesktopError({ code: 'INVALID_REQUEST', message: `${feature} was cancelled by a Pi extension.`, retryable: true });
  }

  private unsupported(feature: string): PiDesktopError {
    return new PiDesktopError({ code: 'INVALID_REQUEST', message: `${feature} is not supported by this Pi SDK version.`, retryable: false });
  }

  private async refreshSessions(force = false, coalesce = false): Promise<void> {
    const refreshGeneration = ++this.sessionRefreshGeneration;
    const selectedSlot = this.selectedSlot;
    if (!this.project || !selectedSlot) {
      this.sessions = [];
      return;
    }
    const generation = this.initialization;
    const projectPath = this.project.path;
    const activeSessionId = selectedSlot.runtime.session.sessionId;
    let load = this.sessionRefreshLoad;
    if (!load || load.projectPath !== projectPath || !coalesce || (force && !load.forced)) {
      if (force) (this.sessionRepository as PiSessionRepository & { invalidate?: (cwd: string) => void }).invalidate?.(projectPath);
      const promise = this.sessionRepository.list(projectPath, activeSessionId);
      const createdLoad = { projectPath, forced: force, promise };
      load = createdLoad;
      this.sessionRefreshLoad = createdLoad;
      void promise.then(
        () => { if (this.sessionRefreshLoad === createdLoad) this.sessionRefreshLoad = null; },
        () => { if (this.sessionRefreshLoad === createdLoad) this.sessionRefreshLoad = null; },
      );
    }
    const sessions = await load.promise;
    if (
      refreshGeneration === this.sessionRefreshGeneration
      && generation === this.initialization
      && this.project?.path === projectPath
      && this.selectedSlot
    ) this.sessions = this.mergeSessionSummaries(sessions);
  }

  private emitState(messagesIncluded = false): RuntimeState {
    // Message entities are normally delivered through normalized events. Session
    // hydration/replacement opts into history because timeline ownership changed.
    const state = this.getState(messagesIncluded);
    this.enqueue({ type: 'state.changed', state, messagesIncluded, timestamp: Date.now() });
    return state;
  }

  private emitSystemMessage(message: string, level: ExtensionNoticeLevel): void {
    const timestamp = Date.now();
    this.enqueue({
      type: 'message.completed',
      messageId: `system-${randomUUID()}`,
      role: 'system',
      text: safeText(message, 64_900),
      ...(level === 'error' ? { error: true } : {}),
      timestamp,
    });
  }

  private emitError(error: AppError): void {
    this.stateError = error;
    this.enqueue({ type: 'error', error, timestamp: Date.now() });
  }

  private enqueue(event: PiEvent): void {
    event.cursor = ++this.eventCursor;
    this.batcher.enqueue(event);
  }

  private enqueueMany(events: readonly PiEvent[]): void {
    for (const event of events) this.enqueue(event);
  }

  private async disposeSlot(slot: RuntimeSlot, abortRunning: boolean): Promise<void> {
    if (slot.disposePromise) return slot.disposePromise;
    const session = slot.runtime.session;
    const sessionId = session.sessionId;
    const pendingBinding = slot.bindingPromise;
    slot.disposed = true;
    this.liveSlots.delete(slot);
    if (this.selectedSlot === slot) this.selectedSlot = null;
    // Detach host-owned listeners and wrappers before the first cleanup await so
    // no late event can observe or mutate a successor slot.
    this.invalidateSession(slot);
    slot.disposePromise = (async () => {
      const failures: unknown[] = [];
      if (abortRunning || this.subagents.hasOwnedWork(sessionId) || this.agentTeams.hasOwnedWork(sessionId)) {
        try { await this.subagents.cancelParent(sessionId); } catch (error) { failures.push(error); }
        try { await this.agentTeams.cancelRoot(sessionId); } catch (error) { failures.push(error); }
      }
      if (abortRunning) {
        if (session.isStreaming) {
          try { await session.abort(); } catch (error) { failures.push(error); }
        }
        if (session.isCompacting) {
          try { session.abortCompaction(); } catch (error) { failures.push(error); }
        }
        if (session.isBashRunning) {
          try { session.abortBash(); } catch (error) { failures.push(error); }
        }
      }
      // If extension binding was already in flight, let its startup callbacks
      // unwind before runtime.dispose() sends the matching shutdown event.
      await pendingBinding?.catch(() => undefined);
      try { await slot.runtime.dispose(); } catch (error) { failures.push(error); }
      this.subagents.releaseParent(sessionId);
      this.agentTeams.releaseRoot(sessionId);
      if (failures.length > 0) throw new AggregateError(failures, `Pi session ${sessionId} could not be fully disposed.`);
    })();
    const disposal = slot.disposePromise;
    this.pendingDisposals.add(disposal);
    void disposal.then(
      () => { this.pendingDisposals.delete(disposal); },
      () => { this.pendingDisposals.delete(disposal); },
    );
    return disposal;
  }

  private async disposeRuntime(): Promise<void> {
    await Promise.all([this.subagents.cancelAll(), this.agentTeams.cancelAll()]);
    const slots = [...this.liveSlots];
    this.selectedSlot = null;
    this.batcher.clear();
    const results = await Promise.allSettled(slots.map((slot) => this.disposeSlot(slot, true)));
    this.sessions = [];
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'One or more Pi sessions could not be disposed.');
  }
}
