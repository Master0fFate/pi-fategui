import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEvent, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { PiSdkAdapter } from '../../../src/main/pi/PiRuntimeService';
import { assertPrivatePath, privateTestRoot } from './isolatedEnvironment';
import path from 'node:path';
import { readFile, realpath, writeFile } from 'node:fs/promises';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type BarrierName = 'accept' | 'emit' | 'settle' | 'cancelFailure' | 'acknowledge';
export class NamedBarriers {
  private readonly gates = new Map<BarrierName, { release: ReturnType<typeof deferred>; entered: ReturnType<typeof deferred> }>();
  hold(name: BarrierName): void {
    if (this.gates.has(name)) throw new Error(`Barrier already held: ${name}`);
    this.gates.set(name, { release: deferred(), entered: deferred() });
  }
  reached(name: BarrierName): Promise<void> {
    const gate = this.gates.get(name);
    if (!gate) throw new Error(`Hold barrier before waiting: ${name}`);
    return gate.entered.promise;
  }
  async wait(name: BarrierName): Promise<void> {
    const gate = this.gates.get(name);
    if (gate) { gate.entered.resolve(); await gate.release.promise; }
  }
  release(name: BarrierName): void {
    const gate = this.gates.get(name);
    if (!gate) throw new Error(`Barrier not held: ${name}`);
    this.gates.delete(name);
    gate.release.resolve();
  }
  releaseAll(): void { for (const name of this.gates.keys()) this.release(name); }
}

export interface FakeInvocation {
  sequence: number;
  kind: 'createModelRuntime' | 'createRuntime' | 'prompt' | 'accepted' | 'emit' | 'settled' | 'cancel' | 'cancelRefused' | 'tool' | 'toolResult' | 'providerBlocked';
  sessionId?: string;
  turnId?: string;
  name?: string;
  input?: unknown;
}

const model: Model<'anthropic-messages'> = {
  id: 'v2-deterministic', name: 'V2 deterministic fake', provider: 'v2-fake', api: 'anthropic-messages',
  baseUrl: 'https://provider.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
};

/** A real, type-checked PiSdkAdapter, not a replacement Fate runtime.
 * SDK session/runtime objects retain their public shape; only execution and
 * subscriptions are deterministic. No credentials or resources are discovered.
 */
export class FakePiSdkAdapter implements PiSdkAdapter {
  readonly supportsClone = false;
  readonly supportsDirectSessionRuntime = false;
  readonly invocations: FakeInvocation[] = [];
  readonly controls = new Map<string, { barriers: NamedBarriers; refuseCancellation: boolean; text: string }>();
  /** Test-only deterministic file operation, never selected from the prompt text. */
  readonly plannedEdits = new Map<string, { path: string; before: string; after: string }>();
  private sessionSequence = 0;
  private turnSequence = 0;
  private modelRuntime: ModelRuntime | undefined;
  private readonly runtimes: AgentSessionRuntime[] = [];
  private readonly activeTurns = new Set<Promise<void>>();

  private record(event: Omit<FakeInvocation, 'sequence'>): void {
    this.invocations.push({ sequence: this.invocations.length + 1, ...event });
  }

  async createModelRuntime(): Promise<ModelRuntime> {
    this.record({ kind: 'createModelRuntime' });
    if (this.modelRuntime) return this.modelRuntime;
    const runtime = await ModelRuntime.create({
      credentials: {
        async read() { return undefined; }, async list() { return []; },
        async modify() { throw new Error('Fake credentials are read-only'); }, async delete() {},
      },
      modelsPath: null, modelsStorePath: path.join(privateTestRoot(), 'fake-models-cache'),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    runtime.getAvailable = async () => [model];
    runtime.getAvailableSnapshot = () => [model];
    runtime.getModels = () => [model];
    runtime.getModel = (provider, id) => provider === model.provider && id === model.id ? model : undefined;
    const blocked = (name: string): never => {
      this.record({ kind: 'providerBlocked', name });
      throw new Error(`V2_PROVIDER_BLOCKED: fake adapter cannot call ${name}`);
    };
    runtime.stream = () => blocked('stream');
    runtime.streamSimple = () => blocked('streamSimple');
    runtime.streamDeferred = () => blocked('streamDeferred');
    runtime.complete = async () => blocked('complete');
    runtime.completeSimple = async () => blocked('completeSimple');
    runtime.fetchDeferred = async () => blocked('fetchDeferred');
    runtime.cancelDeferred = async () => blocked('cancelDeferred');
    runtime.getAuth = async () => blocked('getAuth');
    runtime.login = async () => blocked('login');
    this.modelRuntime = runtime;
    return runtime;
  }

  async createRuntime(cwd: string, modelRuntime: ModelRuntime, _projectTrusted?: boolean, customTools: ToolDefinition[] = []): Promise<AgentSessionRuntime> {
    await assertPrivatePath(cwd);
    if (modelRuntime !== this.modelRuntime) throw new Error('Fake adapter requires its own model runtime');
    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd: effectiveCwd }) => {
      await assertPrivatePath(effectiveCwd);
      const sessionId = `00000000-0000-4000-8000-${String(++this.sessionSequence).padStart(12, '0')}`;
      const sessionManager = SessionManager.inMemory(effectiveCwd, { id: sessionId });
      const services = await createAgentSessionServices({
        cwd: effectiveCwd, agentDir: path.join(privateTestRoot(), 'pi/agent'), modelRuntime,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
        },
      });
      const recordedTools = customTools.map((tool): ToolDefinition => ({
        ...tool,
        execute: async (toolCallId, input, signal, onUpdate, context) => this.invokeTool(
          sessionId, tool.name, input, () => tool.execute(toolCallId, input, signal, onUpdate, context),
        ),
      }));
      const created = await createAgentSessionFromServices({
        services, sessionManager, model, noTools: 'all', tools: [], customTools: recordedTools,
      });
      this.installSession(created.session);
      this.record({ kind: 'createRuntime', sessionId, input: effectiveCwd });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(factory, {
      cwd, agentDir: path.join(privateTestRoot(), 'pi/agent'), sessionManager: SessionManager.inMemory(cwd),
    });
    this.runtimes.push(runtime);
    return runtime;
  }

