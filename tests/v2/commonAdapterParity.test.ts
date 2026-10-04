import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpCommandTransport, UnconfirmedCommand } from '../../src/client/HttpCommandTransport';
import { PiDesktopError } from '../../src/main/pi/errors';
import { abortResultSchema, promptAcceptanceSchema, runtimeStateSchema } from '../../src/shared/contracts/ipc';
import { monitorDashboardSchema } from '../../src/shared/contracts/monitorDashboard';
import { networkMonitorSchema } from '../../src/shared/protocol/diagnostics';
import { requestEnvelopeSchema, responseEnvelopeSchema, type ProtocolResponse } from '../../src/shared/protocol/envelopes';
import { ProtocolFault, safeError } from '../../src/shared/protocol/errors';
import { MAX_RESULT_BYTES, methodCatalog } from '../../src/shared/protocol/methods';
import { createMutationIdentity } from '../../src/shared/protocol/requestIds';
import {
  commonAdapterParityCases, parityIds, parityMonitorQuery, parityPrivateDetail, paritySentinels, parityText, parityTime,
  type ParityFailure, type ParityMethod,
} from './fixtures/commonAdapterParityCases';
import { createCommonAdapterParityHarness, type CommonAdapterParityHarness, type ParityInvocation } from './helpers/commonAdapterParityHarness';

function checkWire(f: CommonAdapterParityHarness, response: ProtocolResponse) {
  expect(responseEnvelopeSchema.safeParse(response).success).toBe(true);
  const json = JSON.stringify(response);
  expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  for (const privateValue of [f.root, f.otherRoot, parityPrivateDetail, 'private-task-id']) {
    expect(json).not.toContain(privateValue);
    expect(json).not.toContain(JSON.stringify(privateValue).slice(1, -1)); // Also catch JSON-escaped Windows paths.
  }
  if (response.ok) {
    expect(Buffer.byteLength(JSON.stringify(response.result))).toBeLessThanOrEqual(methodCatalog[response.method].maxWireBytes);
    expect(response.scope).toEqual({ workspaceId: parityIds.workspace, workspaceGeneration: 3 });
  } else expect(response.error).toEqual(safeError(response.error.code));
}

function checkFailure(f: CommonAdapterParityHarness, actual: ParityInvocation, expected: ParityFailure) {
  if (actual.ok) throw new Error('Expected an adapter refusal, not a successful result');
  switch (expected.source) {
    case 'zod':
      expect(actual.error).toBeInstanceOf(z.ZodError);
      if (!(actual.error instanceof z.ZodError)) throw new Error('Expected structured validation issues');
      expect(actual.error.issues.length).toBeGreaterThan(0);
      break;
    case 'desktop':
      expect(actual.error).toBeInstanceOf(PiDesktopError);
      if (!(actual.error instanceof PiDesktopError)) throw new Error('Expected a structured native error');
      expect(actual.error.normalized).toMatchObject({ code: expected.code, retryable: expected.retryable });
      break;
    case 'fault':
      expect(actual.error).toBeInstanceOf(ProtocolFault);
      expect(actual.error).toMatchObject({ code: expected.code });
      expect(actual.response).toBeUndefined(); // Ticket verification rejects before dispatcher entry.
      break;
    case 'native':
      expect(actual.error).toBe(f.nativeFailure); // IPC preserves the existing native exception, not a fake receipt.
      break;
    case 'wire':
      expect(actual.response).toMatchObject({ ok: false, error: safeError(expected.code), execution: expected.execution,
        operationId: expected.execution === 'unknown' ? actual.request?.requestId : null });
      break;
  }
}

/** Project only fields the two contracts actually share. A network receipt is NOT
 * the full RuntimeState, and a redacted Monitor row is NOT a desktop title/ref. */
