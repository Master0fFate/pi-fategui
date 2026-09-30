import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceSnapshotService } from '../../src/core/views/WorkspaceSnapshotService';
import { HistoryPageService } from '../../src/core/views/HistoryPageService';
import { PiSessionRepository, projectSessionDirectory } from '../../src/main/pi/PiSessionRepository';
import type { RuntimeState } from '../../src/shared/contracts/ipc';
import { SNAPSHOT_PAGE_BYTES, SNAPSHOT_TOTAL_BYTES } from '../../src/shared/protocol/snapshots';
import type { TaskList } from '../../src/shared/contracts/tasks';
import { buildMonitorDashboard } from '../../src/main/pi/monitor/MonitorDashboard';

const scope = { principalId: 'alice', clientId: 'tab-1', workspaceId: 'w1', workspaceGeneration: 2, serverEpoch: 'epoch-1', sessionId: 's1', projectPath: '/tmp/project' };
const state = (): RuntimeState => ({ status: 'ready', project: { path: '/tmp/project', name: 'Project', trusted: true }, sessionId: 's1', sessionFile: null,
  streaming: true, activeSessionRunning: true, runningSessionCount: 1, model: null, models: [], thinkingLevel: 'high', permissionLevel: 'edit',
  messages: [], tools: [], sessions: [], queue: { steering: 0, followUp: 0, recovered: [] }, error: null });
const item = (index: number, text = 'text') => ({ id: `m${index}`, role: 'user' as const, text, timestamp: index, timelinePosition: index });

describe('bounded workspace snapshots', () => {
  it('captures atomically after flush; goal/task mutation after capture cannot drift pages', () => {
    const live = state();
    const goal = { id: 'goal-1', revision: 1, status: 'active', phase: 'research' };
    const task = { id: 'task-1', title: 'Before', status: 'todo' };
    live.messages = Array.from({ length: 3000 }, (_, index) => item(index, 'a'.repeat(600)));
    let flushed = 0;
    const service = new WorkspaceSnapshotService(() => { flushed++; }, () => ({ state: live, goal, tasks: [task] }));
    const first = service.capture(scope);
    expect(flushed).toBe(1);
    expect(first.header!.controls.streaming).toBe(true);
    goal.revision = 2;
    task.title = 'After';
    live.messages[0]!.text = 'After';
    const pages = [first, ...first.header!.pageIds.slice(1).map((id) => service.page(scope, id))];
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => Buffer.byteLength(JSON.stringify(page)) <= SNAPSHOT_PAGE_BYTES)).toBe(true);
    expect(pages.reduce((bytes, page) => bytes + Buffer.byteLength(JSON.stringify(page)), 0)).toBeLessThanOrEqual(SNAPSHOT_TOTAL_BYTES);
    expect(JSON.stringify(pages)).toContain('Before');
    expect(JSON.stringify(pages)).not.toContain('After');
    expect(() => service.page({ ...scope, principalId: 'bob' }, first.header!.pageIds[1]!)).toThrow();
    expect(() => service.page({ ...scope, workspaceGeneration: 3 }, first.header!.pageIds[1]!)).toThrow();
    expect(() => service.page({ ...scope, serverEpoch: 'epoch-2' }, first.header!.pageIds[1]!)).toThrow();
    expect(() => service.page({ ...scope, sessionId: 's2' }, first.header!.pageIds[1]!)).toThrow();
    expect(() => service.page({ ...scope, projectPath: '/tmp/other' }, first.header!.pageIds[1]!)).toThrow();
  });

  it('labels clipped oversized items, media, and omitted old history; retains pending warnings', () => {
    const live = state();
    live.messages = [item(0, 'a'.repeat(2_000_000))];
    live.messages[0]!.images = [{ mimeType: 'image/png', data: 'a'.repeat(1_000_000) }];
    live.queue = { steering: 0, followUp: 1, recovered: [{ id: '99999999-9999-4999-8999-999999999999', behavior: 'followUp', text: 'needs review', createdAt: 1 }] };
    const service = new WorkspaceSnapshotService(() => undefined, () => ({ state: live, goal: null, tasks: [] }));
    const page = service.capture(scope);
    expect(page.header!.omissions).toMatchObject({ history: false, media: true, clippedItems: 1 });
    expect(page.header!.controls.activeSessionRunning).toBe(true);
    expect(page.header!.warnings).toContain('A recovered queue item needs review before any new execution.');
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(SNAPSHOT_PAGE_BYTES);
  });

  it('takes goal and task mutations that occur during the flush boundary, not stale values', () => {
    const live = state();
    const goal = { id: 'g', revision: 1, status: 'active', phase: 'planning' };
    const task = { id: 't', title: 'Before flush', status: 'todo' };
    const service = new WorkspaceSnapshotService(() => { goal.revision = 2; task.title = 'After flush'; },
      () => ({ state: live, goal, tasks: [task], taskRevision: goal.revision }));
    const first = service.capture(scope);
    expect(first.header!.goal?.revision).toBe(2);
    expect(first.header!.taskRevision).toBe(2);
    expect(first.header!.tasks[0]?.title).toBe('After flush');
    expect(() => new WorkspaceSnapshotService(() => undefined, () => ({ state: { ...live, sessionId: 'other' }, goal, tasks: [task] })).capture(scope)).toThrow('SNAPSHOT_NOT_READY');
    expect(() => new WorkspaceSnapshotService(() => undefined, () => ({ state: live, goal: null, tasks: [], tasksReady: false })).capture(scope)).toThrow('SNAPSHOT_NOT_READY');
  });

  it('expires cursors and keeps at most two captures per client', () => {
    let now = 1000;
    const service = new WorkspaceSnapshotService(() => undefined, () => ({ state: state(), goal: null, tasks: [] }), () => now);
    const first = service.capture(scope);
    service.capture(scope); service.capture(scope);
    expect(() => service.page(scope, first.header!.pageIds[0]!)).toThrow();
    const last = service.capture(scope);
    now += 60_001;
    expect(() => service.page(scope, last.header!.pageIds[0]!)).toThrow();
  });
});

