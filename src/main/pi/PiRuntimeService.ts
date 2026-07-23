import { randomUUID } from 'node:crypto';
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  ModelRuntime,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import type {
  AppError,
  ModelInfo,
  PiEvent,
  ProjectState,
  PromptAcceptance,
  PromptInput,
  RuntimeMessage,
  RuntimeState,
  SessionSummary,
  ThinkingLevel,
} from '../../shared/contracts/ipc';
import { PiEventBatcher } from './PiEventBatcher';
import { PiEventNormalizer, messageText } from './PiEventNormalizer';
import { PiDesktopError, authRequiredError, normalizeError } from './errors';
import { PiSessionRepository } from './PiSessionRepository';

export interface PiSdkAdapter {
  supportsClone?: boolean;
  createModelRuntime: () => Promise<ModelRuntime>;
  createRuntime: (cwd: string, modelRuntime: ModelRuntime) => Promise<AgentSessionRuntime>;
}

const realPiSdkAdapter: PiSdkAdapter = {
  // Verified against SDK 0.81.1: clone is runtime.fork(currentLeaf, { position: 'at' }).
  supportsClone: true,
  createModelRuntime: () => ModelRuntime.create(),
  async createRuntime(cwd, modelRuntime) {
    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd: effectiveCwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({ cwd: effectiveCwd, modelRuntime });
      return {
        ...(await createAgentSessionFromServices({ services, sessionManager, ...(sessionStartEvent ? { sessionStartEvent } : {}) })),
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

function toMessage(message: unknown, id: string): RuntimeMessage | null {
  if (!message || typeof message !== 'object') return null;
  const value = message as { role?: unknown; timestamp?: unknown; isError?: unknown; stopReason?: unknown; content?: unknown };
  const role = value.role === 'user' ? 'user' : value.role === 'assistant' ? 'assistant' : null;
  if (!role) return null;
  const timestamp = typeof value.timestamp === 'number' ? value.timestamp : 0;
  const result: RuntimeMessage = { id, role, text: messageText(message), timestamp };
  if (Array.isArray(value.content)) {
    const reasoning = value.content.flatMap((part: unknown) => {
      if (!part || typeof part !== 'object') return [];
      const block = part as { type?: unknown; thinking?: unknown };
      return block.type === 'thinking' && typeof block.thinking === 'string' ? [block.thinking] : [];
    }).join('');
    if (reasoning) result.reasoning = reasoning;
  }
  if (value.isError === true || value.stopReason === 'error') result.error = true;
  return result;
}

export class PiRuntimeService {
  private project: ProjectState | null = null;
  private runtime: AgentSessionRuntime | null = null;
  private modelRuntime: ModelRuntime | null = null;
  private models: ModelInfo[] = [];
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

  constructor(
    private readonly adapter: PiSdkAdapter = realPiSdkAdapter,
    private readonly sessionRepository = new PiSessionRepository(),
  ) {
    this.batcher = new PiEventBatcher((events) => this.eventSink(events));
  }

  setEventSink(sink: (events: PiEvent[]) => void): void {
    this.eventSink = sink;
  }

  getState(includeMessages = true): RuntimeState {
    const session = this.runtime?.session;
    const allMessages = session?.messages ?? [];
    const messages = includeMessages
      ? allMessages
          .map((message) => toMessage(message, this.normalizer.messageId(message)))
          .filter((message): message is RuntimeMessage => message !== null)
      : [];
    let objective = '';
    for (let index = allMessages.length - 1; index >= 0; index -= 1) {
      const message = allMessages[index] as { role?: unknown } | undefined;
      if (message?.role === 'user') { objective = messageText(message).trim().slice(0, 500); break; }
    }
    const contextUsage = session?.getContextUsage?.();
    const skills = this.runtime?.services?.resourceLoader?.getSkills?.().skills.map((skill) => ({ name: skill.name, description: skill.description }));
    return {
      status: this.status,
      project: this.project,
      sessionId: session?.sessionId ?? null,
      sessionFile: session?.sessionFile ?? null,
      streaming: session?.isStreaming ?? false,
      model: session?.model ? toModelInfo(session.model) : null,
      models: this.models,
      thinkingLevel: session?.thinkingLevel ?? 'medium',
      messages,
      commands: session?.promptTemplates?.map((command) => ({ name: command.name, description: command.description ?? '' })) ?? [],
      skills: skills ?? [],
      ...(objective ? { objective } : {}),
      ...(contextUsage ? { contextUsage } : {}),
      sessions: this.sessions,
      branches: session ? this.sessionRepository.branches(session) : [],
      forkPoints: session && typeof session.getUserMessagesForForking === 'function' ? session.getUserMessagesForForking() : [],
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
      error: this.stateError,
    };
  }

  async openProject(project: ProjectState): Promise<RuntimeState> {
    const generation = ++this.initialization;
    await this.disposeRuntime();
    this.project = project;
    this.models = [];
    this.sessions = [];
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
      const modelRuntime = await this.adapter.createModelRuntime();
      if (generation !== this.initialization) return this.getState();
      this.modelRuntime = modelRuntime;

      // Build project-bound services before checking availability: trusted project
      // extensions may register providers and models during runtime creation.
      const runtime = await this.adapter.createRuntime(project.path, modelRuntime);
      if (generation !== this.initialization) {
        await runtime.dispose();
        return this.getState();
      }
      this.runtime = runtime;
      runtime.setBeforeSessionInvalidate?.(() => this.invalidateSession());
      runtime.setRebindSession(async (session) => {
        await this.replaceSession(session);
        await this.refreshSessions();
        this.emitState();
      });
      await this.replaceSession(runtime.session);
      await this.refreshSessions();
      const available = await modelRuntime.getAvailable();
      this.models = available.map(toModelInfo);
      this.status = available.length > 0 ? 'ready' : 'auth-required';
      this.stateError = available.length > 0 ? null : authRequiredError();
      const diagnostic = runtime.diagnostics.find((item) => item.type === 'error');
      if (diagnostic) this.emitError({ code: 'PI_RUNTIME_ERROR', message: diagnostic.message, retryable: true });
      this.emitState();
      return this.getState();
    } catch (error) {
      const normalized = normalizeError(error);
      this.status = normalized.code === 'AUTH_REQUIRED' ? 'auth-required' : 'error';
      this.stateError = normalized;
      this.emitError(normalized);
      this.emitState();
      return this.getState();
    }
  }

  prompt(input: PromptInput): Promise<PromptAcceptance> {
    const session = this.requireSession();
    const generation = this.sessionGeneration;
    const runId = randomUUID();
    const images = input.images?.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType }));
    if (images?.length && !session.model?.input.includes('image')) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The active model does not support image input.', retryable: true });
    }
    if (session.isStreaming && input.behavior === 'prompt' && !input.text.trimStart().startsWith('/')) {
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'Pi is already working. Steer it or queue a follow-up instead.', retryable: true });
    }

    const ownsActiveRun = input.behavior === 'prompt' && !session.isStreaming;
    if (ownsActiveRun) this.activeRunId = runId;
    this.stateError = null;
    let settled = false;
    return new Promise<PromptAcceptance>((resolve) => {
      const accept = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        if (generation !== this.sessionGeneration) {
          resolve({ accepted: false, runId });
          return;
        }
        if (accepted) this.batcher.enqueue({ type: 'run.accepted', runId, timestamp: Date.now() });
        else this.emitError({ code: 'INVALID_REQUEST', message: 'Pi rejected the prompt before starting.', retryable: true });
        resolve({ accepted, runId });
      };
      void session.prompt(input.text, {
        ...(images ? { images } : {}),
        ...(input.behavior === 'prompt' ? {} : { streamingBehavior: input.behavior }),
        preflightResult: accept,
      }).catch((error: unknown) => {
        if (generation !== this.sessionGeneration) return;
        const normalized = normalizeError(error);
        if (!settled) accept(false);
        this.emitError(normalized);
      }).finally(() => {
        if (generation !== this.sessionGeneration) return;
        if (ownsActiveRun && this.activeRunId === runId) this.activeRunId = null;
        this.emitState();
      });
    });
  }

  async abort(): Promise<{ aborted: boolean }> {
    const session = this.runtime?.session;
    if (!session || !session.isStreaming) return { aborted: false };
    await session.abort();
    return { aborted: true };
  }

  async setModel(provider: string, id: string): Promise<RuntimeState> {
    const session = this.requireSession();
    const model = this.modelRuntime?.getModel(provider, id);
    if (!model || !this.models.some((candidate) => candidate.provider === provider && candidate.id === id)) {
      throw new PiDesktopError({ code: 'AUTH_REQUIRED', message: `Model ${provider}/${id} is unavailable or not authenticated.`, actionable: 'Authenticate its provider with the Pi CLI /login command.', retryable: true });
    }
    await session.setModel(model);
    this.emitState();
    return this.getState();
  }

  setThinkingLevel(level: ThinkingLevel): RuntimeState {
    this.requireSession().setThinkingLevel(level);
    this.emitState();
    return this.getState();
  }

  newSession(): Promise<RuntimeState> {
    return this.runReplacement(async (runtime) => {
      await runtime.newSession();
    });
  }

  async listSessions(query = ''): Promise<SessionSummary[]> {
    if (!this.project || !this.runtime) return [];
    return this.sessionRepository.list(this.project.path, this.runtime.session.sessionId, query);
  }

  switchSession(sessionId: string): Promise<RuntimeState> {
    return this.runReplacement(async (runtime) => {
      const session = await this.sessionRepository.resolve(this.project!.path, sessionId);
      if (!session) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The selected session no longer exists.', retryable: true });
      if (!session.active) await runtime.switchSession(session.path);
    });
  }

  forkSession(entryId: string): Promise<RuntimeState> {
    return this.runReplacement(async (runtime) => {
      if (typeof runtime.fork !== 'function') throw this.unsupported('Session branching');
      const points = runtime.session.getUserMessagesForForking?.() ?? [];
      if (!points.some((point) => point.entryId === entryId)) {
        throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'That branch point is not part of the active session.', retryable: true });
      }
      await runtime.fork(entryId);
    });
  }

  cloneSession(): Promise<RuntimeState> {
    return this.runReplacement(async (runtime) => {
      if (this.adapter.supportsClone !== true || typeof runtime.fork !== 'function') throw this.unsupported('Session cloning');
      const leafId = runtime.session.sessionManager?.getLeafId?.();
      if (!leafId) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The current session has no conversation to clone.', retryable: true });
      await runtime.fork(leafId, { position: 'at' });
    });
  }

  importSession(filePath: string): Promise<RuntimeState> {
    return this.runReplacement(async (runtime) => {
      if (typeof runtime.importFromJsonl !== 'function') throw this.unsupported('Session import');
      await runtime.importFromJsonl(filePath, this.project!.path);
    });
  }

  async compact(instructions?: string): Promise<RuntimeState> {
    const session = this.requireSession();
    if (typeof session.compact !== 'function') throw this.unsupported('Context compaction');
    await session.compact(instructions);
    await this.refreshSessions();
    this.emitState();
    return this.getState();
  }

  async dispose(): Promise<void> {
    ++this.initialization;
    await this.disposeRuntime();
    this.batcher.dispose();
  }

  private invalidateSession(): void {
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    ++this.sessionGeneration;
    this.sessionInvalidated = true;
    this.activeRunId = null;
    this.normalizer.resetSession();
    this.batcher.clear();
  }

  private async replaceSession(session: AgentSession): Promise<void> {
    // Real AgentSessionRuntime calls beforeSessionInvalidate synchronously. The
    // fallback keeps custom/test adapters equally safe if they only rebind.
    if (!this.sessionInvalidated) this.invalidateSession();
    const generation = this.sessionGeneration;
    await session.bindExtensions({});
    if (generation !== this.sessionGeneration || this.runtime?.session !== session) return;
    this.unsubscribeSession = session.subscribe((event: AgentSessionEvent) => {
      if (generation !== this.sessionGeneration || this.runtime?.session !== session) return;
      const normalizedEvents = this.normalizer.normalize(event);
      for (const normalizedEvent of normalizedEvents) {
        if (normalizedEvent.type === 'error') this.stateError = normalizedEvent.error;
      }
      this.batcher.enqueueMany(normalizedEvents);
      if (event.type === 'agent_start' || event.type === 'agent_end' || event.type === 'thinking_level_changed') this.emitState();
      if (event.type === 'agent_end' || event.type === 'session_info_changed') {
        void this.refreshSessions().then(() => {
          if (generation === this.sessionGeneration) this.emitState();
        }).catch((error: unknown) => {
          if (generation === this.sessionGeneration) this.emitError(normalizeError(error));
        });
      }
    });
    this.sessionInvalidated = false;
  }

  private requireSession(): AgentSession {
    if (this.status === 'auth-required') throw new PiDesktopError(this.stateError ?? authRequiredError());
    if (!this.runtime) {
      throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open and trust a project before using Pi.', retryable: true });
    }
    return this.runtime.session;
  }

  private requireRuntimeForReplacement(): AgentSessionRuntime {
    if (!this.runtime) this.requireSession();
    if (this.runtime!.session.isStreaming) {
      throw new PiDesktopError({ code: 'RUN_ACTIVE', message: 'Stop the active run before replacing this session.', retryable: true });
    }
    return this.runtime!;
  }

  private runReplacement(operation: (runtime: AgentSessionRuntime) => Promise<void>): Promise<RuntimeState> {
    const execute = async (): Promise<RuntimeState> => {
      const runtime = this.requireRuntimeForReplacement();
      this.replacementActive = true;
      this.stateError = null;
      this.emitState();
      let failure: AppError | null = null;
      try {
        await operation(runtime);
        await this.refreshSessions();
        this.status = this.models.length > 0 ? 'ready' : 'auth-required';
      } catch (error) {
        failure = error instanceof PiDesktopError ? error.normalized : normalizeError(error);
        this.status = 'error';
        this.emitError(failure);
      } finally {
        this.replacementActive = false;
        this.emitState();
      }
      if (failure) throw new PiDesktopError(failure);
      return this.getState();
    };
    const result = this.replacementQueue.then(execute, execute);
    this.replacementQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private unsupported(feature: string): PiDesktopError {
    return new PiDesktopError({ code: 'INVALID_REQUEST', message: `${feature} is not supported by this Pi SDK version.`, retryable: false });
  }

  private async refreshSessions(): Promise<void> {
    if (!this.project || !this.runtime) {
      this.sessions = [];
      return;
    }
    const generation = this.sessionGeneration;
    const runtime = this.runtime;
    const projectPath = this.project.path;
    const sessions = await this.sessionRepository.list(projectPath, runtime.session.sessionId);
    if (generation === this.sessionGeneration && this.runtime === runtime && this.project?.path === projectPath) {
      this.sessions = sessions;
    }
  }

  private emitState(): void {
    // Message entities are delivered through normalized events. Omitting history
    // keeps frequent lifecycle snapshots bounded on long-running sessions.
    this.batcher.enqueue({
      type: 'state.changed',
      state: this.getState(false),
      messagesIncluded: false,
      timestamp: Date.now(),
    });
  }

  private emitError(error: AppError): void {
    this.stateError = error;
    this.batcher.enqueue({ type: 'error', error, timestamp: Date.now() });
  }

  private async disposeRuntime(): Promise<void> {
    this.invalidateSession();
    if (this.runtime) await this.runtime.dispose();
    this.runtime = null;
    this.activeRunId = null;
    this.sessions = [];
  }
}
