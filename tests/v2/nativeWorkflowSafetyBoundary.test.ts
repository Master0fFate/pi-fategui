import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createModels, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { SessionManager, type AgentSession, type ModelRuntime, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createFateCore } from '../../src/core/createFateCore';
import { FatePaths } from '../../src/core/FatePaths';
import { MultiProjectPiRuntime, type MultiProjectPiRuntimeDeps } from '../../src/main/pi/MultiProjectPiRuntime';
import type { AgentWorkflowCoordinator } from '../../src/main/pi/AgentWorkflowCoordinator';
import type { AgentTeamCoordinator } from '../../src/main/pi/multi-agent/AgentTeamCoordinator';
import type { SubagentChildSessionFactory } from '../../src/main/pi/SubagentSessionFactory';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { privateTestRoot } from './helpers/isolatedEnvironment';

interface InternalRuntimeFixture {
  hostStopping: boolean;
  modelRuntime: ModelRuntime;
  agentTeams: AgentTeamCoordinator;
  agentWorkflows: AgentWorkflowCoordinator;
  selectedSlot: { runtime: { session: AgentSession } };
  setAgentWorkspacePolicySource(source: () => { preferredMode: 'shared'; strict: false }): void;
}
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function held() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(capture?: (tools: ToolDefinition[]) => void) {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'native-workflow-safety-')); roots.push(root);
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const paths = new FatePaths({ dataRoot: path.join(root, 'data'), piAgentDir: path.join(root, 'pi'), sessionsRoot: path.join(root, 'pi', 'sessions'), attachmentRoot: path.join(root, 'attachments'), lockRoot: path.join(root, 'locks'), profileId: 'native-safety', profileKind: 'desktop' });
  const adapter = new FakePiSdkAdapter();
  const original = adapter.createRuntime.bind(adapter);
  adapter.createRuntime = async (...args) => { capture?.(args[3] ?? []); return original(...args); };
  let deps: MultiProjectPiRuntimeDeps | undefined;
  const core = await createFateCore({ paths, adapter, statePersistence: 'native-durable', createRuntime: (input) => { deps = input; return new MultiProjectPiRuntime(input); } });
  await core.runtime.openProject({ path: project, name: 'Fixture', trusted: true });
  const service = core.runtime.getFocused() as unknown as InternalRuntimeFixture;
  service.setAgentWorkspacePolicySource(() => ({ preferredMode: 'shared', strict: false }));
  const session = service.selectedSlot.runtime.session;
  const poison = async (id: string) => {
    const scope = await deps!.nativeWorkflowSchedulerFactory!({ id, parentSessionId: session.sessionId, cwd: project, models: service.modelRuntime });
    await expect(scope.run({ nodes: [{ id: 'effect', dependsOn: [], dependencyFailure: 'skip' }], concurrency: () => 1, started: () => {}, settled: () => {}, execute: async () => { throw new Error('Unconfirmed external effect'); } }, new AbortController().signal)).rejects.toThrow();
  };
  return { core, adapter, paths, project, service, session, make: deps!.nativeWorkflowSchedulerFactory!, poison, close: async () => { await core.dispose(); await adapter.dispose(); } };
}

