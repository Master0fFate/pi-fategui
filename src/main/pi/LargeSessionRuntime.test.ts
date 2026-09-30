import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PiRuntimeService, type PiSdkAdapter } from './PiRuntimeService';
import { PiSessionRepository, projectSessionDirectory, type SessionRepositorySource } from './PiSessionRepository';

// No installed providers, credentials, extension code, or live user sessions are used.
// Real SDK sessions and context projection are intentionally exercised on both sides
// of PiRuntimeService's cold-to-live boundary; only the provider stream is fake.
const model = {
  provider: 'fixture-offline', id: 'no-network', name: 'Offline fixture', api: 'openai-completions',
  baseUrl: 'http://127.0.0.1/never-called', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4_096,
} as Model<'openai-completions'>;
const payload = 'x'.repeat(355 * 1024); // ~363 KiB lines, like repeated team state snapshots.
const SNAPSHOTS = 390;
const MIB = 1024 * 1024;
let home: string;
let projectPath: string;
let sessionsRoot: string;
let sessionFile: string;
let sessionId: string;
let originalLeaf: string;
let inactiveEntry: string;
let entryCount: number;
let repository: PiSessionRepository;
let offlineAdapter: PiSdkAdapter;

function textMessage(role: 'user' | 'assistant', text: string): Parameters<SessionManager['appendMessage']>[0] {
  return {
    role, content: [{ type: 'text', text }], timestamp: Date.now(),
    ...(role === 'assistant' ? {
      api: model.api, provider: model.provider, model: model.id, stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } : {}),
  } as Parameters<SessionManager['appendMessage']>[0];
}

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'fate-large-resume-'));
  projectPath = path.join(home, 'project');
  sessionsRoot = path.join(home, 'agent', 'sessions');
  await mkdir(projectPath, { recursive: true });
  const manager = SessionManager.create(projectPath, projectSessionDirectory(projectPath, sessionsRoot));
  manager.appendModelChange(model.provider, model.id);
  manager.appendThinkingLevelChange('off');
  manager.appendMessage(textMessage('user', 'Original beginning'));
  const forkRoot = manager.appendMessage(textMessage('assistant', 'Original first response'));
  manager.appendMessage(textMessage('user', 'INACTIVE FORK ONLY'));
  inactiveEntry = manager.appendMessage(textMessage('assistant', 'INACTIVE FORK ANSWER'));
  manager.branch(forkRoot);
  manager.appendMessage(textMessage('user', 'Before compaction'));
  const firstKept = manager.appendMessage(textMessage('user', 'Kept in active context'));
  manager.appendCompaction('CANONICAL COMPACTION SUMMARY', firstKept, 11_000);
  for (let index = 0; index < SNAPSHOTS; index++) {
    manager.appendCustomEntry('fixture-team-state', { teamId: 'fixture-team', sequence: index, team: { state: payload } });
  }
  manager.appendMessage(textMessage('user', 'Resume this active branch'));
  originalLeaf = manager.appendMessage(textMessage('assistant', 'Last active response'));
  sessionFile = manager.getSessionFile()!;
  sessionId = manager.getSessionId();
  entryCount = manager.getEntries().length;
  expect((await stat(sessionFile)).size).toBeGreaterThan(128 * MIB);
  const source: SessionRepositorySource = {
    list: (cwd) => SessionManager.list(cwd, projectSessionDirectory(cwd, sessionsRoot)),
    rename: (file, name) => { SessionManager.open(file).appendSessionInfo(name); },
  };
  repository = new PiSessionRepository(source, sessionsRoot);
}, 120_000);

afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

