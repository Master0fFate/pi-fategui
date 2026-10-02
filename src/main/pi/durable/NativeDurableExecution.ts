import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai';
import {
  CompactionTask, GenerationTask, Harness, ROOT_CONVERSATION_ID, createRegistry, defineExtension, hook, section, watchEvents,
  type AgentChange, type AgentEvent, type Conversation, type ConversationId, type Cursor,
  type HarnessSettings, type InputSubmissionDraft, type ModelRef, type Storage, type Submission,
  type SubmissionId, type ToolRegistration,
} from '@earendil-works/pi-durable';
import { bridgeFateTool, NativeCapabilityError, type FateToolBinding } from './FateToolBridge';
import { NativeExecutionFence, NativeEffectNotStartedError, assertNativeJson, failWithNativeCleanup, inspectNativeExecutionBeforeOpen } from './NativeExecutionFence';

export interface NativeDurableExecutionOptions {
  readonly storage: Storage;
  /** The host's existing ModelRuntime implements Models, retaining provider auth/refresh/HTTP behavior. */
  readonly models: Models;
  readonly assertOwnership: () => Promise<void>;
  readonly cwd: string;
  readonly model: ModelRef;
  readonly thinkingLevel?: AgentChange['thinkingLevel'];
  /** Fully resolved resource/skill prompt from the trusted host, not a new prompt implementation. */
  readonly systemPrompt: string;
  readonly tools?: readonly FateToolBinding[];
  /** Native tools must still contain Fate's caller-scoped permission/worktree policy closures. */
  readonly nativeTools?: readonly ToolRegistration[];
  /** Trusted host declarations only: the entire bound implementation/context has no
   * mutating effects. Never infer this from a tool name, annotation or replay flag. */
  readonly knownNoEffectFailures?: readonly string[];
  readonly settings?: HarnessSettings;
  readonly onReport?: (error: unknown) => void;
  /** Declare SDK-only requirements up front; unsupported sessions never silently lose features. */
  readonly requiredSdkFeatures?: readonly ('extension-lifecycle' | 'extension-commands' | 'branch-navigation' | 'codemode' | 'custom-messages')[];
}