function normalizedOutcome(f: CommonAdapterParityHarness, method: ParityMethod, actual: ParityInvocation): object {
  if (!actual.ok) return { outcome: f.calls.length === 0 ? 'rejected-before-runtime'
    : method === 'workspace.monitor' ? 'read-withheld' : 'mutation-unconfirmed' };
  if (f.mode === 'http') {
    const response = actual.response;
    if (!response?.ok || response.method !== method) throw new Error('Expected the production wire response for this method');
    switch (response.method) {
      case 'runtime.prompt': return { accepted: response.result.outcome === 'accepted', runId: response.result.runId };
      case 'runtime.abort': return { aborted: response.result.outcome === 'abort-reported' };
      case 'session.select': return { sessionId: response.result.sessionId, selectionRevision: response.result.selectionRevision };
      case 'workspace.monitor': return monitorProjection(networkMonitorSchema.parse(response.result));
      default: throw new Error('No broader desktop/network parity is claimed here');
    }
  }
  switch (method) {
    case 'runtime.prompt': return promptAcceptanceSchema.parse(actual.value);
    case 'runtime.abort': return abortResultSchema.parse(actual.value);
    case 'session.select': return { sessionId: runtimeStateSchema.parse(actual.value).sessionId,
      selectionRevision: f.selection().selectionRevision };
    case 'workspace.monitor': return monitorProjection(monitorDashboardSchema.parse(actual.value));
  }
}
function monitorProjection(value: z.infer<typeof monitorDashboardSchema> | z.infer<typeof networkMonitorSchema>) {
  const { sessionId, section, offset, limit, total, unchanged, checkedAt, overall, sources, sourceCheckedAt, counts, items } = value;
  return { sessionId, section, offset, limit, total, unchanged, checkedAt, overall, sources, sourceCheckedAt, counts,
    items: items.map(({ source, state, updatedAt }) => ({ source, state, updatedAt })) };
}

async function withNetwork(run: (f: CommonAdapterParityHarness) => Promise<void>, observer = false) {
  const f = await createCommonAdapterParityHarness('http', observer ? { setup: 'no-authority' } : {});
  try { await run(f); } finally { await f.dispose(); }
}

describe('T34 one common positive/negative table through production IPC and HTTP command adapters', () => {
  it.each(commonAdapterParityCases)('$name', async (row) => {
    const observations: object[] = [];
    // Each adapter receives an independent copy of the same deterministic runtime
    // state. Do not let a previous adapter's selection/write supply a false pass.
    for (const mode of ['ipc', 'http'] as const) {
      const f = await createCommonAdapterParityHarness(mode, row);
      try {
        const actual = await f.invoke(row.method, row.input);
        if (actual.response) {
          checkWire(f, actual.response);
          expect(actual.response.requestId).toBe(actual.request?.requestId);
          expect(actual.response.serverEpoch).toBe(parityIds.epoch);
        }
        const failure = row.failures?.[mode];
        if (failure) checkFailure(f, actual, failure);
        else expect(actual.ok).toBe(true);
        const result = normalizedOutcome(f, row.method, actual);
        if (row.result) expect(result).toEqual(row.result);
        else expect(result).toEqual({ outcome: row.calls === 0 ? 'rejected-before-runtime'
          : row.method === 'workspace.monitor' ? 'read-withheld' : 'mutation-unconfirmed' });
        const state = await f.snapshot();
        expect(state).toMatchObject({
          a: row.text ?? paritySentinels.a, b: paritySentinels.b,
          selectedSessionId: row.selectedSession ?? parityIds.session, selectionRevision: row.selectionRevision ?? 0,
          running: row.running ?? true,
          workspaceGeneration: row.setup === 'changed-generation' || row.setup === 'monitor-generation-race' ? 4 : 3,
        });
        const input = row.method === 'runtime.prompt' ? { text: parityText, behavior: 'prompt' }
          : row.method === 'workspace.monitor' ? parityMonitorQuery : row.input;
        const expectedCall = { method: row.method, workspaceId: parityIds.workspace, sessionId: parityIds.session, input };
        expect(state.calls).toEqual(row.calls ? [expectedCall] : []);
        expect(state.effects).toEqual(row.effects ? [expectedCall] : []);
        if (mode === 'http' && row.method !== 'workspace.monitor') {
          const requestId = actual.request?.requestId;
          if (typeof requestId !== 'string') throw new Error('Every attempted network mutation has an original ID');
          const status = await f.journal.status(requestId, parityIds.workspace, parityIds.principal);
          if (row.calls === 0) expect(status).toEqual({ state: 'absent', receipt: null, rejectionCode: null });
          else if (actual.ok) {
            expect(status).toEqual({ state: 'settled', receipt: actual.value, rejectionCode: null });
            expect(actual.value).toMatchObject({ requestId, durability: 'journaled' });
          } else expect(status).toEqual({ state: 'outcome_unknown', receipt: null, rejectionCode: null });
        }
        observations.push({ result, state });
      } finally { await f.dispose(); }
    }
    expect(observations[0]).toEqual(observations[1]); // Domain outcome AND actual effects/no-effects, not just two successful mocks.
  });
});

