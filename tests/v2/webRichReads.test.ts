import { describe, expect, it, vi } from 'vitest';
import { WebFateApi, type WebSnapshot, type WebWorkspace } from '../../src/client/WebFateApi';
import { requestEnvelopeSchema, responseEnvelopeSchema, type WireRequest } from '../../src/shared/protocol/envelopes';

const epoch = '10000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000002';
const scope: WebWorkspace = { workspaceId: '30000000-0000-4000-8000-000000000003', workspaceGeneration: 2, label: 'Host' };
const snapshot: WebSnapshot['header'] = {
  version: 1, snapshotId: '40000000-0000-4000-8000-000000000004', workspaceId: scope.workspaceId,
  workspaceGeneration: scope.workspaceGeneration, sessionId, selectionRevision: 8,
  capturedAt: Date.now(), expiresAt: Date.now() + 60_000, serverEpoch: epoch,
  eventCursor: 0, pageIds: [], controls: { status: 'ready', streaming: false, activeSessionRunning: false,
    runningSessionCount: 0, permissionLevel: 'read-only', thinkingLevel: 'medium', model: null, pendingModel: null,
    pendingThinkingLevel: null, sessionOperation: false, queue: { steering: 0, followUp: 0, pending: 0, held: 0, recovered: 0 } },
  goal: null, taskRevision: null, tasks: [], agents: [], omissions: { history: false, media: false, clippedItems: 0,
    agentRows: false, taskRows: false, goalText: false, taskText: false, agentText: false, queueContents: false }, warnings: [],
};
const results = {
  'goal.get': { sessionId, selectionRevision: 8, goal: null },
  'task.list': { sessionId, selectionRevision: 8, list: null },
  'git.status': { repository: true, branch: 'main', ahead: 0, behind: 0, changes: [], additions: 0, deletions: 0, truncated: false },
  'git.history': { head: null, commits: [], truncated: false },
  'session.list': { sessionId, selectionRevision: 8, sessions: [] },
  'runtime.models': { sessionId, selectionRevision: 8, models: [{ provider: 'fake', id: 'model', name: 'Fake', reasoning: false, contextWindow: 1000 }] },
  'runtime.queueRead': { sessionId, selectionRevision: 8, items: [], held: [], recovered: [] },
  'team.read': { sessionId, selectionRevision: 8, teams: [], truncated: false },
  'agent.read': { sessionId, selectionRevision: 8, agents: [], truncated: false },
  'git.diff': { path: 'src/file.ts', state: 'text', original: 'old', modified: 'new', language: 'typescript', mediaOmitted: false },
  'git.combinedDiff': { patch: 'bounded patch', truncated: false },
  'workspace.monitorDetail': { sessionId, selectionRevision: 8, id: '1'.repeat(32), kind: 'run', state: 'attention', updatedAt: 1,
    title: 'Run', detail: 'Provider text remains private.', redacted: true },
  'text.upload': { attachmentId: `ta1_${'a'.repeat(43)}`, byteLength: 2, expiresAt: Date.now() + 60_000 },
  'text.cancel': { canceled: true },

};
function fixture() {
  const command = vi.fn(async (request: WireRequest) => ({ protocol: 1 as const, ok: true as const,
    requestId: request.requestId, serverEpoch: epoch, scope: { workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration },
    method: request.method, result: results[request.method as keyof typeof results] }));
  const web = new WebFateApi('http://127.0.0.1:49301', { sessionId, expiresAt: Date.now() + 60_000,
    csrfToken: `fx1_${'a'.repeat(43)}` }, { makeEvents: () => ({ connection: { ticket: 'host-ticket', serverEpoch: epoch } as never,
      connect: async () => ({ ticket: 'host-ticket', serverEpoch: epoch }) as never,
      subscribe: async () => { throw new Error('not used'); }, close: () => undefined }) });
  Object.assign(web, { connected: true, epoch, selected: scope, selectedSnapshot: snapshot,
    capabilities: new Set(['goal.read', 'task.read', 'git.read', 'session.read', 'runtime.configure', 'queue.read', 'agent.read', 'workspace.monitor', 'text.context']), commands: { command } });
  return { web, command };
}