describe('actual core native workflow safety boundaries', () => {
  it('rejects an actual root tool definition retained before the native unsafe outcome', async () => {
    let retained: ToolDefinition | undefined;
    const f = await fixture((tools) => { retained = tools.find((tool) => tool.name === 'create_task'); });
    try {
      expect(retained).toBeDefined();
      await f.poison('root-tool-fence');
      await expect(retained!.execute('retained', { title: 'Must not be created' }, undefined, undefined, { cwd: f.project, sessionManager: { getSessionId: () => f.session.sessionId } } as never)).rejects.toThrow();
      expect(f.service.hostStopping).toBe(true);
    } finally { await f.close(); }
  });

  it('does not dispatch an already queued SDK child turn after another native workflow poisons the host', async () => {
    const f = await fixture();
    const release = held();
    let prompts = 0;
    try {
      const factory: SubagentChildSessionFactory = async (input) => {
        const manager = SessionManager.create(input.projectPath, input.sessionDirectory);
        const messages: unknown[] = [];
        return { sessionId: manager.getSessionId(), sessionManager: manager, model: input.model, thinkingLevel: input.thinkingLevel, messages, isStreaming: false,
          resourceLoader: { getSkills: () => ({ skills: [] }) }, subscribe: () => () => {}, getActiveToolNames: () => [], setActiveToolsByName: () => {}, sendCustomMessage: async () => {},
          prompt: async () => { prompts++; if (prompts === 1) await release.promise; messages.push(fauxAssistantMessage('Settled')); }, abort: async () => {}, dispose: () => {},
        } as unknown as AgentSession;
      };
      (f.service.agentTeams as unknown as { childSessionFactory: SubagentChildSessionFactory }).childSessionFactory = factory;
      const root = f.service.agentTeams.rootNodeId(f.session.sessionId);
      const child = await f.service.agentTeams.spawn(root, { task: 'Existing held work', permission: 'read-only', tools: ['read'] }, 'initial', f.service.modelRuntime);
      await expect.poll(() => prompts).toBe(1);
      await f.service.agentTeams.followUp(root, child.nodeId, 'Previously queued turn', 'queued', f.service.modelRuntime);
      await f.poison('queued-child-fence');
      release.resolve();
      await expect.poll(() => f.service.agentTeams.hasActiveWork(f.session.sessionId)).toBe(false);
      expect(prompts).toBe(1);
    } finally { release.resolve(); await f.close(); }
  });

  it('preserves known no-effect Team permission refusals without stopping the host', async () => {
    const f = await fixture();
    try {
      const createChild = vi.fn(async () => { throw new Error('Child creation must not be reached'); });
      (f.service.agentTeams as unknown as { childSessionFactory: SubagentChildSessionFactory }).childSessionFactory = createChild;
      await f.service.agentWorkflows.createTool(f.service.modelRuntime).execute('no-effect', { action: 'start', nodes: [{ id: 'invalid', task: 'Validation refusal', permission: 'read-only', tools: ['write'], mailboxTtlSeconds: 0 }] }, undefined, undefined, { cwd: f.project, sessionManager: { getSessionId: () => f.session.sessionId } } as never);
      await expect.poll(() => f.service.agentWorkflows.hasAnyActive()).toBe(false);
      expect(createChild).not.toHaveBeenCalled();
      expect(f.service.agentWorkflows.getWorkflowViews(f.session.sessionId)[0]?.status).toBe('error');
      expect(f.service.hostStopping).toBe(false);
    } finally { await f.close(); }
  });

  it('treats a selected pre-existing unsupported workflow database as unsafe historical uncertainty', async () => {
    const f = await fixture();
    try {
      const input = { id: 'unsupported-history', parentSessionId: f.session.sessionId, cwd: f.project, models: createModels() };
      const hash = createHash('sha256').update(`${input.cwd}\0${input.parentSessionId}\0${input.id}`).digest('hex');
      const file = path.join(f.paths.dataRoot, 'durable', 'v1', `workflow-${hash}.sqlite`);
      await fs.writeFile(file, '', { mode: 0o600 });
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(file);
      database.exec("CREATE TABLE unsupported_history(effect TEXT); INSERT INTO unsupported_history VALUES ('possible effect');");
      database.close();
      await expect(f.make(input)).rejects.toThrow('storage could not be opened or verified');
      expect(f.service.hostStopping).toBe(true);
    } finally { await f.close(); }
  });
  it('keeps retained execution fenced by the host-wide stopping bit if a service shutdown callback throws', async () => {
    let retained: ToolDefinition | undefined;
    const f = await fixture((tools) => { retained = tools.find((tool) => tool.name === 'create_task'); });
    const service = f.service as unknown as { beginHostShutdown(): void };
    const fail = vi.spyOn(service, 'beginHostShutdown').mockImplementation(() => { throw new Error('Injected service shutdown failure'); });
    try {
      expect(() => f.core.runtime.beginShutdown()).toThrow('Injected service shutdown failure');
      expect(f.service.hostStopping).toBe(false);
      await expect(retained!.execute('retained-global', { title: 'Must remain fenced' }, undefined, undefined, { cwd: f.project, sessionManager: { getSessionId: () => f.session.sessionId } } as never)).rejects.toThrow('runtime host is stopping');
    } finally { fail.mockRestore(); await f.close(); }
  });

});
