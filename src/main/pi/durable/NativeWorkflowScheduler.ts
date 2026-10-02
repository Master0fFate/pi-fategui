import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { copyJson, type JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai';
import {
  Harness, createRegistry, defineDoc, defineExtension, defineTask,
  type JsonObject, type Storage, type TaskId, type TaskOutcome,
} from '@earendil-works/pi-durable';
import { openOwnedDurableStorage, DurableStorageCloseUncertainError, type OwnedDurableStorageOptions } from '../../../core/durable/OwnedDurableStorage';
import { NativeExecutionFence, NativeExecutionUnknownError, NativeEffectNotStartedError, inspectNativeExecutionBeforeOpen } from './NativeExecutionFence';

export type NativeWorkflowNodeSpec = { id: string; dependsOn: string[]; dependencyFailure: 'skip' | 'run' };
export type NativeWorkflowNodeResult = { id: string; status: 'completed' | 'error' | 'cancelled' | 'skipped'; value?: JsonObject; error?: string };
export interface NativeWorkflowRun {
  readonly nodes: readonly NativeWorkflowNodeSpec[];
  readonly concurrency: () => number;
  /** Existing Fate admission executes the actual SDK child and returns its confirmed receipt. */
  readonly execute: (id: string, dependencies: Readonly<Record<string, NativeWorkflowNodeResult>>, signal: AbortSignal) => Promise<NativeWorkflowNodeResult>;
  /** Projection callbacks run after the corresponding native commit, never authorize scheduling. */
  readonly started: (id: string) => void;
  readonly settled: (result: NativeWorkflowNodeResult) => void;
}
export interface NativeWorkflowSchedulerInput {
  readonly id: string;
  readonly parentSessionId: string;
  readonly cwd: string;
  readonly models: Models;
}
export type NativeWorkflowSchedulerFactory = (input: NativeWorkflowSchedulerInput) => Promise<NativeWorkflowScheduler>;
export interface NativeWorkflowSchedulerOptions extends NativeWorkflowSchedulerInput {
  readonly storage: Storage | (() => Promise<Storage>);
  readonly assertOwnership: () => Promise<void>;
  readonly onReport?: (error: unknown) => void;
  readonly onFailure?: (error: unknown) => void;
  readonly onUnsafeFailure?: (error: NativeExecutionUnknownError | DurableStorageCloseUncertainError) => void;
  readonly onCloseUncertain?: (error: DurableStorageCloseUncertainError) => void;
  readonly onClosed?: () => void;
}

export const NativeWorkflowIdentityDoc = defineDoc({ kind: 'fate.workflow.identity', scope: 'session', version: 1, initial: () => ({ workflowId: '', parentSessionId: '', cwd: '' }) });

type NodeInput = { id: string; dependencies: Record<string, NativeWorkflowNodeResult>; skipReason?: string };
type NodeCheckpoint = { phase: 'start' } | { phase: 'effect' };
type GraphInput = { nodes: NativeWorkflowNodeSpec[] };
type GraphCheckpoint = { phase: 'schedule'; tasks: Record<string, TaskId<NativeWorkflowNodeResult>> } | { phase: 'join'; tasks: Record<string, TaskId<NativeWorkflowNodeResult>>; on: TaskId<NativeWorkflowNodeResult>[] };
type GraphResult = { nodes: Record<string, NativeWorkflowNodeResult> };

function outcome(id: string, receipt: TaskOutcome<NativeWorkflowNodeResult>): NativeWorkflowNodeResult {
  if (receipt.status === 'completed') return receipt.result;
  return { id, status: receipt.status === 'aborted' ? 'cancelled' : 'error', error: receipt.status === 'failed' || receipt.status === 'faulted' ? receipt.error.message : receipt.reason ?? receipt.status };
}
function validateGraph(nodes: readonly NativeWorkflowNodeSpec[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (!nodes.length || nodes.length > 256 || byId.size !== nodes.length
    || nodes.some((node) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(node.id) || node.dependsOn.length > 256 || new Set(node.dependsOn).size !== node.dependsOn.length || !['skip', 'run'].includes(node.dependencyFailure))) {
    throw new Error('Native workflow requires 1–256 unique bounded node identities and valid dependencies.');
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error('Native workflow contains a dependency cycle.');
    const node = byId.get(id);
    if (!node) throw new Error(`Native workflow dependency ${id} does not exist.`);
    visiting.add(id);
    for (const dependency of node.dependsOn) visit(dependency);
    visiting.delete(id); done.add(id);
  };
  for (const node of nodes) visit(node.id);
}

/**
 * Native task orchestration around existing SDK conversations. There is no Harness
 * generation, second model transcript, or second child execution loop in this path.
 */
export class NativeWorkflowScheduler {
  #used = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  readonly #fence: NativeExecutionFence;
  #harness: Harness | undefined;
  #storage: Storage | undefined;
  #opening: Promise<void> | undefined;
  readonly #externalEffects = new Set<Promise<NativeWorkflowNodeResult>>();
  constructor(private readonly options: NativeWorkflowSchedulerOptions) {
    this.#fence = new NativeExecutionFence(options.assertOwnership);
    this.#storage = typeof options.storage === 'function' ? undefined : options.storage;
  }
  async run(work: NativeWorkflowRun, signal: AbortSignal): Promise<GraphResult> {
    if (this.#used || this.#closed) throw new Error('A native workflow scheduler is single-use.');
    this.#used = true;
    const fence = this.#fence;
    const report = (error: unknown): void => { try { this.options.onReport?.(error); } catch { /* Diagnostics never schedule. */ } };
    const project = (publish: () => void): void => { try { publish(); } catch (error) { report(error); } };
    let removeAbort = () => {};
    try {
      validateGraph(work.nodes);
      signal.throwIfAborted();
      if (!this.#storage) {
        this.#opening ??= Promise.resolve().then(async () => {
          this.#storage = await (this.options.storage as () => Promise<Storage>)();
        });
        await this.#opening;
      }
      if (!this.#storage) throw new NativeExecutionUnknownError('Native workflow storage admission returned no handle.');
      const storage = fence.guardStorage(this.#storage);
      await fence.assertAdmission();
      try { await inspectNativeExecutionBeforeOpen(storage, BACKGROUND_CONTEXT, this.options.cwd); }
      catch (error) {
        if (error instanceof NativeExecutionUnknownError) throw error;
        const unknown = new NativeExecutionUnknownError('Native workflow history cannot be verified before scheduling; automatic retry is prohibited.');
        unknown.cause = error;
        throw unknown;
      }
      // The identity of an already completed graph cannot authorize another launch.
      if ((await storage.scanTasks({}, 1, undefined, BACKGROUND_CONTEXT)).items.length) throw new Error('Native workflow identity already has history. Start a reviewed new workflow; no task was replayed.');
      const registry = createRegistry();
      const nodeTask = defineTask<NodeInput, NodeCheckpoint, NativeWorkflowNodeResult>({
        name: 'fate.workflow.node', version: 1, initial: () => ({ phase: 'start' }),
        phases: {
          start: async (task, runtime, context) => {
            await fence.assertAdmission();
            if (task.input.skipReason !== undefined) {
              const result: NativeWorkflowNodeResult = { id: task.input.id, status: 'skipped', error: task.input.skipReason };
              await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), context);
              project(() => work.settled(result));
              return;
            }
            // Durable intent comes BEFORE original SDK child admission.
            await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'effect' } }), context);
            await fence.assertAdmission();
            project(() => work.started(task.input.id));
            try {
              // This set is physical in-flight ownership evidence, not scheduling state.
              // Keep it until the actual SDK completion promise settles, even after abort.
              const actual = Promise.resolve().then(() => {
                fence.assertKnown(); runtime.signal.throwIfAborted();
                return work.execute(task.input.id, task.input.dependencies, runtime.signal);
              });
              this.#externalEffects.add(actual);
              let supplied: NativeWorkflowNodeResult;
              try { supplied = await actual; } finally { this.#externalEffects.delete(actual); }
              if (!['completed', 'error', 'cancelled', 'skipped'].includes(supplied.status)) throw new Error('SDK workflow outcome is invalid.');
              const result = copyJson({ ...supplied, id: task.input.id }, { omitUndefinedProperties: true }) as NativeWorkflowNodeResult;
              await fence.assertAdmission();
              await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), context);
              project(() => work.settled(result));
            } catch (error) {
              if (error instanceof NativeEffectNotStartedError) {
                fence.assertKnown();
                if (runtime.signal.aborted) throw error;
                const result: NativeWorkflowNodeResult = { id: task.input.id, status: 'error', error: error.message };
                await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), context);
                project(() => work.settled(result));
                return;
              }
              await fence.recordUnknown(`Workflow node ${task.input.id} was admitted but has no confirmed native receipt. Review its SDK session before a new request.`).catch(() => {});
              throw error;
            }
          },
          effect: async () => { throw new NativeExecutionUnknownError('An SDK child effect cannot be replayed from a native workflow checkpoint.'); },
        },
        abort: async (_task, runtime, context) => {
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'Workflow cancellation requested.' } }), context);
        },
      });
      const graphTask = defineTask<GraphInput, GraphCheckpoint, GraphResult>({
        name: 'fate.workflow.graph', version: 1, initial: () => ({ phase: 'schedule', tasks: {} }),
        phases: {
          schedule: async (task, runtime, context) => {
            await fence.assertAdmission();
            const tasks = { ...task.state.checkpoint.tasks };
            const results: Record<string, NativeWorkflowNodeResult> = {};
            const live: TaskId<NativeWorkflowNodeResult>[] = [];
            for (const [id, taskId] of Object.entries(tasks)) {
              const child = await runtime.getTask(taskId, context);
              if (!child) throw new Error('Native workflow child receipt is missing.');
              if (child.state.status === 'terminal') results[id] = outcome(id, child.state.outcome);
              else live.push(taskId);
            }
            if (Object.keys(results).length === task.input.nodes.length) {
              await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { nodes: results } } }), context);
              return;
            }
            const requestedConcurrency = work.concurrency();
            const concurrency = Math.min(requestedConcurrency, task.input.nodes.length);
            if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1 || concurrency > 256) throw new Error('Native workflow concurrency must be a positive integer.');
            const ready = task.input.nodes.filter((node) => !Object.hasOwn(tasks, node.id) && node.dependsOn.every((id) => Object.hasOwn(results, id))).slice(0, Math.max(0, concurrency - live.length));
            if (!ready.length && !live.length) throw new Error('Native workflow has no runnable dependency boundary.');
            await runtime.commit(async (tx) => {
              for (const node of ready) {
                const dependencies = Object.fromEntries(node.dependsOn.map((id) => [id, results[id]!])) as Record<string, NativeWorkflowNodeResult>;
                const failed = Object.values(dependencies).find((result) => result.status !== 'completed');
                const skipReason = failed && node.dependencyFailure === 'skip' ? `Dependency ${failed.id} settled as ${failed.status}.` : undefined;
                tasks[node.id] = await tx.createTask(nodeTask, { id: node.id, dependencies, ...(skipReason === undefined ? {} : { skipReason }) }, { ownership: { kind: 'task', taskId: runtime.taskId } });
                live.push(tasks[node.id]!);
              }
              return { status: 'running', checkpoint: { phase: 'join', tasks, on: live } };
            }, context);
          },
          join: async (task, runtime, context) => {
            await fence.assertAdmission();
            const live: TaskId<NativeWorkflowNodeResult>[] = [];
            for (const id of task.state.checkpoint.on) if ((await runtime.getTask(id, context))?.state.status !== 'terminal') live.push(id);
            // Native invocation-bound waits own cancellation and receipts. No host
            // running-promise map or second task status authority is maintained.
            if (live.length === task.state.checkpoint.on.length && live.length) await fence.observeOutcome(() => Promise.race(live.map((id) => runtime.waitForTask(id, context))));
            await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'schedule', tasks: task.state.checkpoint.tasks } }), context);
          },
        },
        abort: async (_task, runtime, context) => {
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'Workflow cancellation requested.' } }), context);
        },
      });
      registry.install(defineExtension({ name: 'fate.workflow', tasks: [graphTask, nodeTask] }));
      const harness = await Harness.open(storage, { models: this.options.models, registry, onReport: report }, BACKGROUND_CONTEXT);
      this.#harness = harness;
      fence.bind(harness);
      const root = await harness.root(BACKGROUND_CONTEXT, { agent: { cwd: this.options.cwd, tools: [] } });
      await harness.commit(async (tx) => {
        const identity = await tx.doc(NativeWorkflowIdentityDoc);
        identity.workflowId = this.options.id;
        identity.parentSessionId = this.options.parentSessionId;
        identity.cwd = this.options.cwd;
      }, BACKGROUND_CONTEXT);
      await fence.beforeAdmission();
      const graphId = await root.commit((tx) => tx.createTask(graphTask, { nodes: work.nodes.map((node) => ({ ...node, dependsOn: [...node.dependsOn] })) }, { ownership: { kind: 'conversation' } }), BACKGROUND_CONTEXT);
      const abort = () => {
        try { fence.assertKnown(); }
        catch { return; }
        void harness.abortTask(graphId, BACKGROUND_CONTEXT).catch(report);
      };
      signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
      const receipt = await fence.observeOutcome(() => harness.waitForTask(graphId, BACKGROUND_CONTEXT));
      await Promise.allSettled([...this.#externalEffects]);
      await fence.markIdle();
      const result = receipt.state.outcome;
      if (result.status !== 'completed') throw Object.assign(new Error(result.status === 'aborted' ? String(signal.reason ?? 'Workflow cancelled.') : `Native workflow failed: ${result.status}`), { name: result.status === 'aborted' ? 'AbortError' : 'Error' });
      return result.result;
    } catch (error) {
      let failure = error;
      // A failed admission commit may throw its raw backend error before a wait
      // observes the fence. The poisoned gate, not the exception's original class,
      // decides whether the host must reject further execution.
      try { fence.assertKnown(); } catch (blocked) { if (blocked instanceof NativeExecutionUnknownError) failure = blocked; }
      if (failure instanceof NativeExecutionUnknownError || failure instanceof DurableStorageCloseUncertainError) { try { this.options.onUnsafeFailure?.(failure); } catch { /* Keep original failure. */ } }
      try { this.options.onFailure?.(failure); } catch { /* Admission reporting cannot hide the original failure. */ }
      throw failure;
    } finally {
      removeAbort();
      await this.close();
    }
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#fence.seal();
    this.#closePromise = (async () => {
      // Start native close first so its signal reaches SDK callbacks, then retain
      // ownership until BOTH the native kernel and actual SDK work have settled.
      if (this.#opening) {
        try { await this.#opening; }
        catch (error) {
          // The opener reports cleanup uncertainty itself. A clean failed opener
          // returned no storage handle, so there is no backend to close.
          if (error instanceof DurableStorageCloseUncertainError) throw error;
        }
      }
      const closed = this.#harness?.close(BACKGROUND_CONTEXT) ?? this.#storage?.close(BACKGROUND_CONTEXT) ?? Promise.resolve();
      const outcomes = await Promise.allSettled([closed, ...this.#externalEffects]);
      const closeResult = outcomes[0]!;
      if (closeResult.status === 'rejected') {
        const error = closeResult.reason instanceof DurableStorageCloseUncertainError ? closeResult.reason
          : new DurableStorageCloseUncertainError([closeResult.reason], 'Native workflow close is uncertain; retain profile ownership.');
        try { this.options.onUnsafeFailure?.(error); } catch { /* Retain original failure. */ }
        try { this.options.onCloseUncertain?.(error); } catch { /* Retention signal cannot hide uncertainty. */ }
        try { this.options.onFailure?.(error); } catch { /* Admission signal cannot hide uncertainty. */ }
        throw error;
      }
      try { this.options.onClosed?.(); } catch (error) { try { this.options.onReport?.(error); } catch { /* Closed resources remain closed. */ } }
    })();
    return this.#closePromise;
  }
}