describe('T39 browser typed rich reads', () => {
  it('sends only selected session/revision in four named bounded envelopes and accepts actual null as null', async () => {
    const { web, command } = fixture();
    expect((await web.readGoal(scope)).goal).toBeNull();
    expect((await web.readTasks(scope)).list).toBeNull();
    expect((await web.readGitStatus(scope)).branch).toBe('main');
    expect((await web.readGitHistory(scope)).commits).toEqual([]);
    const originalRequests = command.mock.calls.slice();
    expect(originalRequests.map(([request]) => request.method)).toEqual(['goal.get', 'task.list', 'git.status', 'git.history']);
    for (const [request] of originalRequests) {
      expect(requestEnvelopeSchema.safeParse(request).success).toBe(true);
      expect(responseEnvelopeSchema.safeParse(await command(request)).success).toBe(true);
      expect(request).toMatchObject({ workspaceId: scope.workspaceId, workspaceGeneration: 2,
        expectedSessionId: sessionId, selectionRevision: 8, input: {} });
      expect(JSON.stringify(request)).not.toContain('projectPath');
    }
    web.close();
  });

  it('provides named session/model/queue/Team/Git/detail reads under the same current host snapshot', async () => {
    const { web, command } = fixture();
    expect((await web.readSessions(scope)).sessions).toEqual([]);
    expect((await web.readModels(scope)).models[0]?.provider).toBe('fake');
    expect((await web.readQueue(scope)).recovered).toEqual([]);
    expect((await web.readTeams(scope)).teams).toEqual([]);
    expect((await web.readAgents(scope)).agents).toEqual([]);
    expect((await web.readGitDiff(scope, 'src/file.ts')).modified).toBe('new');
    expect((await web.readGitCombinedDiff(scope)).patch).toBe('bounded patch');
    expect((await web.readMonitorDetail(scope, '1'.repeat(32))).redacted).toBe(true);
    for (const [request] of command.mock.calls.slice()) expect(requestEnvelopeSchema.safeParse(request).success).toBe(true);
    const count = command.mock.calls.length;
    await expect(web.readGitDiff(scope, '/private/file')).rejects.toThrow();
    await expect(web.readGitDiff(scope, '../file')).rejects.toThrow();
    await expect(web.readGitDiff(scope, 'C:\\secret')).rejects.toThrow();
    expect(command).toHaveBeenCalledTimes(count);
    web.close();
  });
  it('encodes strict UTF-8 text without sending local paths and explicitly cancels the original opaque attachment', async () => {
    const { web, command } = fixture();
    const receipt = await web.uploadText(scope, { name: 'notes.txt', text: 'é' });
    expect(receipt.attachmentId).toMatch(/^ta1_/u);
    const upload = command.mock.calls[0]![0];
    expect(upload).toMatchObject({ method: 'text.upload', expectedSessionId: sessionId, selectionRevision: 8,
      input: { name: 'notes.txt', contentType: 'text/plain', encoding: 'base64', data: 'w6k=' } });
    expect(requestEnvelopeSchema.safeParse(upload).success).toBe(true);
    await web.cancelTextAttachment(scope, receipt.attachmentId);
    expect(command.mock.calls[1]![0]).toMatchObject({ method: 'text.cancel', input: { attachmentId: receipt.attachmentId } });
    await expect(web.uploadText(scope, { name: 'C:\\private.txt', text: 'text' })).rejects.toThrow();
    await expect(web.uploadText(scope, { name: 'notes.txt', text: '\ud800' })).rejects.toThrow();
    await expect(web.uploadText(scope, { name: 'notes.txt', text: '😀'.repeat(65_537) })).rejects.toThrow();
    expect(command).toHaveBeenCalledTimes(2);
    web.close();
  });

  it('keeps an assembled acknowledged live view readable after the page transaction TTL ends', async () => {
    const f = fixture();
    Object.assign(f.web, { selectedSnapshot: { ...snapshot, expiresAt: 1 } });
    expect((await f.web.readModels(scope)).models[0]?.id).toBe('model');
    expect(f.command).toHaveBeenCalledOnce();
    f.web.close();
  });

  it('rejects stale selection, changed result session, foreign workspace, and a read without a snapshot', async () => {
    const f = fixture();
    let finish!: (value: Awaited<ReturnType<typeof f.command>>) => void;
    f.command.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.web.readGoal(scope);
    Object.assign(f.web, { selectedSnapshot: { ...snapshot, selectionRevision: 10 } });
    finish({ protocol: 1, ok: true, requestId: '50000000-0000-4000-8000-000000000005', serverEpoch: epoch,
      scope: { workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration }, method: 'goal.get', result: results['goal.get'] });
    await expect(pending).rejects.toThrow('Selected session changed');
    Object.assign(f.web, { selectedSnapshot: snapshot });
    f.command.mockImplementationOnce(async (request) => ({ protocol: 1, ok: true,
      requestId: request.requestId, serverEpoch: epoch, scope: { workspaceId: scope.workspaceId, workspaceGeneration: 2 },
      method: 'goal.get', result: { sessionId: '90000000-0000-4000-8000-000000000009', selectionRevision: 8, goal: null } }));
    await expect(f.web.readGoal(scope)).rejects.toThrow('Selected session changed');
    await expect(f.web.readGitStatus({ ...scope, workspaceGeneration: 3 })).rejects.toThrow('Select the registered workspace');
    Object.assign(f.web, { selectedSnapshot: null });
    await expect(f.web.readTasks(scope)).rejects.toThrow('current selected session snapshot');
    f.web.close();
  });
});