describe('saved history read', () => {
  it('keeps oversized hidden custom and non-display metadata invisible in a header-only history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fate-history-hidden-'));
    const cwd = join(root, 'project');
    const sessionsRoot = join(root, 'sessions');
    await mkdir(projectSessionDirectory(cwd, sessionsRoot), { recursive: true });
    const file = join(projectSessionDirectory(cwd, sessionsRoot), 'saved.jsonl');
    const saved = [
      { type: 'session', id: 'saved', cwd, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'custom_message', id: 'hidden', parentId: null, customType: 'private', content: 'PRIVATE'.repeat(30_000), display: false },
      { type: 'custom', id: 'metadata', parentId: 'hidden', data: { type: 'message', payload: 'HIDDEN META'.repeat(20_000) } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    try {
      await writeFile(file, saved);
      const page = await new HistoryPageService(new PiSessionRepository(undefined, sessionsRoot))
        .read({ ...scope, projectPath: cwd, sessionId: 'saved' });
      expect(page).toMatchObject({ items: [], oversizedItems: 0, mediaOmitted: false, nextPageId: null });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(SNAPSHOT_PAGE_BYTES);
      expect(await readFile(file, 'utf8')).toBe(saved);
      // JSON.parse would use the last duplicate display value. Never trust a
      // bounded prefix and turn ambiguous hidden data into a visible row.
      const ambiguous = `${JSON.stringify({ type: 'session', id: 'saved', cwd, timestamp: '2026-01-01T00:00:00Z' })}\n`
        + `{"type":"custom_message","id":"dup","parentId":null,"content":"${'PRIVATE'.repeat(30_000)}","display":false,"display":true}\n`;
      await writeFile(file, ambiguous);
      await expect(new HistoryPageService(new PiSessionRepository(undefined, sessionsRoot))
        .read({ ...scope, projectPath: cwd, sessionId: 'saved' })).rejects.toThrow('cannot be classified safely');
      expect(await readFile(file, 'utf8')).toBe(ambiguous);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps oversized hidden records out of normal-message pagination and retains visible oversized markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fate-history-hidden-page-'));
    const cwd = join(root, 'project');
    const sessionsRoot = join(root, 'sessions');
    await mkdir(projectSessionDirectory(cwd, sessionsRoot), { recursive: true });
    const file = join(projectSessionDirectory(cwd, sessionsRoot), 'saved.jsonl');
    const normal = Array.from({ length: 126 }, (_, index) => ({ type: 'message', id: `e${index}`, parentId: index ? `e${index - 1}` : null,
      message: { role: 'user', content: [{ type: 'text', text: `normal ${index}` }] } }));
    const hidden = { type: 'custom_message', id: 'hidden', parentId: 'e125', content: 'PRIVATE'.repeat(30_000), display: false };
    const metadata = { type: 'model_change', id: 'metadata', parentId: 'hidden', provider: 'p', modelId: 'M'.repeat(190_000) };
    const visible = { type: 'custom_message', id: 'visible', parentId: 'metadata', content: 'show this', display: true };
    const compact = { type: 'compaction', id: 'compact', parentId: 'visible', summary: 'private summary' };
    const tail = { type: 'message', id: 'tail', parentId: 'compact', message: { role: 'assistant', content: 'after compaction' } };
    const giant = { type: 'message', id: 'giant', parentId: 'tail', message: { role: 'user', content: [{ type: 'text', text: 'VISIBLE'.repeat(30_000) }] } };
    const saved = [{ type: 'session', id: 'saved', cwd, timestamp: '2026-01-01T00:00:00Z' }, ...normal, hidden, metadata, visible, compact, tail, giant]
      .map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    try {
      await writeFile(file, saved);
      const service = new HistoryPageService(new PiSessionRepository(undefined, sessionsRoot));
      const requested = { ...scope, projectPath: cwd, sessionId: 'saved' };
      const first = await service.read(requested);
      expect(first.items.map((row) => row.id)).toEqual([...normal.map((row) => row.id), 'visible', 'compact']);
      expect(first).toMatchObject({ oversizedItems: 0, mediaOmitted: false });
      expect(first.nextPageId).toBeTruthy();
      const second = await service.read(requested, first.nextPageId!);
      expect(second.items.map((row) => row.id)).toEqual(['tail', expect.stringContaining('oversized:')]);
      expect(second.items[1]).toMatchObject({ clipped: true, mediaOmitted: true });
      expect(second).toMatchObject({ oversizedItems: 1, mediaOmitted: true, nextPageId: null });
      expect([first, second].every((page) => Buffer.byteLength(JSON.stringify(page)) <= SNAPSHOT_PAGE_BYTES)).toBe(true);
      expect(await readFile(file, 'utf8')).toBe(saved);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('shows a displayed custom message when it is the only saved history item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fate-history-custom-'));
    const cwd = join(root, 'project');
    const sessionsRoot = join(root, 'sessions');
    const dir = projectSessionDirectory(cwd, sessionsRoot);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'saved.jsonl');
    const saved = [
      { type: 'session', id: 'saved', cwd, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'custom_message', id: 'visible', parentId: null, customType: 'notice', content: 'VISIBLE REVIEW WARNING', display: true, timestamp: '2026-01-01T00:00:01Z' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    try {
      await writeFile(file, saved);
      const page = await new HistoryPageService(new PiSessionRepository(undefined, sessionsRoot))
        .read({ ...scope, projectPath: cwd, sessionId: 'saved' });
      expect(page.items).toEqual([{ kind: 'message', id: 'visible', role: 'system', text: 'VISIBLE REVIEW WARNING',
        timestamp: Date.parse('2026-01-01T00:00:01Z'), clipped: false, mediaOmitted: false }]);
      expect(page.nextPageId).toBeNull();
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(SNAPSHOT_PAGE_BYTES);
      expect(await readFile(file, 'utf8')).toBe(saved);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps displayed custom and compaction rows between normal messages across a page boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fate-history-compaction-'));
    const cwd = join(root, 'project');
    const sessionsRoot = join(root, 'sessions');
    const dir = projectSessionDirectory(cwd, sessionsRoot);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'saved.jsonl');
    const header = { type: 'session', id: 'saved', cwd, timestamp: '2026-01-01T00:00:00Z' };
    const normal = Array.from({ length: 126 }, (_, index) => ({ type: 'message', id: `e${index}`, parentId: index ? `e${index - 1}` : null,
      message: { role: 'user', content: [{ type: 'text', text: `normal ${index}` }] } }));
    const custom = { type: 'custom_message', id: 'visible', parentId: 'e125', customType: 'warning', display: true,
      content: [{ type: 'text', text: `REVIEW ${'z'.repeat(5000)}` }, { type: 'image', mimeType: 'image/png', data: 'base64' }],
      timestamp: '2026-01-01T00:00:01Z' };
    const compact = { type: 'compaction', id: 'compact', parentId: 'visible', timestamp: '2026-01-01T00:00:02Z', summary: 'private context' };
    const tail = { type: 'message', id: 'tail', parentId: 'compact', message: { role: 'assistant', content: [{ type: 'text', text: 'after compaction' }] } };
    const saved = [header, ...normal, custom, compact, tail].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    try {
      await writeFile(file, saved);
      let now = 1000;
      const service = new HistoryPageService(new PiSessionRepository(undefined, sessionsRoot), () => now);
      const requested = { ...scope, projectPath: cwd, sessionId: 'saved' };
      const first = await service.read(requested);
      expect(first.items.map((row) => row.id)).toEqual([...normal.map((row) => row.id), 'visible', 'compact']);
      expect(first.items[126]).toMatchObject({ role: 'system', clipped: true, mediaOmitted: true, timestamp: Date.parse(custom.timestamp) });
      expect(first.items[126]?.text).toContain('REVIEW');
      expect(first.items[127]).toMatchObject({ kind: 'message', role: 'system', text: 'Context compacted', clipped: false, mediaOmitted: false });
      expect(first.mediaOmitted).toBe(true);
      expect(first.nextPageId).toBeTruthy();
      await expect(service.read({ ...requested, principalId: 'bob' }, first.nextPageId!)).rejects.toThrow('RESYNC_REQUIRED');
      const second = await service.read(requested, first.nextPageId!);
      expect(second.items.map((row) => row.id)).toEqual(['tail']);
      expect(second.nextPageId).toBeNull();
      expect([first, second].every((page) => Buffer.byteLength(JSON.stringify(page)) <= SNAPSHOT_PAGE_BYTES)).toBe(true);
      const expiring = await service.read(requested);
      now += 60_001;
      await expect(service.read(requested, expiring.nextPageId!)).rejects.toThrow('RESYNC_REQUIRED');
      expect(await readFile(file, 'utf8')).toBe(saved);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('labels an oversized saved item, unsupported image, and a final non-newline record without modifying history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fate-history-large-'));
    const cwd = join(root, 'project');
    const sessionsRoot = join(root, 'sessions');
    const dir = projectSessionDirectory(cwd, sessionsRoot);
    await mkdir(dir, { recursive: true });
    try {
      const header = JSON.stringify({ type: 'session', id: 'saved', cwd, timestamp: new Date().toISOString() });
      const oversized = JSON.stringify({ type: 'message', id: 'large', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'z'.repeat(200_000) }] } });
      const image = JSON.stringify({ type: 'message', id: 'image', parentId: 'large', message: { role: 'user', content: [{ type: 'text', text: 'image label' }, { type: 'image', data: 'base64', mimeType: 'image/png' }] } });
      const last = JSON.stringify({ type: 'message', id: 'last', parentId: 'image', message: { role: 'assistant', content: [{ type: 'text', text: 'final without newline' }] } });
      const saved = [header, oversized, image, last].join('\n');
      const file = join(dir, 'saved.jsonl');
      await writeFile(file, saved);
      const service = new HistoryPageService(new PiSessionRepository(undefined, sessionsRoot));
      const page = await service.read({ ...scope, projectPath: cwd, sessionId: 'saved' });
      expect(page.items.map((row) => row.id)).toEqual([expect.stringContaining('oversized:'), 'image', 'last']);
      expect(page.items[0]).toMatchObject({ clipped: true, mediaOmitted: true });
      expect(page.items[1]).toMatchObject({ mediaOmitted: true, text: 'image label' });
      expect(page.items[2]?.text).toBe('final without newline');
      expect(page.oversizedItems).toBe(1);
      expect(page.mediaOmitted).toBe(true);
      expect(page.nextPageId).toBeNull();
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(SNAPSHOT_PAGE_BYTES);
      expect(await readFile(file, 'utf8')).toBe(saved);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('pages JSONL without selecting or creating an agent and rejects changed files and foreign cursors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fate-history-'));
    const cwd = join(root, 'project');
    const sessionsRoot = join(root, 'sessions');
    const dir = projectSessionDirectory(cwd, sessionsRoot);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'saved.jsonl');
    try {
      const lines = [{ type: 'session', id: 'saved', cwd, timestamp: new Date().toISOString() },
        ...Array.from({ length: 500 }, (_, index) => ({ type: 'message', id: `e${index}`, parentId: index ? `e${index - 1}` : null, message: { role: 'user', content: [{ type: 'text', text: `older ${index} ${'a'.repeat(6000)}` },
          ...(index === 128 ? [{ type: 'image', mimeType: 'image/png', data: 'base64' }] : [])] } }))];
      await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
      const service = new HistoryPageService(new PiSessionRepository(undefined, sessionsRoot));
      const requested = { ...scope, projectPath: cwd, sessionId: 'saved' };
      const first = await service.read(requested);
      expect(first.items.length).toBeGreaterThan(0);
      expect(first.nextPageId).toBeTruthy();
      expect(first.mediaOmitted).toBe(false);
      expect(first.items[0]?.text).toContain('older 0');
      await expect(service.read({ ...requested, principalId: 'bob' }, first.nextPageId!)).rejects.toThrow();
      await expect(service.read({ ...requested, workspaceId: 'w2' }, first.nextPageId!)).rejects.toThrow();
      const second = await service.read(requested, first.nextPageId!);
      expect(first.items.at(-1)?.text).toContain(`older ${first.items.length - 1}`);
      expect(second.items[0]?.text).toContain(`older ${first.items.length}`);
      expect(second.items[0]?.mediaOmitted).toBe(true);
      expect(second.mediaOmitted).toBe(true);
      await writeFile(file, 'changed');
      await expect(service.read(requested, second.nextPageId!)).rejects.toThrow();
      await expect(service.read({ ...requested, sessionId: 'missing' })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('monitor is a separate compact projection', () => {
  it('invalidates the requested page on a source failure or changed page, not transcript polling', () => {
    const inputs = { projectPath: '/tmp/project', sessionId: 's1', runs: null, teams: [], tasks: null, goal: null,
      runsAvailable: false, sessionAvailable: true, now: 100 } as const;
    const query = { section: 'tasks' as const, offset: 0, limit: 1 };
    const first = buildMonitorDashboard(inputs, query);
    expect(first.sources.runs).toBe('unknown');
    const unloaded = buildMonitorDashboard({ ...inputs, tasksAvailable: false, teams: null });
    expect(unloaded.sources).toMatchObject({ tasks: 'unknown', teams: 'unknown' });
    expect(unloaded.sourceCheckedAt).toMatchObject({ tasks: null, teams: null });
    const failed = buildMonitorDashboard({ ...inputs, sessionAvailable: false }, { ...query, sinceRevision: first.revision });
    expect(failed.unchanged).toBe(false);
    const changedPage = buildMonitorDashboard(inputs, { ...query, offset: 1, sinceRevision: first.revision });
    expect(changedPage.unchanged).toBe(false);
    const list: TaskList = { schemaVersion: 1, projectPath: inputs.projectPath, sessionId: 's1', revision: 1, goalId: null, currentTaskId: 't1', updatedAt: 1,
      tasks: ['t1', 't2'].map((id, order) => ({ id, title: id, detail: '', status: 'todo', required: false, source: 'user', goalId: null,
        goalCriterionId: null, order, verified: false, verifiedAt: null, createdAt: 1, updatedAt: order + 1 })) };
    const row0 = buildMonitorDashboard({ ...inputs, tasks: list }, query);
    const nextList: TaskList = { ...list, tasks: list.tasks.map((task) => task.id === 't1' ? { ...task, title: 'changed' } : task) };
    const samePage = buildMonitorDashboard({ ...inputs, tasks: nextList }, { ...query, sinceRevision: row0.revision });
    expect(samePage.unchanged).toBe(true);
    const row1 = buildMonitorDashboard({ ...inputs, tasks: nextList }, { ...query, offset: 1, sinceRevision: row0.revision });
    expect(row1.unchanged).toBe(false);
    expect(row1.items[0]?.title).toBe('changed');
  });
});
