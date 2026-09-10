import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { emptyActivation, type LearningMutation, type LessonContent, type MemoryLearningSettings } from '../../shared/contracts/learning';
import { LearningService } from './LearningService';
import { learningDigest, learningIdentity, LearningRepository, projectLearningKey } from './LearningRepository';
import { visibleLearningText, type LearningOrigin } from './LearningEvidence';
import type { LearningProvider } from './LearningGenerator';
import { LearningContextAdapter } from './LearningContext';
import { selectLearning } from './LearningSelection';

let root: string;
let service: LearningService;
let repository: LearningRepository;
let settings: MemoryLearningSettings;
let valid: boolean;
let origin: LearningOrigin;
const profile = (): LessonContent => ({ kind: 'user-profile', title: 'My coding preferences', body: { communication: ['Give concise, direct answers.'], workflow: ['Run checks before declaring completion.'], codingPreferences: [], designPreferences: ['Restrained, dark interfaces.'], decisionMaking: [], learningStyle: [], likes: [], dislikes: ['Unnecessary dependencies.'] }, activation: emptyActivation });
const brief = (): LessonContent => ({ kind: 'project-brief', title: 'Project briefing', body: { overview: 'An Electron workspace for a coding agent.', architecture: ['Files stay in main behind named IPC.'], decisions: ['Use pnpm and the installed Pi SDK.'], currentWork: [], nextSteps: [] }, activation: emptyActivation });
const note = (): LessonContent => ({ kind: 'note', title: 'Keep filesystem work in main', body: { guidance: 'Put filesystem access in main behind named IPC, not renderer components.', rationale: 'Preserve the process boundary.', exceptions: [] }, activation: { ...emptyActivation, keywords: ['filesystem', 'renderer'] } });
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'learning-service-')));
  settings = { enabled: true, global: true, project: true }; valid = true;
  repository = new LearningRepository(path.join(root, 'data'));
  service = new LearningService(repository, () => settings);
  origin = { root, binding: { projectKey: projectLearningKey(root), scope: 'project', sessionId: 'session-one', runtimeGeneration: 1 }, session: null, valid: () => valid };
});
afterEach(async () => { service.dispose(); await repository.flush(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });
async function mutation(action: Record<string, unknown>): Promise<void> {
  const state = await repository.read(learningIdentity(root, origin.binding.scope));
  await service.mutate(origin, { ...action, binding: origin.binding, epoch: state.epoch, expectedRevision: state.revision } as LearningMutation);
}
async function approved(content = note(), captureId?: string) {
  await mutation({ action: 'save-draft', content, evidenceIds: [], ...(captureId ? { captureId } : {}) });
  let snapshot = (await service.state(origin, null)).snapshot!;
  const draft = snapshot.drafts.at(-1)!;
  await mutation({ action: 'approve', id: draft.id, digest: draft.digest });
  snapshot = (await service.state(origin, null)).snapshot!;
  return { snapshot, lesson: snapshot.lessons.at(-1)!, revision: snapshot.revisions.at(-1)! };
}
async function manualCapture() { return service.previewEvidence(origin, { binding: origin.binding, sources: [{ kind: 'manual', text: 'Keep filesystem work in main. This is a user correction.' }] }); }
const fakeProvider = (completeSimple: unknown): LearningProvider => ({ model: { provider: 'test', id: 'fixed', input: ['text'] } as LearningProvider['model'], runtime: { completeSimple } as LearningProvider['runtime'] });
async function generationInput(capture: Awaited<ReturnType<typeof manualCapture>>) {
  const state = (await service.state(origin, null)).snapshot!;
  return { binding: origin.binding, epoch: state.epoch, expectedRevision: state.revision, requestId: randomUUID(), captureId: capture.id, captureDigest: capture.digest, correction: 'Avoid renderer filesystem calls', provider: 'test', model: 'fixed', consent: true as const };
}
const response = (data: unknown) => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(data) }], usage: { input: 100, output: 30, cost: { total: 0.01 } } });

