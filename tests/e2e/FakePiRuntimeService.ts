import type { PermissionLevel, PiEvent, ProjectState, PromptAcceptance, PromptInput, QueuedMessage, QueueMutationInput, QueueMutationResult, RuntimeState, SessionSummary, ThinkingLevel } from '../../src/shared/contracts/ipc';

const model = { provider: 'test', id: 'deterministic', name: 'Deterministic Test Model', reasoning: true, contextWindow: 100_000, supportsImages: true };

export class FakePiRuntimeService {
  private project: ProjectState | null = null;
  private activeSession = 'e2e-session-1';
  private streaming = false;
  private permissionLevel: PermissionLevel = 'full-access';
  private queuedMessages: QueuedMessage[] = [];
  private queueSequence = 0;
  private readonly sessionPermissions = new Map<string, PermissionLevel>();
  private sink: (events: PiEvent[]) => void = () => undefined;
  private readonly sessions: SessionSummary[] = [
    { id: 'e2e-session-1', title: 'First session', firstMessage: '', path: 'test://session-1', createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-02T00:00:00.000Z', messageCount: 0, active: true },
    { id: 'e2e-session-2', title: 'Second session', firstMessage: 'Second', path: 'test://session-2', createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-03T00:00:00.000Z', messageCount: 1, active: false },
  ];

  setEventSink(sink: (events: PiEvent[]) => void): void { this.sink = sink; }
  getHydrationState(): RuntimeState { return this.getState(); }
  getState(): RuntimeState {
    const historical = this.activeSession === 'e2e-session-2';
    return {
      status: this.project ? 'ready' : 'disconnected', project: this.project, sessionId: this.project ? this.activeSession : null,
      sessionFile: null, streaming: this.streaming, model: this.project ? model : null, models: this.project ? [model] : [],
      thinkingLevel: 'medium', permissionLevel: this.permissionLevel,
      messages: historical ? [{ id: 'history-assistant', role: 'assistant', text: '**Second session** history', timestamp: 1, timelinePosition: 0 }] : [],
      tools: historical ? [{ id: 'history-tool', name: 'read', input: '{"path":"README.md"}', output: 'historical output', outputTruncated: false, status: 'succeeded', startedAt: 2, updatedAt: 3, endedAt: 3, timelinePosition: 0.5 }] : [],
      commands: [
        { name: 'parallax', description: 'Control the Parallax engineering protocol', source: 'extension' },
        { name: 'skill:vibesecurity', description: 'Defensive, evidence-first security review', source: 'skill' },
        { name: 'review', description: 'Review changes', source: 'prompt' },
      ],
      objective: 'Review the deliberately long session objective without allowing it to collide with the Objective label in the narrow inspector.',
      contextUsage: { tokens: 42_000, contextWindow: 100_000, percent: 42 },
      queue: {
        steering: this.queuedMessages.filter((item) => item.behavior === 'steer').length,
        followUp: this.queuedMessages.filter((item) => item.behavior === 'followUp').length,
        items: this.queuedMessages.map((item) => ({ ...item, ...(item.images ? { images: item.images.map((image) => ({ ...image })) } : {}) })),
      },
      sessions: this.sessions.map((session) => ({ ...session, active: session.id === this.activeSession })), branches: [],
      forkPoints: [], sessionCapabilities: { fork: true, clone: true, import: true, compact: true }, sessionOperation: false, error: null,
    };
  }
  async openProject(project: ProjectState): Promise<RuntimeState> { this.project = project; this.emitState(); return this.getState(); }
  async prompt(input: PromptInput): Promise<PromptAcceptance> {
    const runId = 'e2e-run';
    if (this.streaming && input.behavior !== 'prompt') {
      this.queueSequence += 1;
      this.queuedMessages.push({
        id: `00000000-0000-4000-8000-${String(this.queueSequence).padStart(12, '0')}`,
        behavior: input.behavior,
        text: input.text,
        ...(input.images?.length ? { images: input.images.map((image) => ({ ...image })) } : {}),
        createdAt: Date.now(),
      });
      this.sink([{ type: 'run.accepted', runId, timestamp: Date.now() }]);
      this.emitState();
      return { accepted: true, runId };
    }
    if (input.text.startsWith('/parallax')) {
      this.sink([
        { type: 'run.accepted', runId, timestamp: 1 },
        { type: 'message.completed', messageId: 'system-parallax', role: 'system', text: '**Parallax** is active.', timestamp: 2 },
      ]);
      return { accepted: true, runId };
    }
    this.streaming = true;
    this.sink([{ type: 'run.accepted', runId, timestamp: 1 }, { type: 'run.started', runId, timestamp: 2 }, { type: 'message.started', messageId: 'user-e2e', role: 'user', timestamp: 3 }, { type: 'message.completed', messageId: 'user-e2e', role: 'user', text: 'Inspect this project', timestamp: 4 }]);
    setTimeout(() => this.sink([
      { type: 'message.started', messageId: 'assistant-e2e', role: 'assistant', timestamp: 5 },
      { type: 'assistant.text', messageId: 'assistant-e2e', delta: 'I inspected the project. ', timestamp: 6 },
      { type: 'tool.started', toolCallId: 'tool-e2e', name: 'read', input: '{"path":"src/example.ts"}', timestamp: 7 },
      { type: 'tool.updated', toolCallId: 'tool-e2e', output: 'Reading src/example.ts', timestamp: 8 },
      { type: 'tool.completed', toolCallId: 'tool-e2e', name: 'read', output: 'export const answer = 42;', error: false, timestamp: 9 },
      { type: 'assistant.text', messageId: 'assistant-e2e', delta: 'Everything is ready.\n\n![Project preview](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)\n\n```mermaid\nflowchart LR\n  Project --> Ready\n```', timestamp: 10 },
      { type: 'message.completed', messageId: 'assistant-e2e', role: 'assistant', text: 'I inspected the project. Everything is ready.\n\n![Project preview](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)\n\n```mermaid\nflowchart LR\n  Project --> Ready\n```', timestamp: 11 },
      { type: 'run.completed', runId, aborted: false, timestamp: 12 },
    ]), 1_200);
    setTimeout(() => { this.streaming = false; this.emitState(); }, 1_210);
    return { accepted: true, runId };
  }
  async abort(): Promise<{ aborted: boolean }> { const aborted = this.streaming; this.streaming = false; this.emitState(); return { aborted }; }
  async setModel(): Promise<RuntimeState> { return this.getState(); }
  setThinkingLevel(_level: ThinkingLevel): RuntimeState { return this.getState(); }
  async setPermissionLevel(level: PermissionLevel): Promise<RuntimeState> { this.permissionLevel = level; this.sessionPermissions.set(this.activeSession, level); this.emitState(); return this.getState(); }
  async mutateQueuedMessage(input: QueueMutationInput): Promise<QueueMutationResult> {
    const target = this.queuedMessages.find((item) => item.id === input.id);
    if (!target) throw new Error('That queued message is no longer waiting.');
    if (input.action === 'cancel' || input.action === 'edit') {
      this.queuedMessages = this.queuedMessages.filter((item) => item.id !== input.id);
    } else {
      const behavior: QueuedMessage['behavior'] = input.action;
      this.queuedMessages = this.queuedMessages.map((item) => item.id === input.id ? { ...item, behavior } : item);
    }
    this.emitState();
    return {
      state: this.getState(),
      ...(input.action === 'edit' ? { restored: { text: target.text, ...(target.images?.length ? { images: target.images.map((image) => ({ ...image })) } : {}) } } : {}),
    };
  }
  async newSession(): Promise<RuntimeState> { this.activeSession = 'e2e-session-1'; this.queuedMessages = []; this.permissionLevel = this.sessionPermissions.get(this.activeSession) ?? 'full-access'; this.emitState(); return this.getState(); }
  async listSessions(query = ''): Promise<SessionSummary[]> { return this.getState().sessions!.filter((session) => session.title.toLowerCase().includes(query.toLowerCase())); }
  async switchSession(sessionId: string): Promise<RuntimeState> { this.activeSession = sessionId; this.queuedMessages = []; this.permissionLevel = this.sessionPermissions.get(sessionId) ?? 'full-access'; this.emitState(true); return this.getState(); }
  async renameSession(): Promise<RuntimeState> { return this.getState(); }
  async deleteSession(sessionId: string): Promise<RuntimeState> {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index >= 0 && sessionId !== this.activeSession) this.sessions.splice(index, 1);
    this.sessionPermissions.delete(sessionId);
    this.emitState();
    return this.getState();
  }
  async forkSession(): Promise<{ state: RuntimeState; selectedText?: string }> { return { state: this.getState(), selectedText: 'Forked prompt' }; }
  async cloneSession(): Promise<RuntimeState> { return this.getState(); }
  async importSession(): Promise<RuntimeState> { return this.getState(); }
  async compact(): Promise<RuntimeState> { return this.getState(); }
  async dispose(): Promise<void> {}
  private emitState(messagesIncluded = false): void {
    const state = this.getState();
    this.sink([{ type: 'state.changed', state: messagesIncluded ? state : { ...state, messages: [], tools: [] }, messagesIncluded, timestamp: Date.now() }]);
  }
}
