import { randomUUID } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
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
  RuntimeTool,
  SessionSummary,
  ThinkingLevel,
} from '../../shared/contracts/ipc';
import { PiEventBatcher } from './PiEventBatcher';
import { PiEventNormalizer, messageImages, messageText, safeText } from './PiEventNormalizer';
import { promoteInlineResourceCommand } from './PiInlineCommands';
import { createPiExtensionUi, type ExtensionNoticeLevel } from './PiExtensionUi';
import { PiDesktopError, authRequiredError, normalizeError } from './errors';
import { PiSessionRepository } from './PiSessionRepository';
import { PiSessionTitleGenerator, type SessionTitleGenerator } from './PiSessionTitleGenerator';
import { createProjectConfinedTools, type ProjectToolAccess } from './PiToolPolicy';
import { validatePromptImages } from './PiPromptImages';
import { InMemorySessionPermissionStore, type SessionPermissionPersistence } from './SessionPermissionStore';

export interface SessionDefaults {
  thinkingLevel: ThinkingLevel;
  defaultModel: string | null;
}

export interface PiSdkAdapter {
  supportsClone?: boolean;
  createModelRuntime: () => Promise<ModelRuntime>;
  createRuntime: (cwd: string, modelRuntime: ModelRuntime, projectTrusted?: boolean) => Promise<AgentSessionRuntime>;
}

const MAX_HYDRATED_HISTORY_ENTRIES = 5_000;
const MAX_HYDRATED_TIMELINE_ENTITIES = 5_000;
const MAX_HYDRATED_TEXT_CHARACTERS = 8 * 1024 * 1024;
const MAX_HYDRATED_IMAGE_CHARACTERS = 20_000_000;
const MAX_CONTEXT_FILE_BYTES = 256 * 1024;
const MAX_MESSAGE_CONTENT_BLOCKS = 1_000;
const MAX_QUEUED_MESSAGES = 100;

type QueuedMessageRecord = QueuedMessage & { transportText: string };

const toolsByPermissionLevel: Record<PermissionLevel, readonly string[]> = {
  'read-only': ['read', 'generate_image'],
  edit: ['read', 'write', 'edit', 'generate_image'],
  'full-access': ['read', 'write', 'edit', 'bash', 'generate_image'],
};
const permissionControlledTools = new Set(['read', 'write', 'edit', 'bash', 'generate_image']);

export function activeToolsForPermission(activeTools: readonly string[], level: PermissionLevel): string[] {
  const allowed = new Set(toolsByPermissionLevel[level]);
  const selected = activeTools.filter((name) => !permissionControlledTools.has(name) || allowed.has(name));
  for (const name of toolsByPermissionLevel[level]) if (!selected.includes(name)) selected.push(name);
  return selected;
}

const toolAccessBySession = new WeakMap<AgentSession, ProjectToolAccess>();

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
  // Verified against SDK 0.81.1: clone is runtime.fork(currentLeaf, { position: 'at' }).
  supportsClone: true,
  createModelRuntime: () => ModelRuntime.create(),
  async createRuntime(cwd, modelRuntime, projectTrusted) {
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
      );
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        // SDK 0.81.1 declares heterogeneous ToolDefinition arguments as
        // unknown, which is invariant under strictFunctionTypes. Each tool
        // still comes from the SDK's typed public factories.
        customTools: confinedTools as unknown as NonNullable<Parameters<typeof createAgentSessionFromServices>[0]['customTools']>,
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
      });
      toolAccessBySession.set(created.session, toolAccess);
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

