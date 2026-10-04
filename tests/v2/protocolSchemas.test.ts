import { describe, expect, expectTypeOf, it } from 'vitest';
import { methodCatalog, type DomainResultOf, type InputOf, type MethodName } from '../../src/shared/protocol/methods';
import { decodeRequestJson, requestEnvelopeSchema, responseEnvelopeSchema } from '../../src/shared/protocol/envelopes';
import { createMutationIdentity, createServerEpoch, MAX_REQUEST_AGE_MS, MAX_CLOCK_SKEW_MS, validateRequestClock } from '../../src/shared/protocol/requestIds';
import { safeError, safeErrorSchema } from '../../src/shared/protocol/errors';
import type { HandlerMap } from '../../src/core/dispatch/Dispatcher';

const epoch = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const requestUuid = '40000000-0000-4000-8000-000000000004';
const now = 1_800_000_000_000;
const mutation = () => ({
  protocol: 1, ...createMutationIdentity(epoch, now), method: 'runtime.prompt',
  workspaceId, workspaceGeneration: 3, expectedSessionId: sessionId,
  selectionRevision: 8, controlGeneration: 5, input: { text: 'A synthetic prompt.' },
});
const host = () => ({ protocol: 1, requestId: requestUuid, serverEpoch: epoch, issuedAt: now, method: 'host.info', input: {} });