/** Convert a confirmed host receipt using upstream's exact JSON canonicalization. */
export function nativeWorkflowValue(value: unknown): JsonObject {
  const result = copyJson(value, { omitUndefinedProperties: true });
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('Native workflow receipt requires a JSON object.');
  return result;
}

export function createOwnedNativeWorkflowSchedulerFactory(owner: Pick<OwnedDurableStorageOptions, 'dataRoot' | 'profileOwner'> & Pick<NativeWorkflowSchedulerOptions, 'onCloseUncertain' | 'onFailure' | 'onUnsafeFailure' | 'onReport'> & { readonly assertStorageAdmission?: (filename: string) => Promise<void> }): NativeWorkflowSchedulerFactory {
  const active = new Set<string>();
  return async (input) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/u.test(input.id) || !input.parentSessionId || input.parentSessionId.length > 500 || !path.isAbsolute(input.cwd) || !path.isAbsolute(owner.dataRoot)) {
      throw new NativeEffectNotStartedError('Native workflow identity requires bounded host IDs and absolute approved paths.');
    }
    const identity = createHash('sha256').update(`${input.cwd}\0${input.parentSessionId}\0${input.id}`).digest('hex');
    if (active.has(identity)) throw new NativeEffectNotStartedError('This native workflow already has an active owned handle; no second scheduler was opened.');
    active.add(identity);
    const filename = `workflow-${identity}.sqlite`;
    let prior: 'existing' | 'new' | 'unverified' = 'unverified';
    let owned: Awaited<ReturnType<typeof openOwnedDurableStorage>> | undefined;
    const storageFailure = (error: unknown): never => {
      const failure = error instanceof DurableStorageCloseUncertainError ? error
        : new NativeExecutionUnknownError(`Native workflow ${prior} storage could not be opened or verified. Review retained evidence; no automatic retry is allowed.`);
      if (failure !== error) failure.cause = error;
      if (failure instanceof DurableStorageCloseUncertainError) { try { owner.onCloseUncertain?.(failure); } catch { /* Retain original error. */ } }
      else active.delete(identity); // No backend handle escaped a clean failed opener.
      try { owner.onUnsafeFailure?.(failure); } catch { /* Retain original error. */ }
      try { owner.onFailure?.(failure); } catch { /* Retain original error. */ }
      throw failure;
    };
    const assertAdmission = async (): Promise<void> => {
      try { await owner.assertStorageAdmission?.(filename); }
      catch (error) {
        if (error instanceof NativeEffectNotStartedError) { active.delete(identity); throw error; }
        storageFailure(error);
      }
    };
    await assertAdmission();
    const open = async (): Promise<Storage> => {
      try {
        await assertAdmission();
        owned = await openOwnedDurableStorage({ dataRoot: owner.dataRoot, profileOwner: owner.profileOwner, filename });
        return owned.storage;
      } catch (error) { if (error instanceof NativeEffectNotStartedError) throw error; return storageFailure(error); }
    };
    try {
      try { await fs.lstat(path.join(owner.dataRoot, 'durable', 'v1', filename)); prior = 'existing'; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') prior = 'new'; else throw error; }
    } catch (error) { return storageFailure(error); }
    // Known invalid/cancelled NEW work must not create an empty database that a
    // later restart must conservatively treat as unidentified execution history.
    const storage = prior === 'new' ? open : await open();
    return new NativeWorkflowScheduler({ ...owner, ...input, storage,
      assertOwnership: async () => {
        if (!owned) throw new Error('Native workflow storage was not admitted.');
        await owned.assertOwnership();
      },
      onClosed: () => { active.delete(identity); },
    });
  };
}
