import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentChannels } from '../shared/contracts/agents';
const electron = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: electron }));
import { agentsApi } from './agentsApi';

beforeEach(() => { electron.invoke.mockReset(); electron.on.mockReset(); electron.removeListener.mockReset(); });
describe('named Agents preload bridge', () => {
  it('rejects malformed IDs and injected project paths before IPC', async () => {
    await expect(agentsApi.openAgentConversation({ agentId: '../escape', mode: 'home' })).rejects.toThrow();
    await expect(agentsApi.getAgentLibrary({ projectPath: '/other' } as never)).rejects.toThrow();
    expect(electron.invoke).not.toHaveBeenCalled();
  });
  it('validates library responses and does not expose arbitrary IPC', async () => {
    const library = { agents: [], tasks: [], routines: [], states: [], runs: [], revisions: {}, nextDue: {}, diagnostics: [] };
    electron.invoke.mockResolvedValueOnce(library);
    expect(await agentsApi.getAgentLibrary()).toEqual(library);
    expect(electron.invoke).toHaveBeenCalledWith(agentChannels.agentsList, {});
    electron.invoke.mockResolvedValueOnce({ ...library, unexpected: 'not transported' });
    await expect(agentsApi.getAgentLibrary()).rejects.toThrow();
    expect(agentsApi).not.toHaveProperty('invoke');
  });
  it('filters malformed change events and releases listeners', () => {
    const listener = vi.fn();
    const unsubscribe = agentsApi.onAgentLibraryChanged(listener);
    const handler = electron.on.mock.calls[0]![1] as (event: unknown, value: unknown) => void;
    handler({}, { projectPath: '/project', runId: 'run', status: 'needs-attention' });
    handler({}, { projectPath: 1, status: 'execute-anything' });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(agentChannels.agentsChanged, handler);
  });
});