describe('large saved-session cold-to-live resume', () => {
  it('keeps the full original SDK tree and compaction context across a lazy switch and first prompt', async () => {
    const captured: Array<{ sessionId: string; messages: string[] }> = [];
    const managerOpens: string[] = [];
    const streamSimple = vi.fn((_requestModel: Model<'openai-completions'>, context: { messages: unknown[] }, options?: { sessionId?: string }) => {
      captured.push({ sessionId: options?.sessionId ?? '', messages: context.messages.map((message) => JSON.stringify(message)) });
      const answer: AssistantMessage = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: 'OFFLINE CONTINUATION' }], stopReason: 'stop',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: answer }); stream.push({ type: 'done', reason: 'stop', message: answer }); });
      return stream;
    });
    const modelRuntime = {
      getModel: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      getAvailable: async () => [model],
      hasConfiguredAuth: () => true, // fake only; no auth store is read
      refresh: async () => ({ aborted: false, errors: new Map() }),
      streamSimple,
    } as unknown as ModelRuntime;
    const adapter: PiSdkAdapter = {
      supportsDirectSessionRuntime: true,
      createModelRuntime: async () => modelRuntime,
      createRuntime: async (cwd, runtime, _trusted, _tools, _images, _attestation, savedPath): Promise<AgentSessionRuntime> => {
        if (savedPath) managerOpens.push(savedPath);
        const sessionManager = savedPath ? SessionManager.open(savedPath, undefined, cwd) : SessionManager.inMemory(cwd);
        const settingsManager = SettingsManager.create(cwd, path.join(home, 'agent'), { projectTrusted: true });
        const services = await createAgentSessionServices({
          cwd, modelRuntime: runtime, settingsManager,
          resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true },
        });
        return createAgentSessionRuntime(async ({ sessionManager: opened }) => {
          const created = await createAgentSessionFromServices({
            services, sessionManager: opened, model, thinkingLevel: 'off', tools: [],
          });
          return { ...created, services, diagnostics: [] };
        }, { cwd, agentDir: path.join(home, 'agent'), sessionManager });
      },
    };
    offlineAdapter = adapter;
    const service = new PiRuntimeService(adapter, repository);
    try {
      await service.openProject({ path: projectPath, name: 'Fixture project', trusted: true });
      const cold = await service.switchSession(sessionId);
      expect(cold.sessionId).toBe(sessionId);
      expect(cold.sessionFile).toBe(sessionFile);
      expect(cold.messages.some((message) => message.text.includes('Resume this active branch'))).toBe(true);
      expect(cold.messages.some((message) => message.id === `saved-preview-notice:${sessionId}` && message.role === 'system')).toBe(true);
      expect(managerOpens).toEqual([]); // switch is disk preview, not Pi runtime creation
      expect(streamSimple).not.toHaveBeenCalled();

      const accepted = await service.prompt({ text: 'Continue in this session', behavior: 'prompt' });
      expect(accepted.accepted).toBe(true);
      const live = service.getState(false);
      expect(live.sessionId).toBe(sessionId);
      expect(live.sessionFile).toBe(sessionFile);
      expect(managerOpens).toEqual([sessionFile]);
      const selected = (service as unknown as { selectedSlot: { runtime: AgentSessionRuntime } }).selectedSlot.runtime.session;
      await vi.waitFor(() => expect(captured).toHaveLength(1), { timeout: 20_000, interval: 20 });
      await selected.waitForIdle();
      expect(selected.sessionManager.getEntries().length).toBeGreaterThanOrEqual(entryCount + 2); // user + reply; Fate may append a title
      const restoredSnapshots = selected.sessionManager.getBranch().filter((entry) => entry.type === 'custom' && entry.customType === 'fixture-team-state');
      expect(restoredSnapshots).toHaveLength(SNAPSHOTS);
      expect((restoredSnapshots[0] as { data: { team: { state: string } } }).data.team.state).toBe(payload);
      expect((restoredSnapshots.at(-1) as { data: { team: { state: string } } }).data.team.state).toBe(payload);
      expect(selected.sessionManager.getEntry(inactiveEntry)).toBeDefined(); // inactive fork is still in the full tree
      expect(selected.sessionManager.getBranch().some((entry) => entry.id === inactiveEntry)).toBe(false);
      expect(selected.sessionManager.getBranch().some((entry) => entry.id === originalLeaf)).toBe(true);
      expect(selected.sessionManager.getBranch().at(-1)?.type).toBe('message');
      expect(captured).toHaveLength(1);
      expect(captured[0]!.sessionId).toBe(sessionId);
      const context = captured[0]!.messages.join('\n');
      expect(context).toContain('CANONICAL COMPACTION SUMMARY');
      expect(context).toContain('Kept in active context');
      expect(context).toContain('Resume this active branch');
      expect(context).toContain('Continue in this session');
      expect(context).not.toContain('INACTIVE FORK ONLY');
      expect(context).not.toContain('Before compaction');
      expect(context).not.toMatch(/\[Earlier message omitted from preview\]|\[Large message omitted from preview\]|history-boundary/);
      expect(context).not.toContain('Saved history was not changed.');
      expect(streamSimple).toHaveBeenCalledOnce();
      const reopened = SessionManager.open(sessionFile, undefined, projectPath);
      expect(reopened.getSessionId()).toBe(sessionId);
      expect(reopened.getEntries().length).toBeGreaterThanOrEqual(entryCount + 2); // continued user + offline reply persisted
      expect(reopened.getEntry(inactiveEntry)).toBeDefined();
      expect(reopened.getBranch().filter((entry) => entry.type === 'custom' && entry.customType === 'fixture-team-state')).toHaveLength(SNAPSHOTS);
    } finally {
      await service.dispose();
    }
  }, 120_000);

  it('refuses a missing saved file rather than prompting a new SDK session under the cold selection', async () => {
    const service = new PiRuntimeService(offlineAdapter, repository);
    try {
      await service.openProject({ path: projectPath, name: 'Fixture project', trusted: true });
      const cold = await service.switchSession(sessionId);
      expect(cold.sessionId).toBe(sessionId);
      await rm(sessionFile);
      await expect(service.prompt({ text: 'Never send to a substitute', behavior: 'prompt' })).rejects.toThrow(/saved session changed/i);
      expect(service.getState(false).sessionId).toBe(sessionId); // cold selection survives failure
      await expect(stat(sessionFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await service.dispose();
    }
  }, 120_000);
});