describe('review and lifecycle authority', () => {
  it('manual drafts need no provider and approval creates immutable exact revisions', async () => {
    const { snapshot, lesson, revision } = await approved();
    const original = structuredClone(revision);
    await mutation({ action: 'save-draft', lessonId: lesson.id, content: { ...note(), title: 'A reviewed replacement' }, evidenceIds: [] });
    const pending = (await service.state(origin, null)).snapshot!;
    expect(pending.lessons[0]!.activeRevisionId).toBe(revision.id);
    expect(pending.revisions[0]).toEqual(original);
    const draft = pending.drafts.at(-1)!;
    await expect(service.mutate(origin, { action: 'approve', binding: origin.binding, epoch: snapshot.epoch, expectedRevision: snapshot.revision, id: draft.id, digest: draft.digest })).rejects.toThrow('store changed');
    await mutation({ action: 'approve', id: draft.id, digest: draft.digest });
    expect((await service.state(origin, null)).snapshot!.revisions[0]).toEqual(original);
    expect((await new LearningRepository(path.join(root, 'data')).read(learningIdentity(root, 'project'))).revisions).toHaveLength(2);
  });
  it('rejects approval for unseen content, changed evidence, or another project binding', async () => {
    await mutation({ action: 'save-draft', content: note(), evidenceIds: [] });
    const snapshot = (await service.state(origin, null)).snapshot!;
    await expect(mutation({ action: 'approve', id: snapshot.drafts[0]!.id, digest: '0'.repeat(64) })).rejects.toThrow('stale');
    await expect(service.previewEvidence(origin, { binding: { ...origin.binding, projectKey: '0'.repeat(64) }, sources: [{ kind: 'manual', text: 'bad' }] })).rejects.toThrow('changed');
    await mutation({ action: 'reject', id: snapshot.drafts[0]!.id });
    expect((await service.state(origin, null)).snapshot!.lessons).toHaveLength(0);
  });
  it('global off prevents capture and attachment while keeping deletion available', async () => {
    const { lesson, revision } = await approved();
    settings.enabled = false;
    await expect(manualCapture()).rejects.toThrow('off');
    expect(await service.prepareDispatch(origin, randomUUID(), 'filesystem renderer')).toBeNull();
    await expect(service.prepareDispatch(origin, randomUUID(), 'filesystem renderer', { binding: origin.binding, pins: [{ lessonId: lesson.id, revisionId: revision.id }], excluded: [] })).rejects.toThrow('off');
    await mutation({ action: 'delete-lesson', id: lesson.id });
    expect((await service.state(origin, null)).snapshot!.lessons).toEqual([]);
  });
  it('project and global stores never copy items on scope change', async () => {
    await approved();
    origin.binding.scope = 'global';
    expect((await service.state(origin, null)).snapshot!.lessons).toHaveLength(0);
    await approved(profile());
    const other: LearningOrigin = { ...origin, root: path.join(root, 'second'), binding: { ...origin.binding, projectKey: projectLearningKey(path.join(root, 'second')) } };
    expect((await service.state(other, null)).snapshot!.lessons).toHaveLength(1);
    origin.binding.scope = 'project';
    expect((await service.state(origin, null)).snapshot!.revisions[0]!.content.title).toBe(note().title);
  });
  it('deleting evidence blocks reuse and deleting lessons removes orphan snapshots but retains non-content manifests', async () => {
    const capture = await manualCapture();
    const { lesson, revision } = await approved(note(), capture.id);
    const turn = { binding: origin.binding, pins: [{ lessonId: lesson.id, revisionId: revision.id }], excluded: [] };
    const dispatch = await service.prepareDispatch(origin, randomUUID(), 'filesystem renderer', turn);
    expect(dispatch?.block).toContain(note().title);
    await mutation({ action: 'delete-evidence', id: capture.evidence[0]!.id });
    await expect(service.prepareDispatch(origin, randomUUID(), 'filesystem renderer', turn)).rejects.toThrow('ineligible');
    await mutation({ action: 'delete-lesson', id: lesson.id });
    const state = (await service.state(origin, null)).snapshot!;
    expect(state.revisions).toEqual([]); expect(state.evidence).toEqual([]); expect(state.drafts).toEqual([]);
    expect(JSON.stringify(state.manifests)).not.toContain(note().title);
  });
  it('marks explicitly conflicting, disabled and changed file lessons ineligible even when manually pinned', async () => {
    await fs.writeFile(path.join(root, 'source.ts'), 'export const renderer = 1;');
    const capture = await service.previewEvidence(origin, { binding: origin.binding, sources: [{ kind: 'file', path: 'source.ts', startLine: 1, endLine: 1 }] });
    const { lesson, revision } = await approved(note(), capture.id);
    const turn = { binding: origin.binding, pins: [{ lessonId: lesson.id, revisionId: revision.id }], excluded: [] };
    await mutation({ action: 'set-conflict', id: lesson.id, conflict: true });
    await expect(service.prepareDispatch(origin, randomUUID(), 'filesystem renderer', turn)).rejects.toThrow('ineligible');
    await mutation({ action: 'set-conflict', id: lesson.id, conflict: false });
    await mutation({ action: 'set-enabled', id: lesson.id, enabled: false });
    await expect(service.prepareDispatch(origin, randomUUID(), 'filesystem renderer', turn)).rejects.toThrow('ineligible');
    await mutation({ action: 'set-enabled', id: lesson.id, enabled: true });
    await fs.writeFile(path.join(root, 'source.ts'), 'changed');
    await expect(service.prepareDispatch(origin, randomUUID(), 'filesystem renderer', turn)).rejects.toThrow('ineligible');
  });
});

