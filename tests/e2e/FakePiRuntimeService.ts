import type { PiEvent, ProjectState, PromptAcceptance, PromptInput, RuntimeState, SessionSummary, ThinkingLevel } from '../../src/shared/contracts/ipc';

const model = { provider: 'test', id: 'deterministic', name: 'Deterministic Test Model', reasoning: true, contextWindow: 100_000, supportsImages: true };

export class FakePiRuntimeService {
  private project: ProjectState | null = null;
  private activeSession = 'e2e-session-1';
  private streaming = false;
  private sink: (events: PiEvent[]) => void = () => undefined;
  private readonly sessions: SessionSummary[] = [
    { id: 'e2e-session-1', title: 'First session', firstMessage: '', path: 'test://session-1', createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-02T00:00:00.000Z', messageCount: 0, active: true },
    { id: 'e2e-session-2', title: 'Second session', firstMessage: 'Second', path: 'test://session-2', createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-03T00:00:00.000Z', messageCount: 1, active: false },
  ];

  setEventSink(sink: (events: PiEvent[]) => void): void { this.sink = sink; }
  getState(): RuntimeState {
    return {
      status: this.project ? 'ready' : 'disconnected', project: this.project, sessionId: this.project ? this.activeSession : null,
      sessionFile: null, streaming: this.streaming, model: this.project ? model : null, models: this.project ? [model] : [],
      thinkingLevel: 'medium', messages: [], commands: [{ name: 'review', description: 'Review changes' }],
      sessions: this.sessions.map((session) => ({ ...session, active: session.id === this.activeSession })), branches: [],
      forkPoints: [], sessionCapabilities: { fork: true, clone: true, import: true, compact: true }, sessionOperation: false, error: null,
    };
  }
  async openProject(project: ProjectState): Promise<RuntimeState> { this.project = project; this.emitState(); return this.getState(); }
  async prompt(_input: PromptInput): Promise<PromptAcceptance> {
    const runId = 'e2e-run'; this.streaming = true;
    this.sink([{ type: 'run.accepted', runId, timestamp: 1 }, { type: 'run.started', runId, timestamp: 2 }, { type: 'message.started', messageId: 'user-e2e', role: 'user', timestamp: 3 }, { type: 'message.completed', messageId: 'user-e2e', role: 'user', text: 'Inspect this project', timestamp: 4 }]);
    setTimeout(() => this.sink([
      { type: 'message.started', messageId: 'assistant-e2e', role: 'assistant', timestamp: 5 },
      { type: 'assistant.text', messageId: 'assistant-e2e', delta: 'I inspected the project. ', timestamp: 6 },
      { type: 'tool.started', toolCallId: 'tool-e2e', name: 'read', input: '{"path":"src/example.ts"}', timestamp: 7 },
      { type: 'tool.updated', toolCallId: 'tool-e2e', output: 'Reading src/example.ts', timestamp: 8 },
      { type: 'tool.completed', toolCallId: 'tool-e2e', name: 'read', output: 'export const answer = 42;', error: false, timestamp: 9 },
      { type: 'assistant.text', messageId: 'assistant-e2e', delta: 'Everything is ready.', timestamp: 10 },
      { type: 'message.completed', messageId: 'assistant-e2e', role: 'assistant', text: 'I inspected the project. Everything is ready.', timestamp: 11 },
      { type: 'run.completed', runId, aborted: false, timestamp: 12 },
    ]), 20);
    setTimeout(() => { this.streaming = false; this.emitState(); }, 25);
    return { accepted: true, runId };
  }
  async abort(): Promise<{ aborted: boolean }> { const aborted = this.streaming; this.streaming = false; this.emitState(); return { aborted }; }
  async setModel(): Promise<RuntimeState> { return this.getState(); }
  setThinkingLevel(_level: ThinkingLevel): RuntimeState { return this.getState(); }
  async newSession(): Promise<RuntimeState> { this.activeSession = 'e2e-session-1'; this.emitState(); return this.getState(); }
  async listSessions(query = ''): Promise<SessionSummary[]> { return this.getState().sessions!.filter((session) => session.title.toLowerCase().includes(query.toLowerCase())); }
  async switchSession(sessionId: string): Promise<RuntimeState> { this.activeSession = sessionId; this.emitState(); return this.getState(); }
  async forkSession(): Promise<RuntimeState> { return this.getState(); }
  async cloneSession(): Promise<RuntimeState> { return this.getState(); }
  async importSession(): Promise<RuntimeState> { return this.getState(); }
  async compact(): Promise<RuntimeState> { return this.getState(); }
  async dispose(): Promise<void> {}
  private emitState(): void { this.sink([{ type: 'state.changed', state: { ...this.getState(), messages: [] }, messagesIncluded: false, timestamp: Date.now() }]); }
}
