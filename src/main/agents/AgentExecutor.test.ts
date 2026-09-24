import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultPackageManager, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { AgentRepository } from './AgentRepository';
import { ApprovalGate } from './ApprovalGate';
import { createAgentExecution } from './AgentExecutor';
import { HomeOwnership } from './HomeOwnership';
import type { SavedAgentSession } from '../../shared/contracts/agents';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
describe('restricted production Agent executor', () => {
  it('cannot install configured packages or autoload extension/context files while constructing a background run', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agents-executor-')));
    roots.push(root);
    const projectPath = path.join(root, 'project');
    await fs.mkdir(path.join(projectPath, '.pi'), { recursive: true });
    await fs.writeFile(path.join(projectPath, '.pi', 'SYSTEM.md'), 'UNAPPROVED_SYSTEM_FILE');
    await fs.writeFile(path.join(projectPath, 'AGENTS.md'), 'UNAPPROVED_CONTEXT_DISCOVERY');
    const source = SettingsManager.inMemory({ packages: ['npm:unattended-install-must-not-run'], extensions: ['/unapproved-extension.js'] });
    vi.spyOn(SettingsManager, 'create').mockReturnValue(source);
    const memory = vi.spyOn(SettingsManager, 'inMemory');
    // Tripwire prevents network/process effects even if package suppression regresses.
    const install = vi.spyOn(DefaultPackageManager.prototype as unknown as { installParsedSource(...args: unknown[]): Promise<void> }, 'installParsedSource').mockRejectedValue(new Error('Unattended installation is forbidden.'));
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: null, modelsStorePath: path.join(root, 'models-store.json'), allowModelNetwork: false });
    await modelRuntime.setRuntimeApiKey('anthropic', 'local-test-no-provider-requests');
    const preset: SavedAgentSession = { schemaVersion: 1, agentId: 'a392d8b9-76cc-4158-a381-1151ccf818fb', revision: 1, name: 'Safe', instructions: 'Canonical Agent persona.', skillRefs: [], defaults: { model: { provider: 'anthropic', id: 'claude-sonnet-4-5' }, permission: 'edit', thinkingLevel: 'high', workspace: 'shared' }, background: true, runId: 'manual:test', projectPath };
    const home = await new HomeOwnership(path.join(root, 'sessions')).open({ agentId: preset.agentId, revision: 1, instructions: preset.instructions, projectPath, preset });
    const context = () => ({ trusted: true, permission: 'edit' as const, binding: { runId: 'manual:test', definitionRevision: 1, taskRevision: 1, permissionRevision: 0, projectPath } });
    const repository = new AgentRepository(path.join(root, 'data'));
    const session = await createAgentExecution({ preset, sessionFile: home.file, modelRuntime, context, approvals: new ApprovalGate(repository.approvalJournal(projectPath), context, () => undefined), contextPrompts: ['Approved bounded project context.'] });
    try {
      expect(memory).toHaveBeenCalledWith(expect.objectContaining({ packages: [], extensions: [], skills: [], prompts: [], themes: [] }));
      expect(install).not.toHaveBeenCalled();
      expect(session.getActiveToolNames().sort()).toEqual(['edit', 'find', 'grep', 'ls', 'read', 'write']);
      expect(session.resourceLoader.getExtensions().extensions).toEqual([]);
      expect(session.agent.state.systemPrompt).toContain('Canonical Agent persona.');
      expect(session.agent.state.systemPrompt).toContain('Approved bounded project context.');
      expect(session.agent.state.systemPrompt).not.toContain('UNAPPROVED_SYSTEM_FILE');
      expect(session.agent.state.systemPrompt).not.toContain('UNAPPROVED_CONTEXT_DISCOVERY');
    } finally { session.dispose(); }
  });
});