  private installSession(session: AgentSession): void {
    const sessionId = session.sessionId;
    const control = { barriers: new NamedBarriers(), refuseCancellation: false, text: 'deterministic response' };
    this.controls.set(sessionId, control);
    const listeners = new Set<Parameters<AgentSession['subscribe']>[0]>();
    let streaming = false;
    let pending = false;
    let cancelled = false;
    Object.defineProperty(session, 'isStreaming', { get: () => streaming });
    session.subscribe = (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const emit = (event: AgentSessionEvent) => { for (const listener of listeners) listener(event); };
    const runPrompt: AgentSession['prompt'] = async (text, options) => {
      if (pending) throw new Error('Fake session already has an admitted prompt');
      pending = true;
      cancelled = false;
      const turnId = `fake-turn-${String(++this.turnSequence).padStart(4, '0')}`;
      this.record({ kind: 'prompt', sessionId, turnId, input: text });
      try {
        await control.barriers.wait('accept');
        streaming = true;
        this.record({ kind: 'accepted', sessionId, turnId });
        options?.preflightResult?.(true);
        emit({ type: 'agent_start' });
        await control.barriers.wait('emit');
        if (!cancelled) {
          const edit = this.plannedEdits.get(sessionId);
          if (edit) {
            this.plannedEdits.delete(sessionId);
            await this.invokeTool(sessionId, 'edit', { path: edit.path }, async () => {
              const target = await realpath(edit.path);
              await assertPrivatePath(target);
              if (await readFile(target, 'utf8') !== edit.before) throw new Error('Fake edit preimage changed');
              await writeFile(target, edit.after, 'utf8');
              if (await readFile(target, 'utf8') !== edit.after) throw new Error('Fake edit bytes differ');
            });
          }
          const message: AssistantMessage = {
            role: 'assistant', api: model.api, provider: model.provider, model: model.id,
            content: [{ type: 'text', text: control.text }], stopReason: 'stop', timestamp: 0,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          this.record({ kind: 'emit', sessionId, turnId });
          emit({ type: 'message_start', message });
          emit({ type: 'message_end', message });
        }
        await control.barriers.wait('settle');
        streaming = false;
        this.record({ kind: 'settled', sessionId, turnId });
        emit({ type: 'agent_end', messages: [], willRetry: false });
        emit({ type: 'agent_settled' });
        // Holding this models a dropped acknowledgment after an observable effect.
        await control.barriers.wait('acknowledge');
      } finally { streaming = false; pending = false; }
    };
    session.prompt = (text, options) => {
      const turn = runPrompt(text, options);
      this.activeTurns.add(turn);
      void turn.then(() => this.activeTurns.delete(turn), () => this.activeTurns.delete(turn));
      return turn;
    };
    session.abort = async () => {
      this.record({ kind: 'cancel', sessionId });
      if (control.refuseCancellation) {
        await control.barriers.wait('cancelFailure');
        this.record({ kind: 'cancelRefused', sessionId });
        throw new Error('Fake provider refused cancellation');
      }
      cancelled = true;
      control.barriers.releaseAll();
    };
  }

  async invokeTool<T>(sessionId: string, name: string, input: unknown, execute: () => Promise<T>): Promise<T> {
    if (!this.controls.has(sessionId)) throw new Error('Unknown fake session');
    this.record({ kind: 'tool', sessionId, name, input });
    const result = await execute();
    this.record({ kind: 'toolResult', sessionId, name });
    return result;
  }

  async dispose(): Promise<void> {
    for (const control of this.controls.values()) control.barriers.releaseAll();
    await Promise.allSettled(this.activeTurns);
    for (const runtime of this.runtimes) await runtime.dispose();
  }
}
