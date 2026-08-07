import { describe, expect, it } from 'vitest';
import { appInfoSchema, appSettingsSchema, clipboardTextInputSchema, clipboardWriteResultSchema, contextUsageSchema, emptyInputSchema, extensionUiStateSchema, filePreviewSchema, getAppInfoInputSchema, gitCombinedDiffSchema, gitCommitDetailsSchema, gitCommitInputSchema, gitDiffSchema, gitHistorySchema, gitOperationInputSchema, gitWorktreeInputSchema, gitWorktreeListSchema, imageSaveInputSchema, imageSaveResultSchema, ipcChannels, musicClearResultSchema, musicLoadInputSchema, musicQueueResultSchema, musicQueueSchema, musicStreamResultSchema, musicStreamSchema, openUpdateDownloadResultSchema, piEventBatchSchema, piEventSchema, promptInputSchema, queueMutationInputSchema, queuedMessageSchema, revealProjectResultSchema, runtimeStateSchema, runtimeTokenTelemetrySchema, runtimeToolSchema, sessionRenameInputSchema, sessionSummarySchema, setPermissionInputSchema, speechModelInputSchema, subagentControlInputSchema, subagentRunSchema, subagentToolDetailsSchema, subagentWorkflowSchema, speechTranscribeInputSchema, terminalCreateInputSchema, terminalWriteInputSchema, updateCheckResultSchema, windowStateSchema } from './ipc';