describe('initial protocol preparation', () => {
  it('has only explicit reviewed entries with domain/wire and policy mappings', () => {
    // Exact reviewed allowlist; insertion order is not a protocol/authority boundary.
    expect(Object.keys(methodCatalog).sort()).toEqual([
      'host.info', 'workspace.list', 'workspace.snapshot', 'workspace.snapshotPage', 'workspace.monitor', 'workspace.monitorDetail',
      'control.claim', 'control.renew', 'control.release', 'control.takeover', 'permission.issue', 'permission.confirm',
      'command.status', 'file.list', 'file.previewText', 'runtime.prompt', 'runtime.abort', 'session.select', 'session.list', 'session.history', 'session.create',
      'runtime.models', 'runtime.queueRead', 'runtime.setModel', 'runtime.setThinking', 'runtime.queue',
      'goal.get', 'goal.create', 'goal.control', 'goal.update', 'goal.clear', 'goal.editSteering', 'goal.removeSteering',
      'task.list', 'task.create', 'task.update', 'task.reorder', 'task.delete', 'task.clear',
      'agent.read', 'team.read', 'agent.control', 'team.control', 'agent.workspace',
      'git.status', 'git.history', 'git.diff', 'git.combinedDiff', 'git.commitDetails', 'text.upload', 'text.cancel',
    ].sort());
    for (const descriptor of Object.values(methodCatalog)) {
      expect(descriptor.domainResultSchema).toBeDefined();
      expect(descriptor.wireResultSchema).toBeDefined();
      expect(descriptor.handlerDestination).toBeTruthy();
      expect(descriptor.authorization).toBeTruthy();
      expect(descriptor.capability).toBeTruthy();
      expect(descriptor.maxDomainBytes).toBeGreaterThan(0);
      expect(descriptor.maxWireBytes).toBeGreaterThan(0);
      expect(descriptor.maxWireBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(descriptor.name).toBe(Object.keys(methodCatalog).find((name) => methodCatalog[name as MethodName] === descriptor));
    }
    expectTypeOf<keyof HandlerMap>().toEqualTypeOf<Exclude<MethodName,
      'command.status' | 'control.claim' | 'control.renew' | 'control.release' | 'control.takeover' | 'permission.issue' | 'permission.confirm'>>();
    expectTypeOf<InputOf<'runtime.prompt'>>().toEqualTypeOf<{ text: string; attachments?: string[] | undefined; projectFiles?: string[] | undefined }>();
    expectTypeOf<DomainResultOf<'runtime.abort'>>().toEqualTypeOf<{ aborted: boolean; sessionId: string; viewRevision: number }>();
    expectTypeOf<DomainResultOf<'runtime.setModel'>>().toEqualTypeOf<{ sessionId: string; viewRevision: number }>();
    expectTypeOf<DomainResultOf<'agent.workspace'>>().toEqualTypeOf<{ sessionId: string; viewRevision: number }>();
    // The handler map is required, not a Partial or string-indexed service facade.
    expectTypeOf<Partial<HandlerMap>>().not.toExtend<HandlerMap>();
    expectTypeOf<HandlerMap['runtime.prompt']>().not.toExtend<HandlerMap['file.list']>();
  });

  it('round trips each supported discriminant', () => {
    const base = mutation();
    const approval = { ...host(), workspaceId, workspaceGeneration: 3, selectionRevision: 8, controlGeneration: 5,
      input: { sessionId, action: 'runtime.setPermission', oldLevel: 'read-only', newLevel: 'edit' } };
    const fixtures = [host(), { ...host(), method: 'workspace.list' },
      { ...host(), method: 'workspace.snapshot', workspaceId, workspaceGeneration: 3 },
      { ...host(), method: 'workspace.snapshotPage', workspaceId, workspaceGeneration: 3, input: { pageId: requestUuid } },
      { ...host(), method: 'workspace.monitor', workspaceId, workspaceGeneration: 3, expectedSessionId: sessionId,
        selectionRevision: 8, input: { section: 'runs', offset: 0, limit: 25 } },
      { ...host(), method: 'control.claim', workspaceId, workspaceGeneration: 3 },
      { ...host(), method: 'control.renew', workspaceId, workspaceGeneration: 3, input: { generation: 1 } },
      { ...host(), method: 'control.release', workspaceId, workspaceGeneration: 3, input: { generation: 1 } },
      { ...host(), method: 'control.takeover', workspaceId, workspaceGeneration: 3 },
      { ...approval, method: 'permission.issue' },
      { ...approval, ...createMutationIdentity(epoch, now), method: 'permission.confirm', input: { ...approval.input, challengeId: requestUuid } },
      { ...host(), method: 'command.status', workspaceId, workspaceGeneration: 3, input: { requestId: mutation().requestId } },
      { ...host(), method: 'file.list', workspaceId, workspaceGeneration: 3, input: { directoryId: null, limit: 20 } },
      { ...host(), method: 'file.previewText', workspaceId, workspaceGeneration: 3, input: { fileId: sessionId, maxBytes: 1024 } },
      base, { ...base, method: 'runtime.abort', input: {} },
      { ...base, method: 'session.select', expectedSessionId: null, input: { sessionId } },
    ];
    for (const fixture of fixtures) expect(requestEnvelopeSchema.parse(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture);
  });

  it.each(['constructor', '__proto__', 'runtime.getState', 'settings.get', 'runtime.setPermission', 'files.read'])('rejects uncataloged method %s', (method) => {
    expect(requestEnvelopeSchema.safeParse({ ...host(), method }).success).toBe(false);
  });

  it.each(['principalId', 'clientId', 'role', 'ownerId', 'permission', 'workspacePath', 'path', 'capability', 'confirmed', 'origin'])('rejects forged %s at envelope and input levels', (field) => {
    const base = mutation();
    expect(requestEnvelopeSchema.safeParse({ ...base, [field]: 'forged' }).success).toBe(false);
    expect(requestEnvelopeSchema.safeParse({ ...base, input: { ...base.input, [field]: 'forged' } }).success).toBe(false);
  });

  it.each(['workspaceId', 'workspaceGeneration', 'expectedSessionId', 'selectionRevision', 'controlGeneration'] as const)('requires mutation scope %s', (field) => {
    const { [field]: omitted, ...rest } = mutation();
    expect(omitted).toBeDefined();
    expect(requestEnvelopeSchema.safeParse(rest).success).toBe(false);
  });

  it('requires non-null current sessions for prompt/abort and rejects invalid generations', () => {
    const base = mutation();
    expect(requestEnvelopeSchema.safeParse({ ...base, expectedSessionId: null }).success).toBe(false);
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '3']) {
      expect(requestEnvelopeSchema.safeParse({ ...base, workspaceGeneration: invalid }).success).toBe(false);
    }
  });

  it('rejects raw paths, rich prompt inputs and unbounded text instead of forwarding desktop DTOs', () => {
    for (const value of ['/etc/passwd', 'C:\\credentials', '../secret', '\\\\server\\share']) {
      expect(requestEnvelopeSchema.safeParse({ ...host(), method: 'file.previewText', workspaceId, workspaceGeneration: 3, input: { fileId: value, maxBytes: 100 } }).success).toBe(false);
    }
    expect(requestEnvelopeSchema.safeParse({ ...mutation(), input: { text: 'x', images: [] } }).success).toBe(false);
    expect(requestEnvelopeSchema.safeParse({ ...mutation(), input: { text: 'x'.repeat(200_001) } }).success).toBe(false);
  });

  it('accepts only opaque scoped text IDs and strict supported registered relative files in the expanded prompt input', () => {
    const attachmentId = `ta1_${'x'.repeat(43)}`;
    expect(requestEnvelopeSchema.parse({ ...mutation(), input: { text: 'Context', attachments: [attachmentId], projectFiles: ['src/code.ts', 'notes.md'] } })).toMatchObject({
      method: 'runtime.prompt', input: { attachments: [attachmentId], projectFiles: ['src/code.ts', 'notes.md'] },
    });
    for (const reference of ['../outside.txt', '/private/secret.txt', 'C:/secret.txt', 'src\\notes.txt', 'image.svg', 'image.png', 'audio.mp3', 'document.pdf', 'archive.zip']) {
      expect(requestEnvelopeSchema.safeParse({ ...mutation(), input: { text: 'Context', projectFiles: [reference] } }).success).toBe(false);
    }
    expect(requestEnvelopeSchema.safeParse({ ...mutation(), input: { text: 'Context', attachments: ['/tmp/private'] } }).success).toBe(false);
    expect(requestEnvelopeSchema.safeParse({ ...mutation(), input: { text: 'Context', attachments: [attachmentId, attachmentId] } }).success).toBe(false);
  });

  it('uses random UUID epochs and immutable epoch/time/UUID mutation identities', () => {
    expect(createServerEpoch()).not.toEqual(createServerEpoch());
    const identity = createMutationIdentity(epoch, now);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(identity.requestId.length).toBeLessThanOrEqual(128);
    expect(identity.requestId.startsWith(`${epoch}.${now}.`)).toBe(true);
    expect(requestEnvelopeSchema.safeParse({ ...mutation(), ...identity }).success).toBe(true);
    expect(requestEnvelopeSchema.safeParse({ ...mutation(), ...identity, issuedAt: now + 1 }).success).toBe(false);
    expect(requestEnvelopeSchema.safeParse({ ...mutation(), ...identity, serverEpoch: workspaceId }).success).toBe(false);
    expect(requestEnvelopeSchema.safeParse({ ...mutation(), requestId: requestUuid }).success).toBe(false);
    expect(requestEnvelopeSchema.safeParse({ ...mutation(), requestId: `${epoch}.0${now}.${requestUuid}` }).success).toBe(false);
    expect(() => createMutationIdentity('not-an-epoch', now)).toThrow();
    expect(() => createMutationIdentity(epoch, 1.1)).toThrow();
  });

  it('rejects old epochs and enforces inclusive 24h age/5min skew without retimestamping retries', () => {
    const request = requestEnvelopeSchema.parse(mutation());
    expect(validateRequestClock(request, epoch, now + MAX_REQUEST_AGE_MS)).toBeNull();
    expect(validateRequestClock(request, epoch, now + MAX_REQUEST_AGE_MS + 1)).toBe('CLOCK_SKEW');
    expect(validateRequestClock(request, epoch, now - MAX_CLOCK_SKEW_MS)).toBeNull();
    expect(validateRequestClock(request, epoch, now - MAX_CLOCK_SKEW_MS - 1)).toBe('CLOCK_SKEW');
    expect(validateRequestClock(request, workspaceId, now)).toBe('SERVER_RESTARTED');
    expect(validateRequestClock(request, epoch, Number.NaN)).toBe('CLOCK_SKEW');
    expect(validateRequestClock(request, epoch, Number.POSITIVE_INFINITY)).toBe('CLOCK_SKEW');
  });

  it('checks UTF-8 body bytes before parsing and does not echo malformed IDs', () => {
    expect(decodeRequestJson('é'.repeat(600_000))).toMatchObject({ ok: false, requestId: null, code: 'INVALID_REQUEST' });
    expect(decodeRequestJson('{')).toMatchObject({ ok: false, requestId: null });
    expect(decodeRequestJson(JSON.stringify({ ...host(), protocol: 2 }))).toMatchObject({ ok: false, requestId: requestUuid, code: 'PROTOCOL_MISMATCH' });
    expect(decodeRequestJson(JSON.stringify({ ...host(), requestId: 'a'.repeat(129) }))).toMatchObject({ ok: false, requestId: null });
  });

  it('validates fixed error messages, results and compact non-journaled receipts', () => {
    expect(safeErrorSchema.safeParse(safeError('FORBIDDEN')).success).toBe(true);
    expect(safeErrorSchema.safeParse({ ...safeError('FORBIDDEN'), message: 'provider-secret-sentinel' }).success).toBe(false);
    const base = mutation();
    const receipt = { kind: 'prompt', requestId: base.requestId, durability: 'not-journaled', outcome: 'accepted', sessionId, runId: requestUuid, viewRevision: 9 };
    const response = { protocol: 1, ok: true, requestId: base.requestId, serverEpoch: epoch, scope: { workspaceId, workspaceGeneration: 3 }, method: 'runtime.prompt', result: receipt };
    expect(responseEnvelopeSchema.safeParse(response).success).toBe(true);
    expect(responseEnvelopeSchema.safeParse({ ...response, result: { ...receipt, runtimeState: {} } }).success).toBe(false);
    expect(responseEnvelopeSchema.safeParse({ ...response, result: { ...receipt, requestId: createMutationIdentity(epoch, now).requestId } }).success).toBe(false);
    expect(responseEnvelopeSchema.safeParse({ ...response, result: { ...receipt, durability: 'durable' } }).success).toBe(false);
    expect(responseEnvelopeSchema.safeParse({ ...response, scope: { workspaceId, workspaceGeneration: 3, path: '/private' } }).success).toBe(false);
    expect(responseEnvelopeSchema.safeParse({ ...response, method: 'runtime.abort' }).success).toBe(false);
  });
});