describe('user profile and project context layers', () => {
  it('automatically supplies both reviewed cores on a fresh unrelated turn without scope-switch copying', async () => {
    origin.binding.scope = 'global';
    const user = await approved(profile());
    await mutation({ action: 'set-mode', mode: 'automatic' });
    origin.binding.scope = 'project';
    const project = await approved(brief());
    await mutation({ action: 'set-mode', mode: 'automatic' });
    const fresh = { ...origin, binding: { ...origin.binding, sessionId: 'new-session' } };
    const result = await service.prepareDispatch(fresh, randomUUID(), 'Help me get started');
    expect(result?.manifest.items.map((item) => item.scope)).toEqual(['global', 'project']);
    expect(result?.manifest.items.map((item) => item.revisionId)).toEqual([user.revision.id, project.revision.id]);
    expect(result?.block).toContain('Give concise, direct answers.');
    expect(result?.block).toContain('An Electron workspace');
    expect(result?.manifest.contextModes).toEqual({ global: 'automatic', project: 'automatic' });
    expect((await service.state(fresh, null)).snapshot!.lessons).toHaveLength(1);
    fresh.binding.scope = 'global';
    expect((await service.state(fresh, null)).recentUse?.at(-1)?.dispatchId).toBe(result?.manifest.dispatchId);
    const otherRoot = path.join(root, 'different-repo'); await fs.mkdir(otherRoot);
    const other = { ...fresh, root: otherRoot, binding: { ...fresh.binding, projectKey: projectLearningKey(otherRoot), sessionId: 'other-session' } };
    const otherResult = await service.prepareDispatch(other, randomUUID(), 'Help me get started');
    expect(otherResult?.manifest.items.map((item) => item.revisionId)).toEqual([user.revision.id]);
    expect(otherResult?.block).not.toContain('An Electron workspace');
  });
  it('enforces type-specific scopes and one approved core per store', async () => {
    await expect(approved(profile())).rejects.toThrow('belong in GLOBAL');
    origin.binding.scope = 'global';
    await expect(approved(note())).rejects.toThrow('user coding profile');
    await approved(profile());
    await expect(approved({ ...profile(), title: 'Another profile' })).rejects.toThrow('already has a core memory');
    expect((await service.state(origin, null)).snapshot!.lessons).toHaveLength(1);
  });
  it('keeps manual defaults and each scope off gate separate from the master switch', async () => {
    origin.binding.scope = 'global';
    await approved(profile());
    expect((await service.prepareDispatch(origin, randomUUID(), 'Hello'))?.manifest.items).toEqual([]);
    await mutation({ action: 'set-mode', mode: 'automatic' });
    origin.binding.scope = 'project';
    await approved(brief()); await mutation({ action: 'set-mode', mode: 'off' });
    const result = await service.prepareDispatch(origin, randomUUID(), 'Hello');
    expect(result?.manifest.items.map((item) => item.scope)).toEqual(['global']);
    settings.enabled = false;
    expect(await service.prepareDispatch(origin, randomUUID(), 'Hello')).toBeNull();
  });
  it('lets GLOBAL and PROJECT attach independently from settings toggles', async () => {
    origin.binding.scope = 'global';
    await approved(profile());
    await mutation({ action: 'set-mode', mode: 'automatic' });
    origin.binding.scope = 'project';
    await approved(brief());
    await mutation({ action: 'set-mode', mode: 'automatic' });
    settings.project = false;
    expect((await service.prepareDispatch(origin, randomUUID(), 'Hello'))?.manifest.items.map((item) => item.scope)).toEqual(['global']);
    settings.project = true;
    settings.global = false;
    expect((await service.prepareDispatch(origin, randomUUID(), 'Hello'))?.manifest.items.map((item) => item.scope)).toEqual(['project']);
  });
  it('expires progress briefings without pretending that old work is current', async () => {
    const content = brief(); if (content.kind !== 'project-brief') throw new Error('fixture');
    content.body.currentWork = ['Implement the learning layer.'];
    const { snapshot } = await approved(content); snapshot.mode = 'automatic';
    const selected = await selectLearning({ snapshot, enabled: true, root, projectKey: origin.binding.projectKey, text: 'Help', pins: [], branch: null, now: Date.now() + 8 * 86400_000 });
    expect(selected.block).toBe(''); expect(selected.selection.skipped[0]!.reason).toContain('seven days');
  });
  it('merges proposed profile additions into a pending replacement without losing reviewed preferences', async () => {
    origin.binding.scope = 'global';
    const { lesson, revision } = await approved(profile());
    const capture = await manualCapture();
    const addition = profile(); if (addition.kind !== 'user-profile') throw new Error('fixture');
    addition.body.workflow = ['Ask before installing a dependency.'];
    const complete = vi.fn(async () => response({ outcome: 'draft', content: addition, evidenceIds: capture.evidence.map((item) => item.id), uncertainty: [] }));
    await service.generate(origin, { ...await generationInput(capture), kind: 'user-profile' }, fakeProvider(complete));
    const snapshot = (await service.state(origin, null)).snapshot!;
    expect(snapshot.lessons[0]!.activeRevisionId).toBe(revision.id);
    const draft = snapshot.drafts.at(-1)!;
    expect(draft.lessonId).toBe(lesson.id);
    expect(draft.content.kind).toBe('user-profile');
    expect(draft.content.body).toMatchObject({ workflow: ['Run checks before declaring completion.', 'Ask before installing a dependency.'] });
    expect(complete).toHaveBeenCalledOnce();
    expect(JSON.stringify(complete.mock.calls)).toContain('not infer psychological diagnoses');
  });
  it('keeps profile evidence as provenance rather than coupling user preferences to another project file', async () => {
    await fs.writeFile(path.join(root, 'source.ts'), 'user-selected evidence');
    origin.binding.scope = 'global';
    const capture = await service.previewEvidence(origin, { binding: origin.binding, sources: [{ kind: 'file', path: 'source.ts', startLine: 1, endLine: 1 }] });
    await approved(profile(), capture.id); await mutation({ action: 'set-mode', mode: 'automatic' });
    await fs.writeFile(path.join(root, 'source.ts'), 'changed source');
    const result = await service.prepareDispatch(origin, randomUUID(), 'Hello');
    expect(result?.manifest.items).toHaveLength(1);
  });
});

