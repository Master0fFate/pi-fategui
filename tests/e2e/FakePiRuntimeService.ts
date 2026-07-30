import type { PermissionLevel, PiEvent, ProjectState, PromptAcceptance, PromptInput, QueuedMessage, QueueMutationInput, QueueMutationResult, RuntimeState, SessionSummary, SubagentControlInput, SubagentRun, ThinkingLevel } from '../../src/shared/contracts/ipc';

const model = { provider: 'test', id: 'deterministic', name: 'Deterministic Test Model', reasoning: true, contextWindow: 100_000, supportsImages: true };
const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function agentFixture(id: string, handle: string, displayName: string, task: string, status: SubagentRun['status'], mailbox: SubagentRun['mailbox']): SubagentRun {
  const now = Date.now();
  return {
    id, parentSessionId: 'e2e-session-1', parentToolCallId: 'e2e-agent-fixture', task, role: handle.includes('reviewer') ? 'reviewer' : 'runner',
    handle, displayName, agentName: 'direct', agentSource: 'direct', permissionLevel: 'read-only', enabledTools: ['read', 'grep'],
    skills: [], skillMode: 'all', preloadedSkills: [], status, model, routingModels: [model], thinkingLevel: 'medium', executionMode: 'managed',
    controlCount: 0, attempt: 1, maxAttempts: 1, mailbox, notification: 'never', dependsOn: [], createdAt: now - 4_000, updatedAt: now,
    ...(status === 'running' ? { startedAt: now - 3_500 } : { startedAt: now - 3_500, endedAt: now - 500 }),
    messages: status === 'running'
      ? [{ id: `${id}-task`, role: 'user', text: task, timestamp: now - 3_500 }]
      : [{ id: `${id}-result`, role: 'assistant', text: '**Checks passed.** The assigned task is complete.', timestamp: now - 500 }],
    tools: [], ...(status === 'completed' ? { result: 'Checks passed. The assigned task is complete.' } : {}),
    omittedActivity: 0, transcriptTruncated: false, usage: { ...emptyUsage, input: 180, output: 42, contextTokens: 222, turns: 1 },
  };
}

