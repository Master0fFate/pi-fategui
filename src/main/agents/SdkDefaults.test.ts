import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, createSyntheticSourceInfo, createWriteToolDefinition, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeToolsForPermission, createProjectConfinedTools } from '../pi/PiToolPolicy';
import { ApprovalGate } from './ApprovalGate';
import { DefinitionJournal, type DefinitionSnapshot } from './DefinitionJournal';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('D0-02 real Pi SDK 0.85.1 feasibility (no provider requests)', () => {
  it('keeps Agent instructions in system context and the exact TaskTemplate as a user message', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agents-sdk-')));
    roots.push(root);
    const agentDir = path.join(root, 'agent');
    await fs.mkdir(agentDir);
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: path.join(root, 'models.json'), modelsStorePath: path.join(root, 'models-store.json'), allowModelNetwork: false });
    await modelRuntime.setRuntimeApiKey('anthropic', 'local-fixture-no-provider-request');
    const model = modelRuntime.getModel('anthropic', 'claude-sonnet-4-5');
    if (!model) throw new Error('Required local model fixture unavailable.');
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const skillPath = path.join(root, 'SKILL.md');
    await fs.writeFile(skillPath, '# Method\nRead carefully.');
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir, settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      systemPromptOverride: () => 'System baseline.',
      appendSystemPromptOverride: () => ['Agent persona: deliberate review.'],
      skillsOverride: () => ({ skills: [{ name: 'method', description: 'Careful review method', filePath: skillPath, baseDir: root, sourceInfo: createSyntheticSourceInfo(skillPath, { source: 'sdk' }), disableModelInvocation: false }], diagnostics: [] }),
    });
    await loader.reload();
    const tools = await createProjectConfinedTools(root, { fullAccess: false });
    const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model, thinkingLevel: 'high', resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root), tools: ['read'], customTools: tools as unknown as NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>['customTools']> });
    const task = '/command @live ~saved\nTask payload, not instructions.';
    let observedSystem = '';
    let observedUser: unknown;
    const stream = vi.fn<typeof session.agent.streamFunction>((requestedModel, context) => {
      observedSystem = context.systemPrompt ?? '';
      observedUser = context.messages.find((message) => message.role === 'user');
      const events = createAssistantMessageEventStream();
      const response: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Local test response.' }], api: requestedModel.api, provider: requestedModel.provider, model: requestedModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
      events.push({ type: 'done', reason: 'stop', message: response });
      events.end(response);
      return events;
    });
    session.agent.streamFunction = stream;
    try {
      expect(session.model?.id).toBe(model.id);
      expect(session.thinkingLevel).toBe('high');
      expect(session.getActiveToolNames()).toEqual(['read']);
      expect(session.resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(['method']);
      await session.prompt(task, { expandPromptTemplates: false });
      expect(stream).toHaveBeenCalledOnce();
      expect(observedSystem).toContain('Agent persona: deliberate review.');
      expect(observedSystem).not.toContain(task);
      expect(observedUser).toMatchObject({ role: 'user', content: [{ type: 'text', text: task }] });
      expect(session.messages.some((message) => message.role === 'assistant')).toBe(true);
    } finally { session.dispose(); }
  });

  it('pauses a real session write before effect and resumes only after durable exact-action approval', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agents-sdk-approval-')));
    roots.push(root);
    const agentDir = path.join(root, 'agent');
    await fs.mkdir(agentDir);
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: null, modelsStorePath: path.join(root, 'models-store.json'), allowModelNetwork: false });
    await modelRuntime.setRuntimeApiKey('anthropic', 'local-fixture-no-provider-request');
    const model = modelRuntime.getModel('anthropic', 'claude-sonnet-4-5')!;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true });
    await loader.reload();
    const journal = new DefinitionJournal(path.join(root, 'approvals'));
    let notify!: (snapshot: DefinitionSnapshot) => void;
    const attention = new Promise<DefinitionSnapshot>((resolve) => { notify = resolve; });
    const gate = new ApprovalGate(journal, () => ({ trusted: true, permission: 'edit', binding: { runId: 'run-1', definitionRevision: 1, taskRevision: 1, permissionRevision: 1, projectPath: root } }), (_id, snapshot) => notify(snapshot));
    const tools = await createProjectConfinedTools(root, { fullAccess: false, permissionLevel: 'edit' });
    const write = tools.find((tool) => tool.name === 'write') as ReturnType<typeof createWriteToolDefinition>;
    const original = write.execute;
    write.execute = (callId, params, signal, update, context) => gate.execute('call-write', 'write', params, (approved) => original(callId, approved, signal, update, context), signal);
    const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root), tools: ['read', 'write'], customTools: tools as unknown as NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>['customTools']> });
    let turns = 0;
    session.agent.streamFunction = (requestedModel) => {
      const first = turns++ === 0;
      const response: AssistantMessage = { role: 'assistant', content: first ? [{ type: 'toolCall', id: 'call-write', name: 'write', arguments: { path: 'approved.txt', content: 'Approved bytes.' } }] : [{ type: 'text', text: 'Done.' }], api: requestedModel.api, provider: requestedModel.provider, model: requestedModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
      const events = createAssistantMessageEventStream();
      events.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message: response });
      events.end(response);
      return events;
    };
    try {
      const run = session.prompt('Write the approved file.', { expandPromptTemplates: false });
      const pending = await attention;
      expect(pending.metadata.status).toBe('needs-attention');
      expect((await journal.read('call-write'))?.metadata.status).toBe('needs-attention');
      await expect(fs.stat(path.join(root, 'approved.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await gate.approve('call-write', pending);
      await run;
      expect(await fs.readFile(path.join(root, 'approved.txt'), 'utf8')).toBe('Approved bytes.');
      expect((await journal.read('call-write'))?.metadata.status).toBe('consumed');
      await expect(gate.approve('call-write', pending)).rejects.toThrow(/No matching/);
      expect(turns).toBe(2);
    } finally {
      await session.abort();
      session.dispose();
    }
  });

  it('proves ordinary root Read only is not a background effect boundary', () => {
    const enabled = activeToolsForPermission(['write', 'edit', 'bash', 'browser_click', 'third_party_effect'], 'read-only');
    expect(enabled).toContain('browser_click');
    expect(enabled).toContain('third_party_effect');
    expect(enabled).toContain('generate_image');
    expect(enabled).not.toContain('write');
  });
});