describe('bounded evidence and isolated generation', () => {
  it('reads exact selected branch entries without changing saved session bytes or exposing thinking', async () => {
    const manager = SessionManager.inMemory(root, { id: 'session-one' });
    const first = manager.appendMessage({ role: 'user', content: 'selected correction', timestamp: 1 });
    manager.appendMessage({ role: 'user', content: 'unrelated later turn', timestamp: 2 });
    manager.branch(first);
    const leaf = manager.appendMessage({ role: 'user', content: 'chosen branch', timestamp: 3 });
    const file = path.join(root, 'session.jsonl');
    const bytes = [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join('\n');
    await fs.writeFile(file, bytes);
    origin.session = { sessionManager: manager, sessionFile: file } as unknown as AgentSession;
    const open = vi.spyOn(fs, 'open');
    const capture = await service.previewEvidence(origin, { binding: origin.binding, sources: [{ kind: 'entry', entryId: first, leafId: leaf }, { kind: 'entry', entryId: leaf, leafId: leaf }] });
    expect(open.mock.calls.filter(([target]) => target === file)).toHaveLength(1);
    expect(capture.evidence[0]!.text).toBe('selected correction');
    expect(capture.evidence[1]!.text).toBe('chosen branch');
    expect(visibleLearningText({ content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'visible answer' }] })).toBe('visible answer');
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    const wrong = manager.getEntries().find((entry) => entry.type === 'message' && entry.message.role === 'user' && entry.message.content === 'unrelated later turn')!;
    await expect(service.previewEvidence(origin, { binding: origin.binding, sources: [{ kind: 'entry', entryId: wrong.id, leafId: leaf }] })).rejects.toThrow('exact visible');
  });
  it('redacts secrets and stores only the accepted preview', async () => {
    const capture = await service.previewEvidence(origin, { binding: origin.binding, sources: [{ kind: 'manual', text: 'token-abcdefghijklmnopqrstuvwxyz is secret. Keep main isolated.' }] });
    expect(capture.evidence[0]!.text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    const reviewed = await service.reviewCapture(origin, { binding: origin.binding, captureId: capture.id, excerpts: [{ id: capture.evidence[0]!.id, text: 'only approved source text' }] });
    expect(reviewed.digest).not.toBe(capture.digest);
    await approved(note(), capture.id);
    const state = (await service.state(origin, null)).snapshot!;
    expect(state.evidence[0]!.text).toBe('only approved source text');
    expect(state.evidence[0]!.basis).toBe('user-asserted');
    expect(JSON.stringify(state)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
  it('uses exactly the previewed model once with no tools or retries, then creates only a pending draft', async () => {
    const capture = await manualCapture();
    const complete = vi.fn(async () => response({ outcome: 'draft', content: note(), evidenceIds: capture.evidence.map((item) => item.id), uncertainty: ['A user preference, not a measured result'] }));
    await service.generate(origin, await generationInput(capture), fakeProvider(complete));
    expect(complete).toHaveBeenCalledOnce();
    const args = complete.mock.calls[0] as unknown as [unknown, { tools?: unknown; messages: unknown[] }, { maxRetries: number; signal: AbortSignal }];
    expect(args[1].tools).toBeUndefined(); expect(args[2].maxRetries).toBe(0);
    const state = (await service.state(origin, null)).snapshot!;
    expect(state.lessons).toEqual([]); expect(state.drafts[0]!.state).toBe('pending');
    expect(state.generationUsage[0]!.costUsd).toBe(0.01);
  });
  it.each([
    { outcome: 'draft', content: note(), evidenceIds: [], uncertainty: [], approved: true },
    { outcome: 'draft', content: note(), evidenceIds: [randomUUID()], uncertainty: [] },
  ])('rejects authority fields or unknown evidence without semantic repair', async (output) => {
    const capture = await manualCapture();
    const complete = vi.fn(async () => response(output));
    await expect(service.generate(origin, await generationInput(capture), fakeProvider(complete))).rejects.toThrow();
    expect(complete).toHaveBeenCalledOnce();
    expect((await service.state(origin, null)).snapshot!.drafts).toEqual([]);
  });
  it('supports no_lesson and rejects changed-preview authorization before provider use', async () => {
    const capture = await manualCapture();
    const complete = vi.fn(async () => response({ outcome: 'no_lesson', reason: 'No reusable rule' }));
    const input = await generationInput(capture);
    await service.reviewCapture(origin, { binding: origin.binding, captureId: capture.id, excerpts: [{ id: capture.evidence[0]!.id, text: 'changed text' }] });
    await expect(service.generate(origin, input, fakeProvider(complete))).rejects.toThrow('preview changed');
    expect(complete).not.toHaveBeenCalled();
    const fresh = await manualCapture();
    expect((await service.generate(origin, await generationInput(fresh), fakeProvider(complete))).outcome).toBe('no_lesson');
    expect((await service.state(origin, null)).snapshot!.drafts).toEqual([]);
  });
  it('cancellation and deletion cannot resurrect a delayed provider response', async () => {
    const capture = await manualCapture();
    let finish!: (value: unknown) => void;
    const complete = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const input = await generationInput(capture);
    const pending = service.generate(origin, input, fakeProvider(complete));
    const failed = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await mutation({ action: 'reset', confirmation: 'DELETE LEARNING' });
    finish(response({ outcome: 'draft', content: note(), evidenceIds: capture.evidence.map((item) => item.id), uncertainty: [] }));
    await failed;
    expect((await service.state(origin, null)).snapshot!.drafts).toEqual([]);
  });
});

describe('dispatch boundary, not preview or history', () => {
  it('revalidates a queued manual revision and returns the original draft when disabled', async () => {
    const { lesson, revision } = await approved();
    const adapter = new LearningContextAdapter(service, () => origin);
    const blocked = vi.fn(); const send = vi.fn();
    const dispatch = { id: randomUUID(), text: 'filesystem renderer', turn: { binding: origin.binding, pins: [{ lessonId: lesson.id, revisionId: revision.id }], excluded: [] }, blocked };
    adapter.start(dispatch.text, dispatch);
    await mutation({ action: 'set-enabled', id: lesson.id, enabled: false });
    await expect(adapter.wrap(send as never)({} as never, { messages: [] })).rejects.toThrow('ineligible');
    expect(send).not.toHaveBeenCalled(); expect(blocked).toHaveBeenCalledOnce();
  });
  it('does not block coding when the master switch is off, even if a session looks stale', async () => {
    settings.enabled = false;
    const stale = { ...origin, valid: () => false };
    const adapter = new LearningContextAdapter(service, () => stale);
    const send = vi.fn(() => ({ ok: true }));
    adapter.register({ id: randomUUID(), text: 'hello', turn: { binding: origin.binding, pins: [], excluded: [] } });
    adapter.start('hello');
    await expect(adapter.wrap(send as never)({} as never, { messages: [] }, { signal: AbortSignal.abort() })).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledOnce();
  });
  it('attaches once per turn across retries without mutating signed history and does not replay continuation/fork context', async () => {
    const { lesson, revision } = await approved();
    const adapter = new LearningContextAdapter(service, () => origin);
    const dispatch = { id: randomUUID(), text: 'filesystem renderer', turn: { binding: origin.binding, pins: [{ lessonId: lesson.id, revisionId: revision.id }], excluded: [] } };
    adapter.register(dispatch); adapter.start(dispatch.text);
    const originalMessage = { role: 'user' as const, content: 'filesystem renderer', timestamp: 1 };
    const context = { messages: [originalMessage] };
    const send = vi.fn(() => ({})); const wrapped = adapter.wrap(send as never);
    await wrapped({} as never, context); await wrapped({} as never, context);
    expect(context.messages).toEqual([originalMessage]);
    for (const call of send.mock.calls as unknown as [unknown, { messages: unknown[] }][]) expect(call[1].messages).toHaveLength(2);
    await vi.waitFor(async () => expect((await service.state(origin, null)).snapshot!.manifests[0]?.state).toBe('handed-to-runtime'));
    expect((await service.state(origin, null)).snapshot!.manifests).toHaveLength(1);
    adapter.settle(); await wrapped({} as never, context);
    expect((send.mock.calls.at(-1) as unknown as [unknown, typeof context])[1]).toBe(context);
    adapter.start('automatic length continuation'); await wrapped({} as never, context);
    expect((send.mock.calls.at(-1) as unknown as [unknown, typeof context])[1]).toBe(context);
    adapter.dispose();
    const fresh = new LearningContextAdapter(service, () => ({ ...origin, binding: { ...origin.binding, sessionId: 'forked' } }));
    await fresh.wrap(send as never)({} as never, context);
    expect((send.mock.calls.at(-1) as unknown as [unknown, typeof context])[1]).toBe(context);
  });
  it('automatic dispatch recomputes eligibility and survives optional store failures', async () => {
    const { lesson } = await approved();
    await mutation({ action: 'set-mode', mode: 'automatic' });
    expect((await service.previewSelection(origin, { binding: origin.binding, text: 'filesystem renderer', pins: [], excluded: [] })).selected).toHaveLength(1);
    await mutation({ action: 'set-enabled', id: lesson.id, enabled: false });
    const dispatch = await service.prepareDispatch(origin, randomUUID(), 'filesystem renderer');
    expect(dispatch?.block).toBe(''); expect(dispatch?.manifest.skipped[0]!.reason).toContain('disabled');
    vi.spyOn(repository, 'mutate').mockRejectedValue(new Error('locked'));
    expect(await service.prepareDispatch(origin, randomUUID(), 'filesystem renderer')).toBeNull();
  });
  it('keeps asynchronous operations bound to their origin, and checks new session manual use', async () => {
    const { lesson, revision } = await approved();
    const fresh = { ...origin, binding: { ...origin.binding, sessionId: 'fresh-session' } };
    const dispatched = await service.prepareDispatch(fresh, randomUUID(), 'filesystem renderer', { binding: fresh.binding, pins: [{ lessonId: lesson.id, revisionId: revision.id }], excluded: [] });
    expect(dispatched?.manifest.sessionId).toBe('fresh-session');
    expect(dispatched?.manifest.items[0]!.contentDigest).toBe(learningDigest({ content: revision.content, evidenceIds: revision.evidenceIds }));
    valid = false;
    await expect(service.prepareDispatch(fresh, randomUUID(), 'filesystem renderer', { binding: fresh.binding, pins: [{ lessonId: lesson.id, revisionId: revision.id }], excluded: [] })).rejects.toThrow();
  });
  it('automatic ranking rejects broad words, substring and nonmatching explicit paths', async () => {
    const { snapshot } = await approved(); snapshot.mode = 'automatic';
    const select = (text: string) => selectLearning({ snapshot, enabled: true, root, projectKey: origin.binding.projectKey, text, pins: [], branch: null });
    expect((await select('renderer')).selection.selected).toHaveLength(0);
    expect((await select('filesystem prerenderer')).selection.selected).toHaveLength(0);
    expect((await select('filesystem renderer')).selection.selected).toHaveLength(1);
    snapshot.revisions[0]!.content.activation.relativePaths = ['src/Renderer.tsx'];
    expect((await select('filesystem renderer in src/Other.tsx')).selection.selected).toHaveLength(0);
    expect((await select('Change `src/Renderer.tsx`, please')).selection.selected).toHaveLength(1);
  });
});