export class FakePiRuntimeService {
  private project: ProjectState | null = null;
  private activeSession = 'e2e-session-1';
  private streaming = false;
  private permissionLevel: PermissionLevel = 'full-access';
  private queuedMessages: QueuedMessage[] = [];
  private queueSequence = 0;
  private profileSequence = 0;
  private subagents: SubagentRun[] = [];
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
      sessionFile: null, streaming: this.streaming, activeSessionRunning: this.streaming, model: this.project ? model : null, models: this.project ? [model] : [],
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
      sessions: this.sessions.map((session) => ({ ...session, active: session.id === this.activeSession })),
      subagents: this.activeSession === 'e2e-session-1' ? this.subagents : [], branches: [],
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
    if (input.text === '__FATE_LIVE_PROFILE__') {
      this.runLiveProfile(runId);
      return { accepted: true, runId };
    }
    if (input.text === '__FATE_AGENT_FIXTURE__') {
      this.subagents = [
        agentFixture('e2e-auth-reviewer', 'auth-reviewer-1', 'Auth Reviewer', 'Review the authentication flow', 'running', { state: 'closed', ttlMs: 300_000, followUpCount: 0 }),
        agentFixture('e2e-test-runner', 'test-runner-1', 'Test Runner', 'Run the desktop regression suite', 'completed', { state: 'available', ttlMs: 300_000, expiresAt: Date.now() + 300_000, followUpCount: 0 }),
      ];
      const timestamp = Date.now();
      const runIds = this.subagents.map((run) => run.id);
      this.sink([
        { type: 'tool.started', toolCallId: 'e2e-agent-fixture', name: 'subagent_start', input: '{"tasks":["auth review","regression suite"]}', timestamp },
        ...this.subagents.map((run) => ({ type: 'subagent.started' as const, run, timestamp })),
        { type: 'tool.completed', toolCallId: 'e2e-agent-fixture', name: 'subagent_start', output: 'Started @auth-reviewer-1 and @test-runner-1.', subagentRunIds: runIds, error: false, timestamp: timestamp + 1 },
      ]);
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
  async controlSubagent(input: SubagentControlInput): Promise<RuntimeState> {
    const target = input.target.replace(/^@/u, '').toLocaleLowerCase();
    const indexes = target === 'all'
      ? this.subagents.map((_run, index) => index)
      : this.subagents.flatMap((run, index) => run.id === input.target || run.handle === target ? [index] : []);
    if (!indexes.length) throw new Error(`Unknown child target ${input.target}.`);
    const now = Date.now();
    for (const index of indexes) {
      const run = this.subagents[index]!;
      if (input.action === 'rename') this.subagents[index] = { ...run, displayName: input.displayName, updatedAt: now };
      else if (input.action === 'close') this.subagents[index] = { ...run, mailbox: { ...run.mailbox, state: 'closed', expiresAt: undefined }, updatedAt: now };
      else if (input.action === 'cancel') this.subagents[index] = { ...run, status: 'cancelled', mailbox: { ...run.mailbox, state: 'closed', expiresAt: undefined }, updatedAt: now, endedAt: now };
      else {
        const message = { id: `${run.id}-control-${now}`, role: input.action === 'steer' ? 'system' as const : 'user' as const, text: input.message, timestamp: now };
        this.subagents[index] = {
          ...run,
          status: input.action === 'followUp' ? 'completed' : run.status,
          controlCount: run.controlCount + 1,
          mailbox: input.action === 'followUp' ? { ...run.mailbox, state: 'available', expiresAt: now + run.mailbox.ttlMs, followUpCount: run.mailbox.followUpCount + 1 } : run.mailbox,
          messages: [...run.messages, message], updatedAt: now,
        };
      }
    }
    this.emitState();
    return this.getState();
  }
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

  private runLiveProfile(runId: string): void {
    const profileId = ++this.profileSequence;
    const prefix = `profile-${profileId}`;
    const historyCount = 600;
    const deltaCount = 6_000;
    const batchSize = 60;
    let historyIndex = 0;
    let deltaIndex = 0;
    let output = '';
    this.streaming = true;
    this.sink([{ type: 'run.accepted', runId, timestamp: Date.now() }]);

    const pump = () => {
      if (historyIndex < historyCount) {
        const events: PiEvent[] = [];
        while (events.length < 100 && historyIndex < historyCount) {
          events.push({
            type: 'message.completed',
            messageId: `${prefix}-history-${historyIndex}`,
            role: 'assistant',
            text: `Profile history row ${historyIndex}: completed output retained for virtualization and subscription pressure.`,
            timestamp: historyIndex + 1,
          });
          historyIndex += 1;
        }
        this.sink(events);
        setTimeout(pump, 0);
        return;
      }

      if (deltaIndex === 0) {
        this.sink([
          { type: 'run.started', runId, timestamp: 10_000 },
          { type: 'message.completed', messageId: `${prefix}-user`, role: 'user', text: 'Run the live renderer profile.', timestamp: 10_001 },
          { type: 'message.started', messageId: `${prefix}-assistant`, role: 'assistant', timestamp: 10_002 },
          { type: 'tool.started', toolCallId: `${prefix}-tool`, name: 'bash', input: '{"command":"profile live logs"}', timestamp: 10_003 },
        ]);
      }

      const events: PiEvent[] = [];
      while (events.length < batchSize && deltaIndex < deltaCount) {
        events.push({
          type: 'assistant.text',
          messageId: `${prefix}-assistant`,
          delta: `live-${String(deltaIndex).padStart(5, '0')} `,
          timestamp: 20_000 + deltaIndex,
        });
        if (deltaIndex % 10 === 0 && events.length < batchSize) {
          output = `${output}${'log-data '.repeat(16)}${deltaIndex}\n`.slice(-64_000);
          events.push({
            type: 'tool.updated',
            toolCallId: `${prefix}-tool`,
            output,
            timestamp: 20_000 + deltaIndex,
          });
        }
        deltaIndex += 1;
      }
      if (events.length > 0) this.sink(events);
      if (deltaIndex < deltaCount) {
        setTimeout(pump, 0);
        return;
      }

      const marker = `FATE_PROFILE_COMPLETE_${profileId}`;
      this.sink([
        { type: 'tool.completed', toolCallId: `${prefix}-tool`, name: 'bash', output, error: false, timestamp: 40_000 },
        { type: 'message.completed', messageId: `${prefix}-assistant`, role: 'assistant', text: marker, timestamp: 40_001 },
        { type: 'run.completed', runId, aborted: false, timestamp: 40_002 },
      ]);
      this.streaming = false;
      this.emitState();
    };
    setTimeout(pump, 0);
  }

  private emitState(messagesIncluded = false): void {
    const state = this.getState();
    this.sink([{ type: 'state.changed', state: messagesIncluded ? state : { ...state, messages: [], tools: [] }, messagesIncluded, timestamp: Date.now() }]);
  }
}