describe('IPC contracts', () => {
  it('accepts only an empty object for system info input', () => {
    expect(getAppInfoInputSchema.parse({})).toEqual({});
    expect(() => getAppInfoInputSchema.parse({ unexpected: true })).toThrow();
    expect(() => getAppInfoInputSchema.parse(undefined)).toThrow();
  });

  it('validates complete native window state', () => {
    expect(windowStateSchema.parse({ maximized: true, minimized: false })).toEqual({ maximized: true, minimized: false });
    expect(() => windowStateSchema.parse({ maximized: true })).toThrow();
  });

  it('validates normalized app information', () => {
    expect(
      appInfoSchema.parse({ name: 'Fate UI', version: '0.1.0', platform: 'win32', packaged: false }),
    ).toEqual({ name: 'Fate UI', version: '0.1.0', platform: 'win32', packaged: false });
    expect(() =>
      appInfoSchema.parse({ name: 'Other', version: '', platform: 'browser', packaged: 'no' }),
    ).toThrow();
  });

  it('uses an explicit allowlist without duplicate channels', () => {
    expect(ipcChannels.systemGetInfo).toBe('system:get-info');
    expect(ipcChannels.browserShowLinkContextMenu).toBe('browser:show-link-context-menu');
    expect(ipcChannels.browserOpenLink).toBe('browser:open-link');
    expect(ipcChannels.runtimePrompt).toBe('runtime:prompt');
    expect(ipcChannels.projectReveal).toBe('project:reveal');
    expect(ipcChannels.imageReadLocal).toBe('image:read-local');
    expect(ipcChannels.imageSaveAs).toBe('image:save-as');
    expect(ipcChannels.clipboardWriteText).toBe('clipboard:write-text');
    expect(ipcChannels.speechEnsureModel).toBe('speech:ensure-model');
    expect(ipcChannels.updatesCheck).toBe('updates:check');
    expect(ipcChannels.updatesOpenDownload).toBe('updates:open-download');
    expect(new Set(Object.values(ipcChannels)).size).toBe(Object.values(ipcChannels).length);
  });

  it('validates bounded update results and download confirmation', () => {
    expect(updateCheckResultSchema.parse({
      status: 'current',
      message: 'FateGUI is up to date. Installed version: 1.4.0',
      installedVersion: '1.4.0',
      productionVersion: '1.4.0',
    })).toMatchObject({ status: 'current' });
    expect(openUpdateDownloadResultSchema.parse({ opened: true })).toEqual({ opened: true });
    expect(() => updateCheckResultSchema.parse({ status: 'unknown', message: 'Nope' })).toThrow();
    expect(() => openUpdateDownloadResultSchema.parse({ opened: false })).toThrow();
  });

  it('keeps project reveal pathless and validates its typed result', () => {
    expect(emptyInputSchema.parse({})).toEqual({});
    expect(() => emptyInputSchema.parse({ path: 'C:/project' })).toThrow();
    expect(revealProjectResultSchema.parse({ opened: true })).toEqual({ opened: true });
    expect(() => revealProjectResultSchema.parse({ opened: false })).toThrow();
  });

  it('bounds and normalizes session names', () => {
    expect(sessionRenameInputSchema.parse({ sessionId: 's1', name: '  Focused work  ' }).name).toBe('Focused work');
    expect(() => sessionRenameInputSchema.parse({ sessionId: 's1', name: '   ' })).toThrow();
    expect(() => sessionRenameInputSchema.parse({ sessionId: 's1', name: 'bad\nname' })).toThrow();
  });

  it('validates bounded raster Save As requests and cancellation results', () => {
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    expect(imageSaveInputSchema.parse({ data, mimeType: 'image/png', suggestedName: '  Generated fox  ' })).toMatchObject({ suggestedName: 'Generated fox' });
    expect(imageSaveResultSchema.parse({ saved: false })).toEqual({ saved: false });
    expect(imageSaveResultSchema.parse({ saved: true, path: 'C:/Pictures/fox.png' })).toMatchObject({ saved: true });
    expect(() => imageSaveInputSchema.parse({ data: '<svg/>', mimeType: 'image/png', suggestedName: 'fox' })).toThrow();
  });

  it('bounds clipboard writes to plain text from the trusted renderer', () => {
    expect(clipboardTextInputSchema.parse({ text: 'Copy me' })).toEqual({ text: 'Copy me' });
    expect(clipboardWriteResultSchema.parse({ written: true })).toEqual({ written: true });
    expect(() => clipboardTextInputSchema.parse({ text: 'x'.repeat(200_001) })).toThrow();
    expect(() => clipboardTextInputSchema.parse({ text: 'Copy me', html: '<b>Copy me</b>' })).toThrow();
  });

  it('migrates image settings written before custom providers were added', () => {
    const parsed = appSettingsSchema.parse({
      appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true,
      terminalShell: null, reduceMotion: false,
      imageGeneration: { provider: 'openai', model: 'gpt-image-2' },
    });
    expect(parsed.imageGeneration).toEqual({ provider: 'openai', model: 'gpt-image-2', customProvider: null });
  });

  it('distinguishes a bounded post-compaction estimate from measured context usage', () => {
    expect(contextUsageSchema.parse({ tokens: 21_000, contextWindow: 100_000, percent: 21, estimated: true })).toEqual({
      tokens: 21_000, contextWindow: 100_000, percent: 21, estimated: true,
    });
    expect(() => contextUsageSchema.parse({ tokens: -1, contextWindow: 100_000, percent: -1, estimated: true })).toThrow();
  });

  it('validates strict bounded provider-native token telemetry', () => {
    const sample = {
      input: 120, output: 30, cacheRead: 400, cacheWrite: 10,
      reasoning: 12, totalTokens: 560, cost: 0.014, timestamp: 1_700_000_000_000,
    };
    const telemetry = {
      session: { input: 240, output: 60, cacheRead: 800, cacheWrite: 20, totalTokens: 1_120, cost: 0.028, turns: 2 },
      latest: sample,
      history: [sample],
    };
    expect(runtimeTokenTelemetrySchema.parse(telemetry)).toEqual(telemetry);
    expect(() => runtimeTokenTelemetrySchema.parse({ ...telemetry, latest: { ...sample, reasoning: 31 } })).toThrow();
    expect(() => runtimeTokenTelemetrySchema.parse({ ...telemetry, latest: { ...sample, cacheRead: -1 } })).toThrow();
    expect(() => runtimeTokenTelemetrySchema.parse({ ...telemetry, latest: { ...sample, cost: Number.POSITIVE_INFINITY } })).toThrow();
    expect(() => runtimeTokenTelemetrySchema.parse({ ...telemetry, latest: { ...sample, providerSpecific: true } })).toThrow();
    expect(() => runtimeTokenTelemetrySchema.parse({
      ...telemetry,
      history: Array.from({ length: 121 }, (_, index) => ({ ...sample, timestamp: index })),
    })).toThrow();
  });

  it('requires bounded data and supported MIME types for raster previews', () => {
    expect(filePreviewSchema.parse({ path: 'icon.png', name: 'icon.png', size: 3, state: 'image', content: 'abc', mimeType: 'image/png', language: 'plaintext', openable: false })).toMatchObject({ state: 'image' });
    expect(gitDiffSchema.parse({ path: 'icon.jpg', state: 'image', imageData: 'abc', mimeType: 'image/jpeg', language: 'plaintext', openable: false })).toMatchObject({ state: 'image' });
    expect(() => filePreviewSchema.parse({ path: 'icon.png', name: 'icon.png', size: 3, state: 'image', language: 'plaintext', openable: false })).toThrow();
  });

  it('rejects malformed runtime commands and oversized event batches', () => {
    expect(promptInputSchema.parse({ text: 'hello', behavior: 'prompt' })).toEqual({ text: 'hello', behavior: 'prompt' });
    expect(setPermissionInputSchema.parse({ level: 'read-only' })).toEqual({ level: 'read-only' });
    expect(setPermissionInputSchema.parse({ level: 'full-access' })).toEqual({ level: 'full-access' });
    expect(() => setPermissionInputSchema.parse({ level: 'root' })).toThrow();
    expect(() => promptInputSchema.parse({ text: '', extra: true })).toThrow();
    expect(() => piEventBatchSchema.parse(Array.from({ length: 101 }, () => ({ type: 'run.started', runId: 'r', timestamp: 1 })))).toThrow();
    expect(() => runtimeStateSchema.parse({ status: 'ready' })).toThrow();
  });

  it('validates enriched tool provenance in snapshots and event batches', () => {
    const provenance = { actor: { kind: 'root' as const }, affectedPaths: [{ path: 'src/app.ts', operation: 'edit' as const }] };
    const tool = { id: 'tool-1', name: 'edit', input: '{}', output: '', outputTruncated: false, status: 'running', startedAt: 1, updatedAt: 1, provenance };
    expect(runtimeToolSchema.parse(tool).provenance).toEqual(provenance);
    expect(piEventSchema.parse({ type: 'tool.started', toolCallId: 'tool-1', name: 'edit', input: '{}', provenance, timestamp: 1 })).toMatchObject({ provenance });
    expect(piEventBatchSchema.parse([{ type: 'tool.completed', toolCallId: 'tool-1', name: 'edit', output: 'done', error: false, provenance, timestamp: 2 }])).toHaveLength(1);
    expect(() => runtimeToolSchema.parse({ ...tool, provenance: { ...provenance, affectedPaths: [{ path: '../secret', operation: 'edit' }] } })).toThrow();
    expect(() => piEventBatchSchema.parse([{ type: 'tool.started', toolCallId: 'tool-1', name: 'edit', input: '{}', provenance: { ...provenance, command: 'cat secret' }, timestamp: 1 }])).toThrow();
    expect(() => piEventSchema.parse({ type: 'tool.started', toolCallId: 'tool-1', name: 'edit', input: '{}', timestamp: 1, unexpected: 'not allowed' })).toThrow();
    const validState = { status: 'ready', project: null, sessionId: null, sessionFile: null, streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], error: null };
    expect(() => piEventSchema.parse({ type: 'state.changed', state: validState, messagesIncluded: false, timestamp: 1, unexpected: true })).toThrow();
  });

  it('bounds Git worktree, history, commit-detail, global-diff, and operation contracts', () => {
    const commit = {
      hash: 'a'.repeat(40), parents: [], authorName: 'Fate', authorEmail: 'fate@example.test',
      authoredAt: '2026-07-22T12:14:00.000Z', subject: 'Ship graph view', refs: [{ name: 'main', kind: 'head' }],
    };
    expect(gitHistorySchema.parse({ head: commit.hash, commits: [commit], truncated: false }).commits).toHaveLength(1);
    expect(gitCommitDetailsSchema.parse({ ...commit, filesChanged: 1, additions: 2, deletions: 1, files: [{ path: 'src/app.ts', status: 'M', additions: 2, deletions: 1, binary: false }], filesTruncated: false, githubUrl: null }).files).toHaveLength(1);
    expect(gitWorktreeListSchema.parse([{ path: 'C:/project', head: commit.hash, branch: 'main', bare: false, detached: false, current: true }])).toHaveLength(1);
    expect(gitCombinedDiffSchema.parse({ patch: 'diff --git a/a b/a', truncated: false }).patch).toContain('diff');
    expect(gitWorktreeInputSchema.parse({ path: 'C:/project-worktree' }).path).toBe('C:/project-worktree');
    expect(gitCommitInputSchema.parse({ hash: commit.hash }).hash).toBe(commit.hash);
    expect(gitOperationInputSchema.parse({ operation: 'fetch' })).toEqual({ operation: 'fetch' });
    expect(() => gitCommitInputSchema.parse({ hash: 'HEAD~1' })).toThrow();
    expect(() => gitOperationInputSchema.parse({ operation: 'force-push' })).toThrow();
  });

  it('validates stable queued-message IDs and explicit queue mutations', () => {
    const queued = { id: '00000000-0000-4000-8000-000000000001', behavior: 'followUp', text: 'Review the diff', createdAt: 1 };
    expect(queuedMessageSchema.parse(queued)).toEqual(queued);
    expect(queueMutationInputSchema.parse({ id: queued.id, action: 'steer' })).toEqual({ id: queued.id, action: 'steer' });
    expect(() => queueMutationInputSchema.parse({ id: 'not-a-uuid', action: 'cancel' })).toThrow();
    expect(() => queueMutationInputSchema.parse({ id: queued.id, action: 'send-now' })).toThrow();
  });

  it('validates canonical agent identity and renderer control boundaries', () => {
    expect(subagentControlInputSchema.parse({ action: 'cancel', target: '@reviewer-1' })).toEqual({ action: 'cancel', target: '@reviewer-1' });
    expect(subagentControlInputSchema.parse({ action: 'cancel', target: 'all' })).toEqual({ action: 'cancel', target: 'all' });
    expect(subagentControlInputSchema.parse({ action: 'steer', target: '@reviewer-1', message: 'Summarize now' })).toMatchObject({ action: 'steer' });
    expect(subagentControlInputSchema.parse({ action: 'rename', target: '@reviewer-1', displayName: 'Auth Reviewer' })).toMatchObject({ displayName: 'Auth Reviewer' });
    expect(() => subagentControlInputSchema.parse({ action: 'rename', target: 'all', displayName: 'Everyone' })).toThrow();
    expect(() => subagentControlInputSchema.parse({ action: 'steer', target: '@reviewer-1', message: '' })).toThrow();
    expect(() => subagentControlInputSchema.parse({ action: 'cancel', target: '@reviewer-1', extra: true })).toThrow();
  });

  it('bounds session attention and compact extension UI text state', () => {
    const summary = {
      id: 'one', title: 'One', firstMessage: 'Start', path: '/sessions/one.jsonl',
      createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:00:01.000Z', messageCount: 1,
      active: false, attention: 'completed',
    };
    expect(sessionSummarySchema.parse(summary).attention).toBe('completed');
    expect(() => sessionSummarySchema.parse({ ...summary, attention: 'purple' })).toThrow();
    expect(extensionUiStateSchema.parse({
      statuses: [{ key: 'build', text: 'Ready' }], widgets: [{ key: 'plan', lines: ['Step one'] }], working: null, title: 'Demo',
    }).title).toBe('Demo');
    expect(() => extensionUiStateSchema.parse({
      statuses: Array.from({ length: 17 }, (_, index) => ({ key: `k${index}`, text: 'x' })), widgets: [], working: null, title: null,
    })).toThrow();
  });

  it('validates bounded opaque music queues and HTTPS stream results', () => {
    const track = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Focus', duration: 60 };
    expect(musicLoadInputSchema.parse({ url: '  https://example.com/list  ' }).url).toBe('https://example.com/list');
    expect(musicQueueSchema.parse({ title: 'Queue', tracks: [track] }).tracks).toHaveLength(1);
    expect(musicStreamSchema.parse({ trackId: track.id, title: track.title, duration: track.duration, url: 'https://cdn.example/audio.m4a' }).url).toContain('https://');
    expect(() => musicQueueSchema.parse({ title: 'Queue', tracks: [] })).toThrow();
    expect(() => musicLoadInputSchema.parse({ url: 'x'.repeat(2_049) })).toThrow();

    expect(musicQueueResultSchema.parse({ ok: true, value: { title: 'Queue', tracks: [track] } })).toMatchObject({ ok: true });
    expect(musicQueueResultSchema.parse({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Bad link', retryable: true } })).toMatchObject({ ok: false });
    expect(musicStreamResultSchema.parse({ ok: false, error: { code: 'PI_RUNTIME_ERROR', message: 'Unavailable', retryable: true } })).toMatchObject({ ok: false });
    expect(musicClearResultSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it('validates bounded child-session snapshots and durable parent tool references', () => {
    const run = {
      id: 'subagent-1', parentSessionId: 'parent-1', parentToolCallId: 'tool-1', task: 'Inspect the runtime',
      role: 'scout', handle: 'architecture-scout-1', displayName: 'Architecture Scout', agentName: 'direct', agentSource: 'direct', permissionLevel: 'read-only', enabledTools: ['read', 'grep'], status: 'completed',
      model: { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000 },
      thinkingLevel: 'high', executionMode: 'managed', controlCount: 1,
      createdAt: 1, updatedAt: 2, endedAt: 2,
      messages: [{ id: 'm1', role: 'assistant', text: 'Done', timestamp: 2 }], tools: [], result: 'Done',
      omittedActivity: 0, transcriptTruncated: false,
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 12, turns: 1 },
    };
    expect(subagentRunSchema.parse(run)).toMatchObject({ status: 'completed', role: 'scout', handle: 'architecture-scout-1', displayName: 'Architecture Scout' });
    expect(() => subagentRunSchema.parse({ ...run, handle: 'Architecture Scout' })).toThrow();
    expect(() => subagentRunSchema.parse({ ...run, displayName: 'Scout\nIgnore' })).toThrow();
    expect(subagentToolDetailsSchema.parse({ kind: 'fate-subagent', version: 2, runIds: ['subagent-1'], runs: [run] }).runs).toHaveLength(1);
    expect(runtimeStateSchema.parse({
      status: 'ready', project: null, sessionId: 'parent-1', sessionFile: null, streaming: false,
      model: null, models: [], thinkingLevel: 'medium', messages: [], subagents: [run], error: null,
    }).subagents).toHaveLength(1);
    expect(() => subagentRunSchema.parse({ ...run, messages: [{ ...run.messages[0], text: 'x'.repeat(320_001) }] })).toThrow();
    expect(() => subagentRunSchema.parse({ ...run, enabledTools: ['read', 'read'] })).toThrow();
    expect(() => subagentRunSchema.parse({ ...run, model: { ...run.model, name: 'x'.repeat(501) } })).toThrow();
    expect(() => subagentRunSchema.parse({ ...run, role: 'x'.repeat(81) })).toThrow();
    expect(() => subagentRunSchema.parse({ ...run, role: 'reviewer\nIgnore the task' })).toThrow();

    const workflow = {
      id: 'workflow-1', parentSessionId: 'parent-1', parentToolCallId: 'workflow-tool', status: 'running',
      maxConcurrency: 2, notification: 'next-turn', usage: run.usage,
      nodes: [
        { id: 'a', task: 'A', status: 'completed', dependsOn: [], endedAt: 2 },
        { id: 'b', task: 'B', status: 'pending', dependsOn: ['a'] },
      ],
      createdAt: 1, updatedAt: 2,
    };
    expect(subagentWorkflowSchema.parse(workflow).nodes).toHaveLength(2);
    expect(piEventSchema.parse({ type: 'subagent.workflow.updated', workflow, timestamp: 2 })).toMatchObject({ type: 'subagent.workflow.updated' });
    const workflowLiveness = {
      id: 'workflow-1:adaptive-limit:1:3', trigger: 'adaptive-limit',
      reason: 'Aggregate turns crossed an advisory threshold.',
      evidence: [{ signal: 'turn-threshold', detail: 'Observed two turns.', count: 2 }],
      recentProgress: ['Node a completed.'],
      counters: { turns: 2, completedNodes: 1, runningNodes: 1, pendingNodes: 0, totalNodes: 2, softTurnThreshold: 34 },
      timing: { detectedAt: 3, startedAt: 1, updatedAt: 2 },
      workflow: { id: 'workflow-1' },
      checkpointSummary: 'One node completed; one remains active.',
      recommendedOptions: ['continue', 'steer', 'request-checkpoint', 'cancel'],
    };
    expect(subagentWorkflowSchema.parse({ ...workflow, livenessReports: [workflowLiveness] }).livenessReports).toHaveLength(1);
    expect(piEventSchema.parse({ type: 'subagent.workflow.liveness', workflowId: 'workflow-1', report: workflowLiveness, timestamp: 3 }))
      .toMatchObject({ type: 'subagent.workflow.liveness', workflowId: 'workflow-1' });

    const manyRuns = Array.from({ length: 60 }, (_, index) => ({ ...run, id: `subagent-${index}`, parentToolCallId: `tool-${index}` }));
    expect(subagentToolDetailsSchema.parse({ kind: 'fate-subagent', version: 3, runIds: manyRuns.map((item) => item.id), runs: manyRuns }).runs).toHaveLength(60);
    expect(runtimeStateSchema.parse({
      status: 'ready', project: null, sessionId: 'parent-1', sessionFile: null, streaming: false,
      model: null, models: [], thinkingLevel: 'medium', messages: [], subagents: manyRuns, error: null,
    }).subagents).toHaveLength(60);
    expect(subagentRunSchema.parse({ ...run, result: 'r'.repeat(400_000), maxAttempts: 12, attempt: 12 }).result).toHaveLength(400_000);

    const largeWorkflow = {
      ...workflow,
      maxConcurrency: 10,
      nodes: Array.from({ length: 20 }, (_, index) => ({ id: `node-${index}`, task: `Task ${index}`, status: 'pending', dependsOn: [] })),
    };
    expect(subagentWorkflowSchema.parse(largeWorkflow)).toMatchObject({ maxConcurrency: 10, nodes: expect.any(Array) });
    expect(subagentWorkflowSchema.parse(largeWorkflow).nodes).toHaveLength(20);
    expect(() => subagentWorkflowSchema.parse({
      ...workflow,
      nodes: [
        { id: 'a', task: 'A', status: 'pending', dependsOn: ['b'] },
        { id: 'b', task: 'B', status: 'pending', dependsOn: ['a'] },
      ],
    })).toThrow();
    expect(() => piEventSchema.parse({ type: 'subagent.workflow.updated', workflow: { ...workflow, error: 'x'.repeat(4_001) }, timestamp: 2 })).toThrow();
  });

  it('bounds terminal payloads and keeps credentials out of settings contracts', () => {
    expect(terminalCreateInputSchema.parse({ cols: 120, rows: 30 })).toEqual({ cols: 120, rows: 30 });
    expect(() => terminalCreateInputSchema.parse({ cols: 1, rows: 30 })).toThrow();
    expect(() => terminalWriteInputSchema.parse({ id: 'not-a-uuid', data: 'x' })).toThrow();
    expect(() => terminalWriteInputSchema.parse({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', data: 'x'.repeat(65_537) })).toThrow();
    expect(() => appSettingsSchema.parse({ appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true, terminalShell: null, reduceMotion: false, apiKey: 'secret' })).toThrow();
    const defaults = appSettingsSchema.parse({ appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true, terminalShell: null, reduceMotion: false });
    expect(defaults.performanceMode).toBe(false);
    expect(defaults.musicPlayerEnabled).toBe(false);
    expect(defaults.sendMessageWithModifier).toBe(false);
    expect(defaults.interfaceFont).toBe('noto-sans');
    expect(defaults.codeFont).toBe('jetbrains-mono');
    expect(defaults.speech).toEqual({ enabled: true, modelId: 'mini', language: 'auto', inputDeviceId: null });
    expect(speechModelInputSchema.parse({ modelId: 'max' })).toEqual({ modelId: 'max' });
    expect(() => speechModelInputSchema.parse({ modelId: 'huge' })).toThrow();
    expect(speechTranscribeInputSchema.parse({ modelId: 'mini', audio: new ArrayBuffer(16) }).audio.byteLength).toBe(16);
    expect(() => speechTranscribeInputSchema.parse({ modelId: 'mini', audio: new ArrayBuffer(3) })).toThrow();
    expect(() => appSettingsSchema.parse({ ...defaults, interfaceFont: 'comic-sans' })).toThrow();
  });
});
