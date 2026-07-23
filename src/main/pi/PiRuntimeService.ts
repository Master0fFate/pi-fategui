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
  ThinkingLevel,
} from '../../shared/contracts/ipc';
import { PiEventBatcher } from './PiEventBatcher';
import { PiEventNormalizer, messageText } from './PiEventNormalizer';
import { PiDesktopError, authRequiredError, normalizeError } from './errors';

export interface PiSdkAdapter {
  createModelRuntime: () => Promise<ModelRuntime>;
  createRuntime: (cwd: string, modelRuntime: ModelRuntime) => Promise<AgentSessionRuntime>;
}

const realPiSdkAdapter: PiSdkAdapter = {
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

  constructor(private readonly adapter: PiSdkAdapter = realPiSdkAdapter) {
    this.batcher = new PiEventBatcher((events) => this.eventSink(events));
  }

  setEventSink(sink: (events: PiEvent[]) => void): void {
    this.eventSink = sink;
  }

  getState(includeMessages = true): RuntimeState {
    const session = this.runtime?.session;
    const messages = includeMessages
      ? (session?.messages ?? [])
          .map((message) => toMessage(message, this.normalizer.messageId(message)))
          .filter((message): message is RuntimeMessage => message !== null)
      : [];
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
      error: this.stateError,
    };
  }

  async openProject(project: ProjectState): Promise<RuntimeState> {
    const generation = ++this.initialization;
    await this.disposeRuntime();
    this.project = project;
    this.models = [];
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
      runtime.setRebindSession(async (session) => this.bindSession(session));
      await this.bindSession(runtime.session);
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
        if (accepted) this.batcher.enqueue({ type: 'run.accepted', runId, timestamp: Date.now() });
        else this.emitError({ code: 'INVALID_REQUEST', message: 'Pi rejected the prompt before starting.', retryable: true });
        resolve({ accepted, runId });
      };
      void session.prompt(input.text, {
        ...(images ? { images } : {}),
        ...(input.behavior === 'prompt' ? {} : { streamingBehavior: input.behavior }),
        preflightResult: accept,
      }).catch((error: unknown) => {
        const normalized = normalizeError(error);
        if (!settled) accept(false);
        this.emitError(normalized);
      }).finally(() => {
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

  async newSession(): Promise<RuntimeState> {
    if (!this.runtime) this.requireSession();
    await this.runtime!.newSession();
    this.emitState();
    return this.getState();
  }

  async dispose(): Promise<void> {
    ++this.initialization;
    await this.disposeRuntime();
    this.batcher.dispose();
  }

  private async bindSession(session: AgentSession): Promise<void> {
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    await session.bindExtensions({});
    this.unsubscribeSession = session.subscribe((event: AgentSessionEvent) => {
      const normalizedEvents = this.normalizer.normalize(event);
      for (const normalizedEvent of normalizedEvents) {
        if (normalizedEvent.type === 'error') this.stateError = normalizedEvent.error;
      }
      this.batcher.enqueueMany(normalizedEvents);
      if (event.type === 'agent_start' || event.type === 'agent_end' || event.type === 'thinking_level_changed') this.emitState();
    });
  }

  private requireSession(): AgentSession {
    if (this.status === 'auth-required') throw new PiDesktopError(this.stateError ?? authRequiredError());
    if (!this.runtime) {
      throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open and trust a project before using Pi.', retryable: true });
    }
    return this.runtime.session;
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
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    if (this.runtime) await this.runtime.dispose();
    this.runtime = null;
    this.activeRunId = null;
  }
}
