import { describe, expect, it } from 'vitest';
import { appInfoSchema, appSettingsSchema, emptyInputSchema, filePreviewSchema, getAppInfoInputSchema, gitCombinedDiffSchema, gitCommitDetailsSchema, gitCommitInputSchema, gitDiffSchema, gitHistorySchema, gitOperationInputSchema, gitWorktreeInputSchema, gitWorktreeListSchema, imageSaveInputSchema, imageSaveResultSchema, ipcChannels, musicClearResultSchema, musicLoadInputSchema, musicQueueResultSchema, musicQueueSchema, musicStreamResultSchema, musicStreamSchema, piEventBatchSchema, promptInputSchema, queueMutationInputSchema, queuedMessageSchema, revealProjectResultSchema, runtimeStateSchema, sessionRenameInputSchema, setPermissionInputSchema, speechModelInputSchema, speechTranscribeInputSchema, terminalCreateInputSchema, terminalWriteInputSchema, windowStateSchema } from './ipc';

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
    expect(ipcChannels.runtimePrompt).toBe('runtime:prompt');
    expect(ipcChannels.projectReveal).toBe('project:reveal');
    expect(ipcChannels.imageSaveAs).toBe('image:save-as');
    expect(ipcChannels.speechEnsureModel).toBe('speech:ensure-model');
    expect(new Set(Object.values(ipcChannels)).size).toBe(Object.values(ipcChannels).length);
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