/** A real native Harness path. Never implements or impersonates AgentSession. */
export class NativeDurableExecution {
  readonly backend = 'native-durable' as const;
  readonly rootId: ConversationId;
  readonly #harness: Harness;
  readonly #fence: NativeExecutionFence;
  readonly #tools: ReadonlyMap<string, ToolRegistration>;
  readonly #report: (error: unknown) => void;
  #commands: Promise<unknown> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  private constructor(harness: Harness, root: Conversation, fence: NativeExecutionFence, tools: readonly ToolRegistration[], report: (error: unknown) => void) {
    this.#harness = harness;
    this.#report = report;
    this.#fence = fence;
    this.rootId = root.id;
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  static async open(options: NativeDurableExecutionOptions): Promise<NativeDurableExecution> {
    if (options.requiredSdkFeatures?.length) throw new NativeCapabilityError(options.requiredSdkFeatures.join(', '));
    if (options.settings?.stream?.deferred) throw new NativeCapabilityError('deferred provider execution');
    const rawTools = [...(options.tools ?? []).map(bridgeFateTool), ...(options.nativeTools ?? [])];
    if (new Set(rawTools.map((tool) => tool.name)).size !== rawTools.length) throw new Error('Duplicate native tool names are forbidden; Fate capabilities cannot be replaced.');
    const knownNoEffectFailures = new Set(options.knownNoEffectFailures ?? []);
    for (const name of knownNoEffectFailures) if (!rawTools.some((tool) => tool.name === name)) throw new Error(`Unknown no-effect capability ${name}.`);
    const fence = new NativeExecutionFence(options.assertOwnership);
    await fence.assertAdmission();
    const storage = fence.guardStorage(options.storage);
    try { await inspectNativeExecutionBeforeOpen(storage, BACKGROUND_CONTEXT, options.cwd); }
    catch (error) { return failWithNativeCleanup(error, () => storage.close(BACKGROUND_CONTEXT)); }
    const registry = createRegistry();
    const tools: ToolRegistration[] = rawTools.map((tool) => ({
      ...tool,
      replay: 'unsafe',
      executionMode: 'sequential',
      execute: async (args, api, context) => {
        await fence.assertAdmission();
        try {
          const result = await tool.execute(args, api, context);
          assertNativeJson(result);
          await fence.assertAdmission();
          return result;
        } catch (error) {
          if (error instanceof NativeEffectNotStartedError || knownNoEffectFailures.has(tool.name)) {
            // A storage/owner failure still wins over the host's known-no-effect declaration.
            fence.assertKnown();
            throw error;
          }
          // A rejected or aborted effect can have partially happened. A later model must
          // never receive a generic failure and decide to repeat it in the same session.
          await fence.recordUnknown(`Tool ${tool.name} has an unconfirmed outcome. Review evidence before starting a new request.`, api).catch(() => {});
          throw error;
        }
      },
    }));
    const capabilities = defineExtension({
      name: 'fate.native', tools,
      sections: [section('fate_host_prompt', ({ conversationId }) => conversationId === ROOT_CONVERSATION_ID ? options.systemPrompt : undefined, { tag: false })],
      hooks: [
        hook(GenerationTask, { beforeRequest: async () => { await fence.assertAdmission(); return undefined; } }),
        hook(CompactionTask, { beforeCompact: async () => { await fence.assertAdmission(); return undefined; } }),
      ],
    });
    let harness: Harness | undefined;
    try {
      registry.install(capabilities);
      harness = await Harness.open(storage, {
        models: new Proxy(options.models, { get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          // Hooks guard async owner checks; this final synchronous gate closes the
          // cross-conversation race between a hook and the actual provider call.
          if (property === 'streamSimple') return (...args: Parameters<Models['streamSimple']>) => {
            fence.assertKnown();
            return target.streamSimple(...args);
          };
          if (property === 'completeSimple') return async (...args: Parameters<Models['completeSimple']>) => {
            await fence.assertAdmission();
            return target.completeSimple(...args);
          };
          return typeof value === 'function' ? value.bind(target) : value;
        } }),
        registry,
        settings: { ...options.settings, stream: { ...options.settings?.stream, deferred: false }, toolExecution: 'sequential' },
        ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
      }, BACKGROUND_CONTEXT);
      fence.bind(harness);
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { cwd: options.cwd, model: options.model, ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }), extensions: [capabilities], tools },
      });
      return new NativeDurableExecution(harness, root, fence, tools, options.onReport ?? (() => {}));
    } catch (error) {
      return failWithNativeCleanup(error, () => harness?.close(BACKGROUND_CONTEXT) ?? storage.close(BACKGROUND_CONTEXT));
    }
  }

  #command<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#commands.then(async () => {
      if (this.#closed) throw new Error('Native execution is closed.');
      await this.#fence.assertAdmission();
      return operation();
    });
    this.#commands = result.catch(() => {});
    return result;
  }
  async #conversation(id: ConversationId): Promise<Conversation> {
    const conversation = await this.#harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error(`Native conversation ${id} does not exist.`);
    return conversation;
  }

  /** Native inbox admission and requestId deduplication replace the host's replay queue. */
  submit(input: InputSubmissionDraft, conversationId = this.rootId): Promise<SubmissionId> {
    return this.#command(async () => {
      if (!input.requestId?.trim()) throw new Error('Native submissions require a stable, caller-owned requestId.');
      await this.#fence.beforeAdmission();
      const conversation = await this.#conversation(conversationId);
      this.#fence.assertKnown();
      const submission = await conversation.submit(input, BACKGROUND_CONTEXT);
      // A UI may observe instead of awaiting. Quiescence still gets a durable clean
      // receipt, using the native wait rather than a second host execution loop.
      void this.#fence.observeOutcome(() => submission.wait(BACKGROUND_CONTEXT))
        .then(() => this.#command(async () => { await this.#fence.markIdle(); }))
        .catch((error: unknown) => { if (!this.#closed) { try { this.#report(error); } catch { /* Observers cannot restart execution. */ } } });
      return submission.id;
    });
  }
  async #submission(id: SubmissionId): Promise<Submission> {
    const submission = await this.#harness.submission(id, BACKGROUND_CONTEXT);
    if (submission === undefined) throw new Error(`Native submission ${id} does not exist.`);
    return submission;
  }
  async wait(id: SubmissionId, context: Context = BACKGROUND_CONTEXT) {
    await this.#fence.assertAdmission();
    const submission = await this.#submission(id);
    const result = await this.#fence.observeOutcome(() => submission.wait(context));
    // Do not hide UNKNOWN behind a native 'unanswered' receipt.
    await this.#command(async () => { await this.#fence.markIdle(); });
    return result;
  }
  async status(id: SubmissionId) {
    await this.#fence.assertOwnership();
    return (await this.#submission(id)).status(BACKGROUND_CONTEXT);
  }
  abort(conversationId = this.rootId): Promise<void> {
    return this.#command(async () => {
      const conversation = await this.#conversation(conversationId);
      await this.#fence.observeOutcome(() => conversation.abort(BACKGROUND_CONTEXT, { background: true }));
      await this.#fence.markIdle();
    });
  }
  withdraw(id: SubmissionId) {
    return this.#command(async () => {
      const submission = await this.#submission(id);
      this.#fence.assertKnown();
      return submission.abort(BACKGROUND_CONTEXT);
    });
  }
  configure(change: Omit<AgentChange, 'extensions' | 'tools'> & { readonly toolNames?: readonly string[] }, conversationId = this.rootId): Promise<void> {
    return this.#command(async () => {
      const { toolNames, ...agent } = change;
      const tools = toolNames?.map((name) => {
        const tool = this.#tools.get(name);
        if (tool === undefined) throw new Error(`Unknown owned native tool ${name}.`);
        return tool;
      });
      const conversation = await this.#conversation(conversationId);
      if (change.cwd !== undefined && change.cwd !== (await conversation.agent(BACKGROUND_CONTEXT)).cwd) throw new NativeCapabilityError('checkout changes without confined-capability rebinding');
      await conversation.configure({ ...agent, ...(tools === undefined ? {} : { tools }) }, BACKGROUND_CONTEXT);
    });
  }
  async compact(instructions?: string, conversationId = this.rootId) {
    const task = await this.#command(async () => {
      await this.#fence.beforeAdmission();
      const conversation = await this.#conversation(conversationId);
      this.#fence.assertKnown();
      return conversation.compact(instructions, BACKGROUND_CONTEXT);
    });
    await this.#fence.assertAdmission();
    const result = await this.#fence.observeOutcome(() => this.#harness.waitForTask(task, BACKGROUND_CONTEXT));
    await this.#command(async () => { await this.#fence.markIdle(); });
    return result;
  }
  async entries(conversationId = this.rootId, cursor?: Cursor) {
    await this.#fence.assertOwnership();
    return (await this.#conversation(conversationId)).entries({}, 256, cursor, BACKGROUND_CONTEXT);
  }
  async inspect() { await this.#fence.assertOwnership(); return this.#harness.inspect(BACKGROUND_CONTEXT); }
  async usage() { await this.#fence.assertOwnership(); return this.#harness.usage(BACKGROUND_CONTEXT); }
  async fenceState() { return this.#fence.state(); }
  async observe(listener: (events: readonly AgentEvent[]) => Promise<void> | void, conversationId = this.rootId) {
    await this.#fence.assertOwnership();
    const stream = await watchEvents(this.#harness, conversationId, BACKGROUND_CONTEXT);
    stream.start(async (events) => { await this.#fence.assertOwnership(); await listener(events); });
    return { snapshot: stream.snapshot, stop: () => stream.stop(), closed: stream.closed };
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#fence.seal();
    this.#closePromise = (async () => {
      await this.#commands;
      // Active fences survive shutdown; a stopped invocation is not proof of no effect.
      await this.#harness.close(BACKGROUND_CONTEXT);
    })();
    return this.#closePromise;
  }
}
