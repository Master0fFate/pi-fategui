import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthenticatedServerContext } from '../../src/core/dispatch/RequestContext';
import { WorkspaceEventHub } from '../../src/core/events/WorkspaceEventHub';
import { ScopedDomainEvents } from '../../src/core/events/ScopedDomainEvents';
import { WorkspaceAdmissionQueue } from '../../src/core/workspaces/WorkspaceAdmissionQueue';
import { TextAttachmentStore } from '../../src/core/attachments/TextAttachmentStore';
import { CommandJournal } from '../../src/core/commands/CommandJournal';
import { FilesystemService } from '../../src/main/files/FilesystemService';
import type { FateCore } from '../../src/core/FateCore';
import type { WorkspaceHandle } from '../../src/core/workspaces/WorkspaceHandle';
import type { ClientTickets } from '../../src/server/auth/ClientTickets';
import { createNetworkDispatcher } from '../../src/server/http/NetworkDispatcher';
import { requestEnvelopeSchema, responseEnvelopeSchema } from '../../src/shared/protocol/envelopes';
import { createMutationIdentity } from '../../src/shared/protocol/requestIds';
import { TEXT_ATTACHMENT_BYTES } from '../../src/shared/protocol/attachments';

const epoch = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const principalId = '40000000-0000-4000-8000-000000000004';
const clientId = '50000000-0000-4000-8000-000000000005';
const requestId = '60000000-0000-4000-8000-000000000006';
const runId = '70000000-0000-4000-8000-000000000007';
const now = 1_800_000_000_000;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function fixture() {
  const privateRoot = await mkdtemp(path.join(tmpdir(), 'fate-text-protocol-'));
  cleanup.push(() => rm(privateRoot, { recursive: true, force: true, maxRetries: 3 }));
  const project = path.join(privateRoot, 'project');
  await mkdir(project);
  const files = await FilesystemService.forRoot(project);
  const root = files.getRoot();
  let time = now;
  const store = await TextAttachmentStore.open(path.join(privateRoot, 'attachments'), () => time);
  cleanup.push(() => store.close());
  let selected = sessionId;
  const state = () => ({ sessionId: selected, project: { path: root, trusted: true }, permissionLevel: 'read-only' as const,
    error: null, sessionOperation: false, models: [], sessions: [{ id: sessionId }], eventCursor: 0 });
  const prompt = vi.fn(async (input: { text: string }, _a: boolean, _b: boolean, _unused: undefined, guard: () => void) => {
    guard(); return { accepted: true, runId };
  });
  const runtime = { getState: state, prompt };
  const admission = new WorkspaceAdmissionQueue(runtime, 3);
  const handle = { id: workspaceId, generation: 3, root, files, runtime, admission } as unknown as WorkspaceHandle;
  const core = { events: new WorkspaceEventHub(new ScopedDomainEvents(), epoch), workspaces: { resolve: () => handle }, runtime: { workspaceOrigin: () => ({ workspaceId, workspaceGeneration: 3 }),
    peekWorkspace: () => runtime }, sessionPermissions: { assertHealthy: () => undefined } } as unknown as FateCore;
  let live = true;
  const identity = createAuthenticatedServerContext({ principalId, clientId, expiresAt: now + 3600_000 }, null);
  const foreign = createAuthenticatedServerContext({ principalId, clientId: '80000000-0000-4000-8000-000000000008', expiresAt: now + 3600_000 }, null);
  const tickets = { isLive: () => live, isMember: (_identity: unknown, candidate: string) => live && candidate === root } as unknown as ClientTickets;
  const journal = new CommandJournal({ root: path.join(privateRoot, 'journal'), serverEpoch: epoch, now: () => time });
  const service = createNetworkDispatcher({ core, tickets, journal, registeredRoots: [root], hostId: principalId,
    appVersion: '1.0.0', serverEpoch: epoch, textAttachments: store, now: () => time });
  const read = (method: string, input: object = {}, extra: object = {}) => ({ protocol: 1, requestId, serverEpoch: epoch, issuedAt: time,
    workspaceId, workspaceGeneration: 3, expectedSessionId: selected, selectionRevision: admission.snapshot().selectionRevision, method, input, ...extra });
  const dispatch = (value: object, owner = identity) => service.dispatcher.dispatchJson(JSON.stringify(value), owner);
  const upload = async (text: string) => {
    const response = await dispatch(read('text.upload', { name: 'notes.txt', contentType: 'text/plain', encoding: 'base64', data: Buffer.from(text).toString('base64') }));
    if (!response.ok || response.method !== 'text.upload') throw new Error('Expected uploaded text');
    return response.result;
  };
  const claim = async () => {
    const response = await dispatch({ protocol: 1, requestId, serverEpoch: epoch, issuedAt: time, workspaceId, workspaceGeneration: 3, method: 'control.claim', input: {} });
    if (!response.ok || response.method !== 'control.claim') throw new Error('Expected control');
    return response.result.generation;
  };
  const mutation = (input: object, controlGeneration: number) => read('runtime.prompt', input,
    { ...createMutationIdentity(epoch, time), controlGeneration });
  return { root, store, prompt, read, dispatch, upload, claim, mutation, foreign,
    expire: () => { time += 300_001; }, revoke: () => { live = false; },
    switchSession: () => { selected = '90000000-0000-4000-8000-000000000009'; admission.observeSelection(selected); } };
}

