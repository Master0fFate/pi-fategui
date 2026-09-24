import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition, AgentLibrary } from '../../../shared/contracts/agents';
import { SkinProvider } from '../../skins/SkinProvider';
import { useAgentsStore, emptyAgentLibrary } from '../../stores/agentsStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { SidebarAgents } from './SidebarAgents';

const agentId = 'a392d8b9-76cc-4158-a381-1151ccf818fb';
const taskId = 'b392d8b9-76cc-4158-a381-1151ccf818fb';
const agent: AgentDefinition = { schemaVersion: 1, id: agentId, name: 'Reviewer', scope: 'project', projectPath: '/project', description: 'Careful review', instructions: 'System persona', skillRefs: [], defaults: { model: null, permission: 'read-only', thinkingLevel: 'high', workspace: 'shared' }, enabled: true, deleted: false, revision: 1, createdAt: 1, updatedAt: 1 };
let library: AgentLibrary;
let api: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  library = emptyAgentLibrary();
  useAgentsStore.getState().reset();
  useRuntimeStore.setState({ runtime: { ...useRuntimeStore.getState().runtime, status: 'ready', project: { path: '/project', name: 'project', trusted: true }, permissionLevel: 'read-only', models: [] } });
  api = {
    getAgentLibrary: vi.fn(async () => structuredClone(library)),
    saveAgentDefinition: vi.fn(async (input) => { const item = { ...agent, ...input.value, revision: input.id ? 2 : 1 }; library.agents = [item]; library.revisions[`agent:${agentId}`] = { revision: item.revision, digest: 'a'.repeat(64) }; return item; }),
    saveTaskTemplate: vi.fn(), saveRoutineDefinition: vi.fn(), deleteAgentLibraryItem: vi.fn(async () => undefined),
    openAgentConversation: vi.fn(async () => ({ sessionId: 'home', appliedRevision: 1 })),
    getRuntimeState: vi.fn(async () => useRuntimeStore.getState().runtime), runAgentTask: vi.fn(async () => ({ id: 'manual:run' })),
    decideAgentApproval: vi.fn(async () => undefined), cancelAgentRun: vi.fn(),
    listLegacyAutomations: vi.fn(async () => []),
  };
  Object.defineProperty(window, 'piDesktop', { configurable: true, value: api });
});
const mount = (skin = 'default') => { document.documentElement.dataset.skin = skin; return render(<SkinProvider><SidebarAgents /></SkinProvider>); };
const menuFor = async (name: string) => { fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` })); return await screen.findByRole('menu', { name: `Actions for ${name}` }); };

 describe('Agents feature-owned UI', () => {
  it.each(['default', 'dreamcore', 'm3-expressive'])('keeps every library section reachable through compact themed navigation under %s', async (skin) => {
    mount(skin);
    const navigation = await screen.findByRole('navigation', { name: 'Agents sections' });
    expect(within(navigation).getAllByRole('button')).toHaveLength(5);
    for (const label of ['Agents', 'TaskTemplates', 'Routines', 'Run history', 'Copy Automations']) expect(within(navigation).getByRole('button', { name: label })).toHaveAttribute('title', label);
    expect(navigation.querySelectorAll('.agent-library-nav-symbol')).toHaveLength(5);
    expect([...navigation.querySelectorAll('.agent-library-nav-label')].map((label) => label.textContent)).toEqual(['Agents', 'Tasks', 'Routine', 'Runs', 'Import']);
  });

  it.each(['default', 'dreamcore', 'm3-expressive'])('uses the shared sidebar search and icon action across %s views', async (skin) => {
    mount(skin);
    const toolbar = await screen.findByRole('region', { name: 'Agents library' });
    expect(toolbar.querySelector('.sidebar-tab-toolbar .sidebar-search')).toContainElement(screen.getByRole('searchbox', { name: 'Search Agents library' }));
    const newAction = toolbar.querySelector('.sidebar-toolbar-action--primary');
    expect(newAction).toContainElement(screen.getByRole('button', { name: 'New Agent' }));
    expect(screen.getByRole('button', { name: 'New Agent' })).not.toHaveTextContent('New');
    fireEvent.click(screen.getByRole('button', { name: 'TaskTemplates' }));
    expect(newAction).toContainElement(screen.getByRole('button', { name: 'New TaskTemplate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Routines' }));
    expect(newAction).toContainElement(screen.getByRole('button', { name: 'New Routine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run history' }));
    expect(toolbar.querySelector('.sidebar-toolbar-action--primary')).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Search Agents library' })).toBeInTheDocument();
  });

  it.each(['default', 'dreamcore', 'm3-expressive'])('creates and renames through the same editor under %s', async (skin) => {
    mount(skin);
    await screen.findByText(/No saved Agents/);
    fireEvent.click(screen.getByRole('button', { name: 'New Agent' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: 'Agent model' })).toHaveTextContent('Use current session model');
    fireEvent.change(within(dialog).getByLabelText('Agent name'), { target: { value: 'Reviewer' } });
    fireEvent.change(within(dialog).getByLabelText('Agent instructions'), { target: { value: 'System persona' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Agent' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.saveAgentDefinition).toHaveBeenCalledWith(expect.objectContaining({ expected: null, value: expect.objectContaining({ name: 'Reviewer', instructions: 'System persona', scope: 'project' }) }));
    fireEvent.click(within(await menuFor('Reviewer')).getByRole('menuitem', { name: 'Edit Reviewer' }));
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Agent' }));
    await screen.findByRole('article', { name: 'Agent Renamed' });
    expect(api.saveAgentDefinition).toHaveBeenLastCalledWith(expect.objectContaining({ id: agentId, expected: { revision: 1, digest: 'a'.repeat(64) } }));
  });

  it('retains unsaved content on conflict and confirms before discarding', async () => {
    api.saveAgentDefinition!.mockRejectedValue(new Error('Definition conflict. Reload before saving.'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New Agent' }));
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Unsaved' } });
    fireEvent.change(screen.getByLabelText('Agent instructions'), { target: { value: 'Keep these instructions' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Agent' }));
    await screen.findByText('Definition conflict. Reload before saving.', { selector: 'pre' });
    expect(screen.getByLabelText('Agent instructions')).toHaveValue('Keep these instructions');
    fireEvent.click(screen.getByRole('button', { name: 'Close Agent editor' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Agent instructions')).toHaveValue('Keep these instructions');
  });

  it('displays corrupt diagnostics, disabled states and historical home revision without opening implicitly', async () => {
    library.agents = [{ ...agent, enabled: false, revision: 3 }];
    library.states = [{ schemaVersion: 1, agentId, revision: 1, homeSessionId: 'home', homeProjectPath: '/project', appliedRevision: 1, lastOpenedAt: 1, lastRunAt: null }];
    library.diagnostics = ['Malformed external definition preserved.'];
    mount();
    await screen.findByText('Malformed external definition preserved.');
    expect(screen.getByRole('button', { name: 'Open home conversation' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start Session' })).toBeDisabled();
    expect(screen.getByText(/older instructions retained/)).toBeInTheDocument();
    expect(api.openAgentConversation).not.toHaveBeenCalled();
  });

  it('loads legacy Automations and copies the selected item into a TaskTemplate', async () => {
    const legacy = { sourceId: '00000000-0000-4000-8000-000000000001', sourceDigest: 'a'.repeat(64), name: 'Legacy review', prompt: 'Review old prompt.', permissionCeiling: 'read-only' as const, archivedFields: ['launchCount'], existingTaskId: null };
    api.listLegacyAutomations!.mockResolvedValue([legacy]);
    api.copyAutomationToTask = vi.fn(async () => ({ ...library.tasks[0], id: taskId, name: legacy.name, prompt: legacy.prompt, permissionCeiling: legacy.permissionCeiling, automationSource: null }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Automations' }));
    await screen.findByRole('article', { name: 'Legacy Automation Legacy review' });
    expect(api.listLegacyAutomations).toHaveBeenCalledWith({});
    fireEvent.click(screen.getByRole('button', { name: 'Import Legacy review' }));
    expect(screen.getByRole('dialog', { name: 'Copy Automation: Legacy review' })).toHaveTextContent('Review old prompt.');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm non-destructive copy' }));
    await waitFor(() => expect(api.copyAutomationToTask).toHaveBeenCalledWith({ automationId: legacy.sourceId, sourceDigest: legacy.sourceDigest }));
  });

  it('keeps explicit run confirmation and user/task content separate from persona', async () => {
    library.agents = [agent];
    library.tasks = [{ schemaVersion: 1, id: taskId, name: 'Audit', scope: 'project', projectPath: '/project', prompt: '/command @live ~saved\nUser payload', enabled: true, permissionCeiling: 'edit', revision: 1, createdAt: 1, updatedAt: 1, deleted: false, automationSource: null }];
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Run task' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Read only');
    expect(within(dialog).getByLabelText('Run task payload')).toHaveValue(library.tasks[0]!.prompt);
    expect(api.runAgentTask).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm run' }));
    await waitFor(() => expect(api.runAgentTask).toHaveBeenCalledWith({ agentId, taskTemplateId: taskId }));
  });

  it('shows the Routine permission ceiling in the run confirmation', async () => {
    library.agents = [{ ...agent, defaults: { ...agent.defaults, permission: 'edit' } }];
    library.tasks = [{ schemaVersion: 1, id: taskId, name: 'Audit', scope: 'project', projectPath: '/project', prompt: 'Review', enabled: true, permissionCeiling: 'edit', revision: 1, createdAt: 1, updatedAt: 1, deleted: false, automationSource: null }];
    library.routines = [{ schemaVersion: 1, id: 'c392d8b9-76cc-4158-a381-1151ccf818fb', name: 'Daily review', agentId, taskTemplateId: taskId, intervalMinutes: 60, timeZone: 'UTC', enabled: true, permissionCeiling: 'read-only', notify: true, osNotify: false, projectPath: '/project', revision: 1, createdAt: 1, updatedAt: 1, deleted: false }];
    useRuntimeStore.setState({ runtime: { ...useRuntimeStore.getState().runtime, permissionLevel: 'edit' } });
    mount();
    fireEvent.click(await screen.findByRole('combobox', { name: 'Filter definition scope' }));
    fireEvent.click(await screen.findByRole('option', { name: 'All trusted projects' }));
    fireEvent.click(screen.getByRole('button', { name: 'Routines' }));
    expect(screen.getByRole('article', { name: 'Routine Daily review' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Filter definition scope' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test run' }));
    expect(screen.getByRole('dialog', { name: 'Confirm Agent task run' })).toHaveTextContent('Effective file access: Read only');
  });

  it('requires an explicit exact-action review before approval', async () => {
    library.runs = [{ schemaVersion: 1, id: 'manual:run', agentId, agentRevision: 1, taskTemplateId: taskId, taskTemplateRevision: 1, routineId: null, routineRevision: null, projectPath: '/project', scheduledFor: 1, startedAt: 1, finishedAt: null, status: 'needs-attention', sessionId: 'run-session', resultSummary: '', error: null, inputs: {}, permission: 'edit', approvals: [{ id: 'approval', digest: 'a'.repeat(64), revision: 1, action: '{"tool":"write","input":{"path":"file","content":"exact"}}', expiresAt: Date.now() + 300_000, status: 'pending' }] }];
    useAgentsStore.setState({ view: 'history' });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review action' }));
    expect(screen.getByRole('button', { name: 'Approve action' })).toBeDisabled();
    expect(screen.getByLabelText('Exact proposed action')).toHaveTextContent('"content":"exact"');
    fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed the exact action and project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve action' }));
    await waitFor(() => expect(api.decideAgentApproval).toHaveBeenCalledWith({ runId: 'manual:run', approvalId: 'approval', approved: true, expected: { revision: 1, digest: 'a'.repeat(64) } }));
  });

  it('requires destructive confirmation and never loads an untrusted project', async () => {
    library.agents = [agent];
    library.revisions[`agent:${agent.id}`] = { revision: 1, digest: 'a'.repeat(64) };
    const view = mount();
    fireEvent.click(within(await menuFor('Reviewer')).getByRole('menuitem', { name: 'Delete Reviewer' }));
    expect(api.deleteAgentLibraryItem).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Saved conversations');
    fireEvent.click(screen.getByRole('button', { name: 'Delete definition' }));
    await waitFor(() => expect(api.deleteAgentLibraryItem).toHaveBeenCalledOnce());
    view.unmount();
    api.getAgentLibrary!.mockClear();
    useRuntimeStore.setState({ runtime: { ...useRuntimeStore.getState().runtime, project: { path: '/untrusted', name: 'untrusted', trusted: false } } });
    mount();
    expect(screen.getByText(/Open and trust a project/)).toBeInTheDocument();
    expect(api.getAgentLibrary).not.toHaveBeenCalled();
  });
});
