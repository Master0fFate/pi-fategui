import { describe, expect, it, vi } from 'vitest';
import {
  RecoverySnapshotService,
  noticeFromSnapshot,
  recoveryBannerText,
  recoveryFilePath,
  snapshotFromRuntime,
  type RecoverySnapshot,
  type RecoverySnapshotStore,
} from './RecoverySnapshot';

function snapshot(overrides: Partial<RecoverySnapshot> = {}): RecoverySnapshot {
  return {
    version: 1,
    dirty: true,
    projectPath: '/proj',
    sessionId: 'sess-1',
    permissionLevel: 'edit',
    streaming: true,
    activeSessionRunning: true,
    queueSteering: 1,
    queueFollowUp: 2,
    eventCursor: 9,
    lastToolName: 'edit',
    writtenAt: 100,
    ...overrides,
  };
}

function memoryStore(initial?: string): RecoverySnapshotStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  if (initial) files.set('/recovery.json', initial);
  return {
    files,
    async read(filePath) {
      const value = files.get(filePath);
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    async write(filePath, contents) {
      files.set(filePath, contents);
    },
    async remove(filePath) {
      files.delete(filePath);
    },
  };
}

describe('RecoverySnapshot', () => {
  it('captures the live session and running tool from runtime state', () => {
    const captured = snapshotFromRuntime({
      project: { path: '/proj', name: 'proj', trusted: true },
      sessionId: 'sess-1',
      permissionLevel: 'edit',
      streaming: true,
      activeSessionRunning: true,
      queue: { steering: 1, followUp: 0 },
      eventCursor: 4,
      tools: [
        { id: 't1', name: 'read', input: '', output: '', outputTruncated: false, status: 'succeeded', startedAt: 1, updatedAt: 2 },
        { id: 't2', name: 'edit', input: '', output: '', outputTruncated: false, status: 'running', startedAt: 3, updatedAt: 4 },
      ],
    }, 50);
    expect(captured).toMatchObject({
      dirty: true,
      projectPath: '/proj',
      sessionId: 'sess-1',
      lastToolName: 'edit',
      eventCursor: 4,
      writtenAt: 50,
    });
  });

  it('loads a dirty snapshot and ignores clean, corrupt, or incomplete files', async () => {
    const ok = memoryStore(`${JSON.stringify(snapshot())}\n`);
    expect((await new RecoverySnapshotService('/recovery.json', ok).load())?.sessionId).toBe('sess-1');

    const clean = memoryStore(`${JSON.stringify(snapshot({ dirty: false }))}\n`);
    expect(await new RecoverySnapshotService('/recovery.json', clean).load()).toBeNull();

    const incomplete = memoryStore(`${JSON.stringify(snapshot({ sessionId: null }))}\n`);
    expect(await new RecoverySnapshotService('/recovery.json', incomplete).load()).toBeNull();

    const corrupt = memoryStore('{not-json');
    expect(await new RecoverySnapshotService('/recovery.json', corrupt).load()).toBeNull();
  });

  it('writes a dirty snapshot and clears it on a clean shutdown', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const service = new RecoverySnapshotService('/recovery.json', store, () => 10);
    service.remember({
      project: { path: '/proj', name: 'proj', trusted: true },
      sessionId: 'sess-1',
      streaming: false,
      tools: [],
    });
    await vi.runAllTimersAsync();
    expect(store.files.get('/recovery.json')).toContain('"sessionId":"sess-1"');
    await service.markClean();
    expect(store.files.has('/recovery.json')).toBe(false);
    vi.useRealTimers();
  });

  it('returns the notice once and then forgets it', async () => {
    const store = memoryStore(`${JSON.stringify(snapshot())}\n`);
    const service = new RecoverySnapshotService('/recovery.json', store);
    await service.load();
    const first = service.consume();
    expect(first).toEqual(noticeFromSnapshot(snapshot()));
    expect(service.consume()).toBeNull();
    expect(store.files.has('/recovery.json')).toBe(true);
    await service.markClean();
    expect(store.files.has('/recovery.json')).toBe(false);
  });

  it('scopes the snapshot file to the instance slot', () => {
    expect(recoveryFilePath('/data', 2)).toMatch(/recovery-slot-2\.json$/);
  });

  it('describes an interrupted run without claiming lost work is gone', () => {
    expect(recoveryBannerText(noticeFromSnapshot(snapshot()))).toMatch(/stopped without a clean shutdown.*still running.*Queued prompts.*Last running tool: edit/);
  });
});
