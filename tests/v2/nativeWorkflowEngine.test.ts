import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { SessionManager, type AgentSession, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { MemoryStorage, type Storage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { AgentWorkflowCoordinator } from '../../src/main/pi/AgentWorkflowCoordinator';
import { AgentTeamCoordinator } from '../../src/main/pi/multi-agent/AgentTeamCoordinator';
import { NativeWorkflowScheduler } from '../../src/main/pi/durable/NativeWorkflowScheduler';
import { SubagentWorkflowEngine, type SubagentWorkflow } from '../../src/main/pi/SubagentWorkflow';
import type { SubagentChildSessionFactory } from '../../src/main/pi/SubagentSessionFactory';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function held() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(handler: (text: string, index: number) => Promise<string>) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fate-native-workflow-engine-'))); roots.push(dir);
  const models = createModels(); models.setProvider(fauxProvider().provider);
  const model = models.getModel('faux', 'faux-1')!;
  const runtime = models as unknown as ModelRuntime;
  const rootManager = SessionManager.create(dir, path.join(dir, 'root-history'));
  const root = { sessionId: rootManager.getSessionId(), model, thinkingLevel: 'off', messages: [], isStreaming: false,
    resourceLoader: { getSkills: () => ({ skills: [] }) }, sessionManager: rootManager, sendCustomMessage: vi.fn(),
  } as unknown as AgentSession;
  const children: Array<{ id: string; file: string; prompt: string; aborted: boolean }> = [];
  const childFactory: SubagentChildSessionFactory = async (input) => {
    const manager = SessionManager.create(input.projectPath, input.sessionDirectory);
    const child = { id: manager.getSessionId(), file: manager.getSessionFile()!, prompt: '', aborted: false };
    children.push(child);
    const messages: unknown[] = [];
    return { sessionId: child.id, model: input.model, thinkingLevel: input.thinkingLevel, messages,
      sessionManager: manager, resourceLoader: { getSkills: () => ({ skills: [] }) }, subscribe: () => () => {},
      prompt: async (text: string) => {
        child.prompt = text;
        const user = { role: 'user' as const, content: text, timestamp: Date.now() }; messages.push(user); manager.appendMessage(user);
        const result = await handler(text, children.indexOf(child));
        const assistant = fauxAssistantMessage(result); messages.push(assistant); manager.appendMessage(assistant);
      },
      sendCustomMessage: vi.fn(), abort: async () => { child.aborted = true; }, dispose: vi.fn(), isStreaming: false,
    } as unknown as AgentSession;
  };
  const teams = new AgentTeamCoordinator({ resolveRoot: () => ({ projectPath: dir, session: root, permissionLevel: 'read-only' }), getAgentWorkspacePolicy: () => ({ preferredMode: 'shared', strict: false }), emit: () => {}, persist: () => {} }, path.join(dir, 'teams'), childFactory);
  const snapshots: SubagentWorkflow[] = [];
  const stores: MemoryStorage[] = [];
  let closes = 0;
  const coordinator = new AgentWorkflowCoordinator(teams, { resolveParent: () => ({ projectPath: dir, session: root }), emit: () => {}, persist: (_id, workflow) => { snapshots.push(structuredClone(workflow)); } }, async (input) => {
    const backing = new MemoryStorage(); stores.push(backing);
    const storage = new Proxy(backing, { get(target, key) { if (key === 'close') return async () => { closes++; }; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } }) as Storage;
    return new NativeWorkflowScheduler({ ...input, storage, assertOwnership: async () => {} });
  });
  const tool = coordinator.createTool(runtime);
  const execute = (id: string, params: unknown) => tool.execute(id, params as never, undefined, undefined, { cwd: dir, sessionManager: { getSessionId: () => root.sessionId } } as never);
  return { dir, root, runtime, teams, coordinator, snapshots, stores, children, execute, closes: () => closes, cleanup: async () => { await teams.cancelAll(); coordinator.reset(); } };
}

describe('production native workflow engine composition', () => {
  it('uses native scheduling while preserving existing Team policy, SDK JSONL identities and dependency context', async () => {
    const f = await fixture(async (text, index) => index === 0 ? 'Original SDK child result' : `Reviewed ${text}`);
    try {
      await f.execute('native-dag', { action: 'start', maxConcurrency: 2, nodes: [
        { id: 'first', task: 'Inspect fixture', tools: ['read'], permission: 'read-only', mailboxTtlSeconds: 0 },
        { id: 'review', task: 'Review evidence', dependsOn: ['first'], includeDependencyResults: true, tools: ['read'], permission: 'read-only', mailboxTtlSeconds: 0 },
      ] });
      await expect.poll(() => f.coordinator.getWorkflowViews(f.root.sessionId)[0]?.status).toBe('completed');
      await expect.poll(() => f.coordinator.hasAnyActive()).toBe(false);
      expect(f.children).toHaveLength(2);
      expect(f.children[1]!.prompt).toContain('Original SDK child result');
      for (const child of f.children) {
        const text = await fs.readFile(child.file, 'utf8');
        expect(text).toContain(child.id);
        expect(text).toContain('assistant');
      }
      expect(f.snapshots.every((snapshot) => snapshot.scheduler?.kind === 'native-pi-durable')).toBe(true);
      expect(f.snapshots.at(-1)?.nodes.every((node) => node.status === 'completed' && node.runId)).toBe(true);
      const tasks = (await f.stores[0]!.scanTasks({}, 20, undefined, BACKGROUND_CONTEXT)).items;
      expect(tasks.map((task) => task.kind).sort()).toEqual(['fate.workflow.graph', 'fate.workflow.node', 'fate.workflow.node']);
      expect(f.closes()).toBe(1);
    } finally { await f.cleanup(); }
  });

  it('keeps native workflow active and storage owned after Team logical interruption until real SDK/lease settlement', async () => {
    const release = held();
    const f = await fixture(async () => { await release.promise; return 'Late actual SDK completion'; });
    let cancellation: Promise<void> | undefined;
    try {
      await f.execute('held-sdk', { action: 'start', nodes: [{ id: 'held', task: 'Wait', tools: ['read'], mailboxTtlSeconds: 0 }, { id: 'later', task: 'Later', dependsOn: ['held'] }] });
      await expect.poll(() => f.children.length).toBe(1);
      await expect.poll(() => f.teams.hasActiveWork(f.root.sessionId)).toBe(true);
      cancellation = f.coordinator.cancelParent(f.root.sessionId).catch(() => {});
      await expect.poll(() => f.children[0]?.aborted).toBe(true);
      const fence = await f.stores[0]!.findDocument({ kind: 'fate.execution.fence', scope: { kind: 'session' } }, 'current', BACKGROUND_CONTEXT);
      expect((await f.stores[0]!.document(fence!.id, 'current', BACKGROUND_CONTEXT))?.value.state).toBe('active');
      expect(f.coordinator.hasAnyActive()).toBe(true);
      expect(f.teams.hasActiveWork(f.root.sessionId)).toBe(true);
      expect(f.closes()).toBe(0);
      release.resolve();
      await cancellation;
      await expect.poll(() => f.coordinator.hasAnyActive()).toBe(false);
      expect(f.children).toHaveLength(1);
      expect(f.closes()).toBe(1);
      expect((await f.stores[0]!.document(fence!.id, 'current', BACKGROUND_CONTEXT))?.value.state).toBe('UNKNOWN');
    } finally { release.resolve(); await cancellation; await f.cleanup(); }
  });

  it('persisted native workflow identity cannot resurrect through the legacy resume path', async () => {
    const f = await fixture(async () => 'Complete');
    try {
      await f.execute('native-id', { action: 'start', nodes: [{ id: 'one', task: 'One', mailboxTtlSeconds: 0 }] });
      await expect.poll(() => f.coordinator.hasAnyActive()).toBe(false);
      const saved = structuredClone(f.snapshots.at(-1)!); saved.status = 'running'; saved.nodes[0]!.status = 'running';
      let launches = 0;
      const restored = new SubagentWorkflowEngine({ launchNode: async () => { launches++; throw new Error('Legacy should not run'); }, cancelRuns: async () => {}, usedHandles: () => [], runIdentity: () => undefined, persist: () => {}, changed: () => {}, notify: async () => {}, liveness: () => {}, settled: () => {} });
      restored.restore(f.root.sessionId, [saved]);
      await expect(restored.resume(f.root.sessionId, saved.id, f.runtime)).rejects.toThrow('cannot be replayed');
      const repeated = restored.start(f.root.sessionId, saved.parentToolCallId, { nodes: saved.nodes.map((node) => node.request), maxConcurrency: saved.maxConcurrency, notification: saved.notification }, f.runtime);
      expect(repeated.scheduler).toEqual(saved.scheduler);
      expect(repeated.status).toBe('paused');
      expect(launches).toBe(0);
      expect(restored.getWorkflow(f.root.sessionId, saved.id)?.nodes[0]?.status).toBe('interrupted');
    } finally { await f.cleanup(); }
  });
});