describe('T34 explicitly network-only authority, envelopes and delivery (not desktop API requirements)', () => {
  it('uses real principal/origin-bound tickets, rejecting forgeries before the runtime', async () => {
    await withNetwork(async (f) => {
      const original = f.envelope('runtime.prompt', { text: parityText });
      const before = await f.snapshot();
      for (const attempt of [
        () => f.send(original, ''),
        () => f.send(original, 'forged-ticket'),
        () => f.send(original, f.ticket(), { ...f.principal, principalId: randomUUID() }),
        () => f.send(original, f.ticket(), f.principal, 'http://127.0.0.1:47500'),
      ]) await expect(attempt()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(await f.snapshot()).toEqual(before);
    });
  });

  it('rejects extra identity/authority fields, unknown methods, protocol mismatch and foreign scope with no effects', async () => {
    await withNetwork(async (f) => {
      const original = f.envelope('runtime.prompt', { text: parityText });
      const before = await f.snapshot();
      const attempts = [
        { request: { ...original, clientId: parityIds.connection }, code: 'INVALID_REQUEST' },
        { request: { ...original, principalId: parityIds.principal }, code: 'INVALID_REQUEST' },
        { request: { ...original, confirmed: true, permissionLevel: 'full-access' }, code: 'INVALID_REQUEST' },
        { request: { ...original, projectPath: f.otherRoot }, code: 'INVALID_REQUEST' },
        { request: { ...original, method: 'shell.exec' }, code: 'INVALID_REQUEST' },
        { request: { ...original, protocol: 2 }, code: 'PROTOCOL_MISMATCH' },
        { request: { ...original, workspaceId: parityIds.foreignWorkspace }, code: 'FORBIDDEN' },
        { request: { ...original, ...createMutationIdentity(randomUUID(), parityTime) }, code: 'SERVER_RESTARTED' },
        { request: { ...original, issuedAt: parityTime + 1 }, code: 'INVALID_REQUEST' },
      ] as const;
      for (const { request, code } of attempts) {
        const response = await f.send(request);
        checkWire(f, response);
        expect(response).toMatchObject({ ok: false, error: { code }, execution: 'not-started', operationId: null });
        expect(await f.snapshot()).toEqual(before);
      }
    });
  });

  it('starts as observer and requires a real control claim; the claim does not raise host permission or repair storage', async () => {
    await withNetwork(async (f) => {
      const original = f.envelope('runtime.prompt', { text: parityText });
      const before = await f.snapshot();
      expect(await f.send(original)).toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' }, execution: 'not-started' });
      await f.claim();
      f.setPermission('full-access'); // A saved runtime value cannot raise this host's default edit cap.
      expect(await f.send(original)).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' }, execution: 'not-started' });
      f.setPermission('edit');
      f.blockPermissionStore();
      expect(await f.send(original)).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' }, execution: 'not-started' });
      expect(await f.snapshot()).toEqual(before);
      const stop = await f.send(f.envelope('runtime.abort', {}));
      checkWire(f, stop);
      expect(stop).toMatchObject({ ok: true, result: { kind: 'abort', outcome: 'abort-reported' } });
      expect(f.calls.map((call) => call.method)).toEqual(['runtime.abort']);
    }, true);
  });

  it('concurrent duplicate IDs share one real journaled effect; a conflicting payload cannot replay it', async () => {
    await withNetwork(async (f) => {
      const original = f.envelope('runtime.prompt', { text: parityText });
      const [first, duplicate] = await Promise.all([f.send(original), f.send(original)]);
      checkWire(f, first); checkWire(f, duplicate);
      expect(first).toMatchObject({ ok: true, result: { kind: 'prompt', outcome: 'accepted', durability: 'journaled' } });
      expect(duplicate).toEqual(first);
      const after = await f.snapshot();
      expect(after.calls).toHaveLength(1); expect(after.effects).toHaveLength(1);
      expect(after.a).toBe(`applied:${parityText}\n`); expect(after.b).toBe(paritySentinels.b);
      const conflict = await f.send({ ...original, input: { text: 'Different action under the SAME original ID' } });
      checkWire(f, conflict);
      expect(conflict).toMatchObject({ ok: false, error: { code: 'REQUEST_CONFLICT' }, execution: 'not-started' });
      const status = await f.send(f.readEnvelope('command.status', { requestId: original.requestId }));
      checkWire(f, status);
      expect(status).toMatchObject({ ok: true, result: { state: 'settled' } });
      if (!first.ok || !status.ok || status.method !== 'command.status') throw new Error('Expected retained receipt');
      expect(status.result.receipt).toEqual(first.result);
      expect(await f.snapshot()).toEqual(after);
    });
  });

  it('client response loss queries the original ID through the real route, never submits another prompt', async () => {
    await withNetwork(async (f) => {
      const requests: unknown[] = [];
      // Node v2 deliberately blocks ALL sockets. Inject only the fetch I/O seam:
      // each body/ticket goes through the production command route; every response
      // comes from its real dispatcher/journal. No manufactured successful receipt.
      const send: typeof fetch = async (url, init) => {
        expect(url).toBe('http://127.0.0.1:47500/api/command');
        expect(init?.method).toBe('POST');
        if (!init || typeof init.body !== 'string') throw new Error('Expected a serialized command body');
        const body: unknown = JSON.parse(init.body);
        requests.push(body);
        const request = requestEnvelopeSchema.parse(body);
        const ticket = new Headers(init.headers).get('x-fate-client-ticket');
        if (!ticket) throw new Error('Missing production client ticket header');
        const response = await f.network.onCommand(init.body, f.principal, ticket, null);
        checkWire(f, response);
        if (request.method === 'runtime.prompt') throw new Error('Synthetic loss AFTER actual route/journal settlement');
        return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
      };
      const client = new HttpCommandTransport('http://127.0.0.1:47500', () => ({}), f.ticket, send);
      const original = requestEnvelopeSchema.parse(f.envelope('runtime.prompt', { text: parityText }));
      if (original.method !== 'runtime.prompt') throw new Error('Expected a typed prompt');
      let lost: unknown;
      try { await client.commandWithStatus(original); } catch (error) { lost = error; }
      expect(lost).toBeInstanceOf(UnconfirmedCommand);
      if (!(lost instanceof UnconfirmedCommand)) throw new Error('Response loss must remain unconfirmed to the caller');
      expect(lost.requestId).toBe(original.requestId);
      expect(lost.status).toMatchObject({ ok: true, method: 'command.status', result: { state: 'settled', receipt: {
        requestId: original.requestId, kind: 'prompt', outcome: 'accepted', runId: parityIds.run,
      } } });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual(original);
      expect(requests[1]).toMatchObject({ method: 'command.status', input: { requestId: original.requestId } });
      expect(f.calls).toHaveLength(1); expect(f.effects).toHaveLength(1);
      expect(await f.snapshot()).toMatchObject({ a: `applied:${parityText}\n`, b: paritySentinels.b });
    });
  });

  it('disconnect after runtime admission fences delivery while reconnect status retains the original effect', async () => {
    await withNetwork(async (f) => {
      f.afterEffect(f.disconnect);
      const original = f.envelope('runtime.prompt', { text: parityText });
      const disconnected = await f.send(original);
      checkWire(f, disconnected);
      expect(disconnected).toMatchObject({ ok: false, requestId: original.requestId,
        error: { code: 'UNAUTHENTICATED' }, execution: 'unknown', operationId: original.requestId });
      const after = await f.snapshot();
      expect(after.calls).toHaveLength(1); expect(after.effects).toHaveLength(1);
      await expect(f.send(original)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      f.reconnect(); // New verified event ticket, same principal. No replacement mutation ID and no implicit control claim.
      const status = await f.send(f.readEnvelope('command.status', { requestId: original.requestId }));
      checkWire(f, status);
      expect(status).toMatchObject({ ok: true, result: { state: 'settled', receipt: {
        requestId: original.requestId, outcome: 'accepted', runId: parityIds.run,
      } } });
      const duplicate = await f.send(original);
      checkWire(f, duplicate);
      expect(duplicate).toMatchObject({ ok: true, result: { requestId: original.requestId, outcome: 'accepted' } });
      expect(await f.snapshot()).toEqual(after);
    });
  });
});