describe('T40 named authenticated text protocol (fake prompt, no provider)', () => {
  it('rejects raw host paths, media, duplicate IDs, invalid Unicode and excessive reference counts before prompt admission', () => {
    const base = { protocol: 1, ...createMutationIdentity(epoch, now), workspaceId, workspaceGeneration: 3,
      expectedSessionId: sessionId, selectionRevision: 0, controlGeneration: 1, method: 'runtime.prompt' };
    for (const input of [ { text: 'x', projectFiles: ['/etc/passwd'] }, { text: 'x', projectFiles: ['C:\\secret.txt'] },
      { text: 'x', projectFiles: ['../private'] }, { text: 'x', projectFiles: ['dir/../file'] },
      { text: 'x', projectFiles: ['dir\\file'] }, { text: 'x', projectFiles: Array(9).fill('a') },
      ...['image.svg', 'image.png', 'document.pdf', 'audio.mp3', 'unknown.bin', 'archive.zip'].map((file) => ({ text: 'x', projectFiles: [file] })),
      { text: '\ud800' }, { text: 'x', images: [] }, { text: 'x', url: 'https://example.test/private' },
      { text: 'x', attachments: [`ta1_${'a'.repeat(43)}`, `ta1_${'a'.repeat(43)}`] } ]) {
      expect(requestEnvelopeSchema.safeParse({ ...base, input }).success).toBe(false);
    }
  });
  it('uploads and resolves only opaque IDs/project-relative text, consumes only a confirmed admission, and deduplicates the original prompt', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'context.txt'), 'project context');
    const uploaded = await f.upload('uploaded context');
    expect(JSON.stringify(uploaded)).not.toContain(f.root);
    expect(JSON.stringify(uploaded)).not.toContain('uploaded context');
    const generation = await f.claim();
    const original = f.mutation({ text: 'Inspect', attachments: [uploaded.attachmentId], projectFiles: ['context.txt'] }, generation);
    const result = await f.dispatch(original);
    expect(result).toMatchObject({ ok: true, method: 'runtime.prompt', result: { durability: 'journaled', kind: 'prompt', outcome: 'accepted' } });
    expect(responseEnvelopeSchema.safeParse(result).success).toBe(true);
    expect(f.prompt).toHaveBeenCalledOnce();
    expect(f.prompt.mock.calls[0]?.[0].text).toContain('uploaded context');
    expect(f.prompt.mock.calls[0]?.[0].text).toContain('project context');
    expect(await readdir(f.store.directory)).toEqual([]);
    expect(await readFile(path.join(f.root, 'context.txt'), 'utf8')).toBe('project context');
    expect(await f.dispatch(original)).toEqual(result);
    expect(f.prompt).toHaveBeenCalledOnce();
  });
  it('denies foreign-client cancellation/consumption, stale selected session, expired upload and malformed UTF-8', async () => {
    const f = await fixture();
    const id = (await f.upload('owner only')).attachmentId;
    expect(await f.dispatch(f.read('text.cancel', { attachmentId: id }), f.foreign)).toMatchObject({ ok: false });
    expect(await readdir(f.store.directory)).toHaveLength(1);
    const generation = await f.claim();
    const old = f.mutation({ text: 'Inspect', attachments: [id] }, generation);
    f.switchSession();
    expect(await f.dispatch(old)).toMatchObject({ ok: false, error: { code: 'STALE_SESSION' } });
    expect(f.prompt).not.toHaveBeenCalled();
    const g = await fixture();
    expect(await g.dispatch(g.read('text.upload', { contentType: 'text/plain', encoding: 'base64', data: '/w==' }))).toMatchObject({ ok: false });
    const expired = (await g.upload('expires')).attachmentId;
    g.expire();
    await g.store.sweepExpired();
    expect(await readdir(g.store.directory)).toEqual([]);
    expect(await g.dispatch(g.read('text.cancel', { attachmentId: expired }))).toMatchObject({ ok: false });
    expect(g.prompt).not.toHaveBeenCalled();
  });
  it('cancels a draft without deleting project files and refuses oversized text before prompt admission', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'keep.txt'), 'do not delete');
    const receipt = await f.upload('draft');
    expect(await f.dispatch(f.read('text.cancel', { attachmentId: receipt.attachmentId }))).toMatchObject({ ok: true, result: { canceled: true } });
    expect(await readdir(f.store.directory)).toEqual([]);
    expect(await readFile(path.join(f.root, 'keep.txt'), 'utf8')).toBe('do not delete');
    const tooLarge = Buffer.from('x'.repeat(TEXT_ATTACHMENT_BYTES + 1)).toString('base64');
    expect(await f.dispatch(f.read('text.upload', { contentType: 'text/plain', encoding: 'base64', data: tooLarge }))).toMatchObject({ ok: false });
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it('rejects a project symlink escape and invalid UTF-8 project bytes without reading them into Pi', async () => {
    const f = await fixture();
    const outside = path.join(path.dirname(f.root), 'outside');
    await mkdir(outside); await writeFile(path.join(outside, 'private.txt'), 'FAKE_PRIVATE_SENTINEL');
    await symlink(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const generation = await f.claim();
    expect(await f.dispatch(f.mutation({ text: 'Read', projectFiles: ['linked/private.txt'] }, generation))).toMatchObject({ ok: false });
    await writeFile(path.join(f.root, 'invalid.txt'), Buffer.from([0xff]));
    expect(await f.dispatch(f.mutation({ text: 'Read', projectFiles: ['invalid.txt'] }, generation))).toMatchObject({ ok: false });
    expect(f.prompt).not.toHaveBeenCalled();
    expect(await readFile(path.join(outside, 'private.txt'), 'utf8')).toBe('FAKE_PRIVATE_SENTINEL');
  });
});