function toModelInfo(model: { provider: string; id: string; name: string; reasoning: boolean; contextWindow: number; input?: readonly string[] }): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    supportsImages: model.input?.includes('image') ?? false,
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
        });
      });
      return;
    }
    if (value.role !== 'toolResult' || typeof value.toolCallId !== 'string') return;
    const existing = tools.get(value.toolCallId);
    const images = messageImages(message);
    const output = safeText(messageText(message) || (value.details === undefined ? '' : value.details));
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
  private runtime: AgentSessionRuntime | null = null;
  private modelRuntime: ModelRuntime | null = null;
  private models: ModelInfo[] = [];
  private permissionLevel: PermissionLevel = 'edit';
  private status: RuntimeState['status'] = 'disconnected';
  private stateError: AppError | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private activeRunId: string | null = null;
  private eventSink: (events: PiEvent[]) => void = () => undefined;
  private readonly batcher: PiEventBatcher;
  private readonly normalizer = new PiEventNormalizer(() => this.activeRunId);
  private initialization = 0;
  private sessionGeneration = 0;
  private sessionInvalidated = false;
  private sessions: SessionSummary[] = [];
  private replacementQueue: Promise<void> = Promise.resolve();
  private replacementActive = false;
  private replacementGeneration = 0;
  private eventCursor = 0;
  private objective = '';
  private queuedMessages: QueuedMessageRecord[] = [];
  private queueMutationActive = false;
  private queueMutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: PiSdkAdapter = realPiSdkAdapter,
    private readonly sessionRepository = new PiSessionRepository(),
    private readonly sessionPermissions: SessionPermissionPersistence = new InMemorySessionPermissionStore(),
    private readonly sessionTitleGenerator: SessionTitleGenerator = new PiSessionTitleGenerator(),
  ) {
    this.batcher = new PiEventBatcher((events) => this.eventSink(events));
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
    const contextUsage = session?.getContextUsage?.();
    const queue = {
      steering: session?.getSteeringMessages?.().length ?? 0,
      followUp: session?.getFollowUpMessages?.().length ?? 0,
      items: this.queuedMessages.slice(0, MAX_QUEUED_MESSAGES).map(({ transportText: _transportText, ...item }) => item),
    };
    const skills = this.runtime?.services?.resourceLoader?.getSkills?.().skills.slice(0, 5_000).map((skill) => ({ name: skill.name.slice(0, 500), description: skill.description.slice(0, 2_000) }));
    return {
      status: this.status,
      project: this.project,
      sessionId: session?.sessionId ?? null,
      sessionFile: session?.sessionFile ?? null,
      streaming: session?.isStreaming ?? false,
      model: session?.model ? toModelInfo(session.model) : null,
      models: this.models,
      thinkingLevel: session?.thinkingLevel ?? 'medium',
      permissionLevel: this.permissionLevel,
      messages,
      tools,
      commands: this.getCommands(session),
      skills: skills ?? [],
      ...(objective ? { objective } : {}),
      ...(contextUsage ? { contextUsage } : {}),
      queue,
      sessions: this.sessions,
      ...(includeMessages && session ? { branches: this.sessionRepository.branches(session) } : {}),
      ...(includeMessages && session && typeof session.getUserMessagesForForking === 'function'
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
    this.project = null;
    this.modelRuntime = null;
    this.permissionLevel = 'edit';
    this.models = [];
    this.sessions = [];
    this.objective = '';
    this.status = 'disconnected';
    this.stateError = null;
    return this.emitState();
  }

  async openProject(project: ProjectState, defaults?: SessionDefaults): Promise<RuntimeState> {
    const generation = ++this.initialization;
    this.replacementGeneration += 1;
    this.replacementQueue = Promise.resolve();
    this.replacementActive = false;
    await this.disposeRuntime();
    if (generation !== this.initialization) return this.getState();
    this.project = project;
    this.permissionLevel = 'edit';
    this.models = [];
    this.sessions = [];
    this.objective = '';
    this.stateError = null;
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
      const runtime = await this.adapter.createRuntime(project.path, modelRuntime, project.trusted);
      if (generation !== this.initialization) {
        await runtime.dispose();
        return this.getState();
      }
      this.runtime = runtime;
      runtime.setBeforeSessionInvalidate?.(() => {
        if (generation === this.initialization && this.runtime === runtime) this.invalidateSession();
      });
      runtime.setRebindSession(async (session) => {
        if (generation !== this.initialization || this.runtime !== runtime || runtime.session !== session) return;
        await this.replaceSession(session);
        if (generation !== this.initialization || this.runtime !== runtime || runtime.session !== session) return;
        // A direct extension replacement owns refresh and its final snapshot.
        // UI replacements refresh once after defaults are applied atomically.
        if (!this.replacementActive) {
          await this.refreshSessions(true);
          if (generation === this.initialization && this.runtime === runtime && runtime.session === session) this.emitState(true);
        }
      });
      await this.replaceSession(runtime.session);
      if (generation !== this.initialization || this.runtime !== runtime) return this.getState();
      await this.refreshSessions();
      if (generation !== this.initialization || this.runtime !== runtime) return this.getState();
      const available = await modelRuntime.getAvailable();
      if (generation !== this.initialization || this.runtime !== runtime) return this.getState();
      this.models = available.slice(0, 2_000).map(toModelInfo);
      await this.applySessionDefaults(runtime.session, defaults);
      if (generation !== this.initialization || this.runtime !== runtime) return this.getState();
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

  prompt(input: PromptInput): Promise<PromptAcceptance> {
    const session = this.requireSession();
    if (this.replacementActive) {
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'Wait for the session change to finish before sending a prompt.', retryable: true });
    }
    const runtimeOwner = this.runtime;
    const initialization = this.initialization;
    const runId = randomUUID();
    const promptText = promoteInlineResourceCommand(input.text, this.getCommands(session));
    validatePromptImages(input.images);
    const images = input.images?.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType }));
    if (images?.length && !session.model?.input.includes('image')) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The active model does not support image input.', retryable: true });
    }
    const queuedBehavior = session.isStreaming && input.behavior !== 'prompt' ? input.behavior : null;
    if (queuedBehavior && this.queuedMessages.length >= MAX_QUEUED_MESSAGES) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The message queue is full. Cancel or wait for a queued message before adding another.', retryable: true });
    }
    const queuedCountBefore = queuedBehavior === 'steer'
      ? session.getSteeringMessages?.().length ?? 0
      : queuedBehavior === 'followUp'
        ? session.getFollowUpMessages?.().length ?? 0
        : 0;
    if (session.isStreaming && input.behavior === 'prompt' && !promptText.trimStart().startsWith('/')) {
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'Pi is already working. Steer it or queue a follow-up instead.', retryable: true });
    }

    const ownsActiveRun = input.behavior === 'prompt' && !session.isStreaming;
    const isFirstUserPrompt = ownsActiveRun && !sessionHistory(session).some((message) => (
      Boolean(message) && typeof message === 'object' && (message as { role?: unknown }).role === 'user'
    ));
    if (ownsActiveRun) {
      this.activeRunId = runId;
      this.objective = promptText.trim().slice(0, 500);
    }
    this.stateError = null;
    let settled = false;
    return new Promise<PromptAcceptance>((resolve) => {
      const accept = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        if (initialization !== this.initialization || this.runtime !== runtimeOwner) {
          resolve({ accepted: false, runId });
          return;
        }
        if (accepted) {
          this.enqueue({ type: 'run.accepted', runId, timestamp: Date.now() });
          if (isFirstUserPrompt) void this.generateFirstPromptTitle(session, input.text, runtimeOwner, initialization);
          if (queuedBehavior) {
            const queuedTexts = queuedBehavior === 'steer' ? session.getSteeringMessages?.() ?? [] : session.getFollowUpMessages?.() ?? [];
            const transportText = queuedTexts.length > queuedCountBefore ? queuedTexts.at(-1) : undefined;
            if (transportText) {
              this.queuedMessages.push({
                id: randomUUID(),
                behavior: queuedBehavior,
                text: input.text,
                transportText,
                ...(input.images?.length ? { images: input.images.map((image) => ({ ...image })) } : {}),
                createdAt: Date.now(),
              });
              this.emitState();
            }
          }
        } else this.emitError({ code: 'INVALID_REQUEST', message: 'Pi rejected the prompt before starting.', retryable: true });
        resolve({ accepted, runId });
      };
      void session.prompt(promptText, {
        ...(images ? { images } : {}),
        ...(input.behavior === 'prompt' ? {} : { streamingBehavior: input.behavior }),
        preflightResult: accept,
      }).catch((error: unknown) => {
        if (initialization !== this.initialization || this.runtime !== runtimeOwner) {
          accept(false);
          return;
        }
        const normalized = normalizeError(error);
        if (!settled) accept(false);
        this.emitError(normalized);
      }).finally(() => {
        if (ownsActiveRun && this.activeRunId === runId) this.activeRunId = null;
        if (initialization === this.initialization && this.runtime === runtimeOwner) this.emitState();
      });
    });
  }

  private async generateFirstPromptTitle(
    session: AgentSession,
    prompt: string,
    runtimeOwner: AgentSessionRuntime | null,
    initialization: number,
  ): Promise<void> {
    const projectPath = this.project?.path;
    const modelRuntime = this.modelRuntime;
    if (!projectPath || !modelRuntime) return;
    const title = await this.sessionTitleGenerator.generate(prompt, modelRuntime, session);
    if (
      !title
      || initialization !== this.initialization
      || this.runtime !== runtimeOwner
      || this.project?.path !== projectPath
      || this.runtime?.session.sessionId !== session.sessionId
    ) return;
    try {
      const renamed = await this.sessionRepository.renameIfUnnamed(projectPath, session.sessionId, title);
      if (!renamed || initialization !== this.initialization || this.runtime !== runtimeOwner) return;
      await this.refreshSessions(true);
      if (initialization === this.initialization && this.runtime === runtimeOwner) this.emitState();
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
    if (!session || !session.isStreaming) return { aborted: false };
    await session.abort();
    return { aborted: true };
  }

  async setModel(provider: string, id: string): Promise<RuntimeState> {
    const session = this.requireIdleSession('changing the model');
    const model = this.modelRuntime?.getModel(provider, id);
    if (!model || !this.models.some((candidate) => candidate.provider === provider && candidate.id === id)) {
      throw new PiDesktopError({ code: 'AUTH_REQUIRED', message: `Model ${provider}/${id} is unavailable or not authenticated.`, actionable: 'Authenticate its provider with the Pi CLI /login command.', retryable: true });
    }
    await session.setModel(model);
    this.emitState();
    return this.getState(false);
  }

  setThinkingLevel(level: ThinkingLevel): RuntimeState {
    this.requireIdleSession('changing the reasoning level').setThinkingLevel(level);
    this.emitState();
    return this.getState(false);
  }

  async setPermissionLevel(level: PermissionLevel): Promise<RuntimeState> {
    const session = this.requireIdleSession('changing the permission level');
    const access = toolAccessBySession.get(session);
    // Keep the filesystem boundary fail-closed if the SDK rejects a tool set,
    // while preserving active tools owned by trusted global extensions.
    session.setActiveToolsByName(activeToolsForPermission(session.getActiveToolNames(), level));
    if (access) access.fullAccess = level === 'full-access';
    this.permissionLevel = level;
    try {
      await this.sessionPermissions.set(this.project!.path, session.sessionId, level);
    } catch (error) {
      this.emitSystemMessage(`The session permission changed but could not be saved: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    }
    this.emitState();
    return this.getState(false);
  }

  mutateQueuedMessage(input: QueueMutationInput): Promise<QueueMutationResult> {
    const operation = this.queueMutationQueue.then(() => this.applyQueueMutation(input));
    this.queueMutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  newSession(defaults?: SessionDefaults): Promise<RuntimeState> {
    return this.runReplacement(async (runtime) => {
      if ((await runtime.newSession())?.cancelled) throw this.replacementCancelled('New session');
      await this.applySessionDefaults(runtime.session, defaults);
    });
  }

  async listSessions(query = ''): Promise<SessionSummary[]> {
    if (!this.project || !this.runtime) return [];
    return (await this.sessionRepository.list(this.project.path, this.runtime.session.sessionId, query)).slice(0, 1_000);
  }

  switchSession(sessionId: string): Promise<RuntimeState> {
    return this.runReplacement(async (runtime) => {
      const session = await this.sessionRepository.resolve(this.project!.path, sessionId);
      if (!session) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The selected session no longer exists.', retryable: true });
      if (!session.active && (await runtime.switchSession(session.path, { cwdOverride: this.project!.path }))?.cancelled) throw this.replacementCancelled('Session switch');
    });
  }

  async renameSession(sessionId: string, name: string): Promise<RuntimeState> {
    const session = this.requireRuntimeSession();
    if (!this.project) throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a project before renaming a session.', retryable: true });
    if (session.isStreaming || this.replacementActive) throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'Wait for the active session operation to finish before renaming.', retryable: true });
    const normalizedName = name.trim();
    if (session.sessionId === sessionId) session.setSessionName(normalizedName);
    else await this.sessionRepository.rename(this.project.path, sessionId, normalizedName);
    await this.refreshSessions();
    this.emitState();
    return this.getState(false);
  }

  async deleteSession(sessionId: string): Promise<RuntimeState> {
    const session = this.requireRuntimeIdleSession('deleting a session');
    if (!this.project) throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a project before deleting a session.', retryable: true });
    if (session.sessionId === sessionId) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'Switch to another session before deleting this one.', retryable: true });
    await this.sessionRepository.delete(this.project.path, sessionId);
    try {
      await this.sessionPermissions.delete(this.project.path, sessionId);
    } catch (error) {
      this.emitSystemMessage(`Deleted session permission metadata could not be removed: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    }
    await this.refreshSessions();
    this.emitState();
    return this.getState(false);
  }

  async forkSession(entryId: string): Promise<{ state: RuntimeState; selectedText?: string }> {
    let selectedText: string | undefined;
    const state = await this.runReplacement(async (runtime) => {
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
      if (this.adapter.supportsClone !== true || typeof runtime.fork !== 'function') throw this.unsupported('Session cloning');
      const leafId = runtime.session.sessionManager?.getLeafId?.();
      if (!leafId) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The current session has no conversation to clone.', retryable: true });
      if ((await runtime.fork(leafId, { position: 'at' }))?.cancelled) throw this.replacementCancelled('Session clone');
    });
  }

  importSession(filePath: string): Promise<RuntimeState> {
    return this.runReplacement(async (runtime) => {
      if (typeof runtime.importFromJsonl !== 'function') throw this.unsupported('Session import');
      if ((await runtime.importFromJsonl(filePath, this.project!.path))?.cancelled) throw this.replacementCancelled('Session import');
    });
  }

  async compact(instructions?: string): Promise<RuntimeState> {
    const session = this.requireIdleSession('compacting context');
    if (typeof session.compact !== 'function') throw this.unsupported('Context compaction');
    try {
      await session.compact(instructions);
      this.stateError = null;
      await this.refreshSessions();
      this.emitState();
      return this.getState(false);
    } catch (error) {
      const normalized = normalizeError(error);
      this.stateError = normalized;
      this.emitState();
      throw new PiDesktopError(normalized);
    }
  }

  async dispose(): Promise<void> {
    ++this.initialization;
    this.replacementGeneration += 1;
    this.replacementQueue = Promise.resolve();
    this.replacementActive = false;
    await this.disposeRuntime();
    this.batcher.dispose();
  }

  private invalidateSession(): void {
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    ++this.sessionGeneration;
    this.sessionInvalidated = true;
    this.activeRunId = null;
    this.objective = '';
    this.queuedMessages = [];
    this.queueMutationActive = false;
    this.queueMutationQueue = Promise.resolve();
    this.normalizer.resetSession();
    this.batcher.clear();
  }

  private async replaceSession(session: AgentSession): Promise<void> {
    if (this.runtime?.session !== session) return;
    // Real AgentSessionRuntime calls beforeSessionInvalidate synchronously. The
    // fallback keeps custom/test adapters equally safe if they only rebind.
    if (!this.sessionInvalidated) this.invalidateSession();
    const generation = this.sessionGeneration;
    const runtime = this.runtime;
    const runtimeCwd = (runtime as AgentSessionRuntime & { cwd?: unknown }).cwd;
    if (this.project && typeof runtimeCwd === 'string' && path.resolve(runtimeCwd) !== path.resolve(this.project.path)) {
      throw new PiDesktopError({ code: 'INVALID_PROJECT', message: 'Pi refused a session whose working directory differs from the active project.', retryable: false });
    }
    const ownsSession = () => generation === this.sessionGeneration && this.runtime === runtime && runtime?.session === session;
    const replaceFromExtension = async (
      feature: string,
      operation: () => Promise<{ cancelled?: boolean }>,
    ): Promise<{ cancelled: boolean }> => {
      if (!ownsSession()) return { cancelled: true };
      try {
        await this.runReplacement(async (current) => {
          if (current !== runtime || !ownsSession()) throw this.replacementSuperseded();
          if ((await operation()).cancelled) throw this.replacementCancelled(feature);
        });
        return { cancelled: false };
      } catch (error) {
        if (
          !ownsSession()
          || (error instanceof PiDesktopError && /cancelled|superseded/u.test(error.normalized.message))
        ) return { cancelled: true };
        throw error;
      }
    };
    await session.bindExtensions({
      uiContext: createPiExtensionUi({
        notify: (message, level) => { if (ownsSession()) this.emitSystemMessage(message, level); },
      }),
      mode: 'rpc',
      commandContextActions: {
        waitForIdle: () => ownsSession() ? session.waitForIdle() : Promise.resolve(),
        newSession: async (options) => replaceFromExtension('New session', async () => runtime?.newSession(options) ?? { cancelled: true }),
        fork: async (entryId, options) => replaceFromExtension('Session fork', async () => runtime?.fork(entryId, options) ?? { cancelled: true }),
        navigateTree: async (targetId, options) => replaceFromExtension('Branch navigation', () => session.navigateTree(targetId, options)),
        switchSession: async (sessionPath, options) => replaceFromExtension('Session switch', async () => runtime?.switchSession(sessionPath, { ...options, cwdOverride: this.project!.path }) ?? { cancelled: true }),
        reload: async () => {
          await replaceFromExtension('Session reload', async () => { await session.reload(); return { cancelled: false }; });
        },
      },
      shutdownHandler: () => { if (ownsSession()) this.emitSystemMessage('An extension requested shutdown. Close Fate UI when you are ready.', 'warning'); },
      onError: (error) => { if (ownsSession()) this.emitSystemMessage(`Extension error: ${error.error}`, 'error'); },
    });
    if (generation !== this.sessionGeneration || this.runtime?.session !== session) return;
    const access = toolAccessBySession.get(session);
    this.permissionLevel = await this.permissionForSession(session);
    // Activate the requested controlled set before opening the host path boundary,
    // without discarding tools enabled by trusted global extensions.
    session.setActiveToolsByName(activeToolsForPermission(session.getActiveToolNames(), this.permissionLevel));
    if (access) access.fullAccess = this.permissionLevel === 'full-access';
    this.unsubscribeSession = session.subscribe((event: AgentSessionEvent) => {
      if (generation !== this.sessionGeneration || this.runtime?.session !== session) return;
      if (event.type === 'queue_update') {
        if (this.queueMutationActive) return;
        this.reconcileQueuedMessages(event.steering.length, event.followUp.length);
      }
      const normalizedEvents = this.normalizer.normalize(event);
      for (const normalizedEvent of normalizedEvents) {
        if (normalizedEvent.type === 'error') this.stateError = normalizedEvent.error;
      }
      this.enqueueMany(normalizedEvents);
      if (event.type === 'agent_start' || event.type === 'agent_end' || event.type === 'thinking_level_changed') this.emitState();
      if (event.type === 'agent_end' || event.type === 'session_info_changed') {
        void this.refreshSessions(true).then(() => {
          if (generation === this.sessionGeneration) this.emitState();
        }).catch((error: unknown) => {
          if (generation === this.sessionGeneration) this.emitError(normalizeError(error));
        });
      }
    });
    this.sessionInvalidated = false;
  }

  private requireRuntimeSession(): AgentSession {
    if (!this.runtime) {
      throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open and trust a project before using Pi.', retryable: true });
    }
    return this.runtime.session;
  }

  private requireRuntimeIdleSession(action: string): AgentSession {
    const session = this.requireRuntimeSession();
    if (this.replacementActive || session.isStreaming) {
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
    if (this.replacementActive || session.isStreaming) {
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: `Wait for the active Pi operation to finish before ${action}.`, retryable: true });
    }
    return session;
  }

  private requireRuntimeForReplacement(): AgentSessionRuntime {
    if (!this.runtime) this.requireSession();
    if (this.runtime!.session.isStreaming) {
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'Stop the active run before replacing this session.', retryable: true });
    }
    return this.runtime!;
  }

  private runReplacement(operation: (runtime: AgentSessionRuntime) => Promise<void>): Promise<RuntimeState> {
    const runtime = this.requireRuntimeForReplacement();
    const replacementGeneration = this.replacementGeneration;
    const ownsGeneration = () => replacementGeneration === this.replacementGeneration;
    const isCurrent = () => ownsGeneration() && this.runtime === runtime;
    const disposeIfStale = async () => {
      if (this.runtime !== runtime) await runtime.dispose().catch(() => undefined);
    };
    const execute = async (): Promise<RuntimeState> => {
      if (!isCurrent()) {
        await disposeIfStale();
        throw this.replacementSuperseded();
      }
      this.replacementActive = true;
      this.stateError = null;
      this.emitState();
      let failure: AppError | null = null;
      let includeHistory = false;
      let finalState: RuntimeState | null = null;
      try {
        await operation(runtime);
        if (!isCurrent()) throw this.replacementSuperseded();
        await this.refreshSessions(true);
        if (!isCurrent()) throw this.replacementSuperseded();
        this.status = this.models.length > 0 ? 'ready' : 'auth-required';
        includeHistory = true;
      } catch (error) {
        if (!isCurrent()) {
          await disposeIfStale();
          throw this.replacementSuperseded();
        }
        failure = error instanceof PiDesktopError ? error.normalized : normalizeError(error);
        const runtimeUnusable = !(error instanceof PiDesktopError) && this.sessionInvalidated;
        if (runtimeUnusable) {
          if (this.runtime === runtime) this.runtime = null;
          await runtime.dispose().catch(() => undefined);
          if (!ownsGeneration() || this.runtime !== null) throw this.replacementSuperseded();
          this.sessions = [];
          this.status = 'error';
        } else if (error instanceof PiDesktopError) {
          this.status = failure.code === 'INVALID_REQUEST' ? (this.models.length > 0 ? 'ready' : 'auth-required') : 'error';
        } else {
          // Preflight/navigation/metadata failures leave the bound runtime usable.
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

  private async applyQueueMutation(input: QueueMutationInput): Promise<QueueMutationResult> {
    const session = this.requireSession();
    const runtimeOwner = this.runtime;
    const initialization = this.initialization;
    const sessionGeneration = this.sessionGeneration;
    const ownsSession = () => initialization === this.initialization
      && sessionGeneration === this.sessionGeneration
      && this.runtime === runtimeOwner
      && runtimeOwner?.session === session;
    if (this.replacementActive) {
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'Wait for the session change to finish before editing queued messages.', retryable: true });
    }
    const target = this.queuedMessages.find((item) => item.id === input.id);
    if (!target) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'That queued message is no longer waiting.', retryable: true });
    }
    const steeringCount = session.getSteeringMessages?.().length ?? 0;
    const followUpCount = session.getFollowUpMessages?.().length ?? 0;
    const mirroredSteering = this.queuedMessages.filter((item) => item.behavior === 'steer').length;
    const mirroredFollowUp = this.queuedMessages.filter((item) => item.behavior === 'followUp').length;
    if (!session.isStreaming || steeringCount !== mirroredSteering || followUpCount !== mirroredFollowUp) {
      this.reconcileQueuedMessages(steeringCount, followUpCount);
      this.emitState();
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'That message is already being sent. The queue has been refreshed.', retryable: true });
    }

    const next = this.queuedMessages.flatMap((item): QueuedMessageRecord[] => {
      if (item.id !== input.id) return [item];
      if (input.action === 'cancel' || input.action === 'edit') return [];
      return [{ ...item, behavior: input.action }];
    });
    const restored = input.action === 'edit'
      ? { text: target.text, ...(target.images?.length ? { images: target.images.map((image) => ({ ...image })) } : {}) }
      : undefined;

    this.queueMutationActive = true;
    try {
      session.clearQueue();
      if (!ownsSession()) throw this.replacementSuperseded();
      // From this point onward the SDK queue no longer matches the old mirror.
      // Track the intended survivors so partial requeue failures can still be
      // reconciled against Pi's authoritative public queue counts.
      this.queuedMessages = next;
      for (const item of next.filter((queued) => queued.behavior === 'steer')) {
        await session.steer(item.transportText, item.images?.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })));
        if (!ownsSession()) throw this.replacementSuperseded();
      }
      for (const item of next.filter((queued) => queued.behavior === 'followUp')) {
        await session.followUp(item.transportText, item.images?.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })));
        if (!ownsSession()) throw this.replacementSuperseded();
      }
      this.reconcileQueuedMessages(session.getSteeringMessages?.().length ?? 0, session.getFollowUpMessages?.().length ?? 0);
      this.stateError = null;
      this.emitState();
      return { state: this.getState(false), ...(restored ? { restored } : {}) };
    } catch (error) {
      if (ownsSession()) {
        this.reconcileQueuedMessages(session.getSteeringMessages?.().length ?? 0, session.getFollowUpMessages?.().length ?? 0);
        this.emitState();
      }
      throw error;
    } finally {
      this.queueMutationActive = false;
    }
  }

  private reconcileQueuedMessages(steeringCount: number, followUpCount: number): void {
    const steering = this.queuedMessages.filter((item) => item.behavior === 'steer');
    const followUp = this.queuedMessages.filter((item) => item.behavior === 'followUp');
    const retained = new Set([
      ...(steeringCount === 0 ? [] : steering.slice(-steeringCount).map((item) => item.id)),
      ...(followUpCount === 0 ? [] : followUp.slice(-followUpCount).map((item) => item.id)),
    ]);
    this.queuedMessages = this.queuedMessages.filter((item) => retained.has(item.id));
  }

  private async permissionForSession(session: AgentSession): Promise<PermissionLevel> {
    if (!this.project) return 'edit';
    try {
      return await this.sessionPermissions.get(this.project.path, session.sessionId) ?? 'edit';
    } catch (error) {
      this.emitSystemMessage(`Saved session permission could not be restored; Edit files remains active: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      return 'edit';
    }
  }

  private async applySessionDefaults(session: AgentSession, defaults: SessionDefaults | undefined): Promise<void> {
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
      this.emitSystemMessage(`Saved agent defaults could not be applied: ${error instanceof Error ? error.message : String(error)}`, 'warning');
    }
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

  private async refreshSessions(force = false): Promise<void> {
    if (!this.project || !this.runtime) {
      this.sessions = [];
      return;
    }
    const generation = this.sessionGeneration;
    const runtime = this.runtime;
    const projectPath = this.project.path;
    if (force) (this.sessionRepository as PiSessionRepository & { invalidate?: (cwd: string) => void }).invalidate?.(projectPath);
    const sessions = await this.sessionRepository.list(projectPath, runtime.session.sessionId);
    if (generation === this.sessionGeneration && this.runtime === runtime && this.project?.path === projectPath) {
      this.sessions = sessions.slice(0, 1_000);
    }
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
      text: safeText(message),
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

  private async disposeRuntime(): Promise<void> {
    const runtime = this.runtime;
    this.invalidateSession();
    // Clear all old ownership before yielding. A late invalidation callback or
    // disposal completion must never erase a successor installed by openProject.
    if (this.runtime === runtime) this.runtime = null;
    this.activeRunId = null;
    this.sessions = [];
    if (runtime) await runtime.dispose();
  }
}
