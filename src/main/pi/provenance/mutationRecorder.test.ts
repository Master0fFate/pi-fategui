import { AppLogService } from '../../logging/AppLogService';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionLevel } from '../../../shared/contracts/ipc';
import type { AttestationRecordInput } from './attestationRecord';
import { sha256Hex } from './attestationRecord';
import { MutationAttestationLedger } from './MutationAttestationLedger';
import { buildChildAttestationSink, buildRootAttestationSink, createMutationRecorder } from './mutationRecorder';

const PROJECT_ROOT = path.sep === '/' ? '/project' : 'C:\\project';

describe('createMutationRecorder', () => {
  let root: string;
  let logs: AppLogService;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'rec-'));
    logs = new AppLogService();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const facts = (overrides: Partial<AttestationRecordInput> = {}): AttestationRecordInput => ({
    operation: 'write',
    projectRoot: PROJECT_ROOT,
    targetPath: path.join(PROJECT_ROOT, 'src/a.ts'),
    content: 'hello',
    preHash: null,
    preState: 'missing',
    actor: { kind: 'root' },
    sessionId: 'sess-1',
    permissionLevel: 'edit',
    ...overrides,
  });

  it('builds, validates, and enqueues an attestation', async () => {
    const ledger = new MutationAttestationLedger(logs, root);
    createMutationRecorder(ledger, logs)(facts());
    await ledger.flush();
    const result = await ledger.query({ projectPath: PROJECT_ROOT, limit: 10 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ actor: { kind: 'root' }, sessionId: 'sess-1', path: 'src/a.ts' });
    expect(result.rows[0]?.postHash).toBe(sha256Hex('hello'));
  });

  it('skips silently when the target is outside the project', async () => {
    const ledger = new MutationAttestationLedger(logs, root);
    const spy = vi.spyOn(ledger, 'record');
    createMutationRecorder(ledger, logs)(facts({ targetPath: path.join(path.dirname(PROJECT_ROOT) || '/elsewhere', 'escape.ts') }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('logs and swallows a ledger failure so the successful tool write is unaffected', async () => {
    const logsSpy = vi.spyOn(logs, 'write');
    const failing = { record: vi.fn().mockRejectedValue(new Error('disk full')) } as unknown as MutationAttestationLedger;
    expect(() => createMutationRecorder(failing, logs)(facts())).not.toThrow();
    await Promise.resolve();
    expect(logsSpy).toHaveBeenCalledWith('warn', 'attestations', expect.stringContaining('disk full'));
  });
});

describe('buildRootAttestationSink', () => {
  it('resolves a root actor with the live session id and tracked permission level', () => {
    let sessionId = 'root-sess';
    let permissionLevel: PermissionLevel = 'edit';
    const sink = buildRootAttestationSink({
      resolveSessionId: () => sessionId,
      resolvePermissionLevel: () => permissionLevel,
      hasProject: () => true,
      record: vi.fn(),
    });
    expect(sink.resolveContext()).toEqual({ actor: { kind: 'root' }, sessionId: 'root-sess', permissionLevel: 'edit' });

    // Permission changes (e.g. after setPermissionLevel) are reflected on the next write.
    permissionLevel = 'full-access';
    sessionId = 'root-sess-2';
    expect(sink.resolveContext()).toEqual({ actor: { kind: 'root' }, sessionId: 'root-sess-2', permissionLevel: 'full-access' });
  });

  it('skips when no project is open', () => {
    const sink = buildRootAttestationSink({ resolveSessionId: () => 's', resolvePermissionLevel: () => 'edit', hasProject: () => false, record: vi.fn() });
    expect(sink.resolveContext()).toBeNull();
  });
});

describe('buildChildAttestationSink', () => {
  it('builds a legacy actor from runId/parentToolCallId and the child session id', () => {
    const handle = { sessionId: null as string | null };
    const sink = buildChildAttestationSink({ runId: 'run-1', parentToolCallId: 'call-1', permissionLevel: 'edit', handle, record: vi.fn() })!;
    expect(sink).toBeDefined();
    handle.sessionId = 'child-sess';
    expect(sink.resolveContext()).toEqual({
      actor: { kind: 'legacy', runId: 'run-1', parentToolCallId: 'call-1' },
      sessionId: 'child-sess',
      permissionLevel: 'edit',
    });
  });

  it('honors a legacy permission resolver: null when the run is gone, static only without a resolver', () => {
    const handle = { sessionId: 'legacy-sess' } as { sessionId: string | null };
    // With a resolver that returns null (run gone), permission is null, not the launch-time level.
    const gone = buildChildAttestationSink({ runId: 'run-gone', parentToolCallId: 'call-1', permissionLevel: 'edit', handle, record: vi.fn(), resolvePermissionLevel: () => null })!;
    expect(gone.resolveContext()).toMatchObject({ permissionLevel: null });
    // With a resolver returning a live capped level, it is used verbatim.
    let live: PermissionLevel | null = 'read-only';
    const dynamic = buildChildAttestationSink({ runId: 'run-live', parentToolCallId: 'call-2', permissionLevel: 'edit', handle, record: vi.fn(), resolvePermissionLevel: () => live })!;
    expect(dynamic.resolveContext()?.permissionLevel).toBe('read-only');
    live = null; // a later cap/remove removes authority at write time
    expect(dynamic.resolveContext()?.permissionLevel).toBeNull();
    // Without a resolver, the static launch-time level is used (legacy default).
    const staticLegacy = buildChildAttestationSink({ runId: 'run-static', parentToolCallId: 'call-3', permissionLevel: 'full-access', handle, record: vi.fn() })!;
    expect(staticLegacy.resolveContext()?.permissionLevel).toBe('full-access');
  });

  it('builds a team actor and resolves taskId dynamically (sessions are reused across tasks)', () => {
    const handle = { sessionId: null as string | null };
    let currentTask = 'task-1';
    const sink = buildChildAttestationSink({
      teamIdentity: { teamId: 'team-1', nodeId: 'node-1' },
      permissionLevel: 'read-only',
      handle,
      record: vi.fn(),
      resolveCurrentTaskId: () => currentTask,
    })!;
    handle.sessionId = 'child-sess';
    expect(sink.resolveContext()?.actor).toEqual({ kind: 'team', teamId: 'team-1', nodeId: 'node-1', taskId: 'task-1' });

    currentTask = 'task-2'; // same session, next task
    expect(sink.resolveContext()?.actor).toEqual({ kind: 'team', teamId: 'team-1', nodeId: 'node-1', taskId: 'task-2' });
  });

  it('omits taskId when no task is currently assigned', () => {
    const sink = buildChildAttestationSink({
      teamIdentity: { teamId: 'team-1', nodeId: 'node-1' },
      permissionLevel: 'read-only',
      handle: { sessionId: null },
      record: vi.fn(),
      resolveCurrentTaskId: () => undefined,
    })!;
    expect(sink.resolveContext()?.actor).toEqual({ kind: 'team', teamId: 'team-1', nodeId: 'node-1' });
  });

  it('records permission=null when the dynamic resolver returns null (node gone), not the launch-time level', () => {
    // A resolver that returns null means the node is gone; the row records
    // permission=null instead of falling back to the launch-time level.
    const sink = buildChildAttestationSink({
      teamIdentity: { teamId: 'team-1', nodeId: 'node-1' },
      permissionLevel: 'edit',
      handle: { sessionId: 'team-sess' },
      record: vi.fn(),
      resolvePermissionLevel: () => null,
    })!;
    expect(sink.resolveContext()).toMatchObject({ permissionLevel: null });

    // When the resolver returns a live level, it is used verbatim.
    let live: PermissionLevel | null = 'read-only';
    const dynamic = buildChildAttestationSink({
      teamIdentity: { teamId: 'team-2', nodeId: 'node-2' },
      permissionLevel: 'edit',
      handle: { sessionId: 'team-sess' },
      record: vi.fn(),
      resolvePermissionLevel: () => live,
    })!;
    expect(dynamic.resolveContext()?.permissionLevel).toBe('read-only');
    live = null;
    expect(dynamic.resolveContext()?.permissionLevel).toBeNull();
  });

  it('uses the static launch-time level only when no resolver is supplied (legacy team path)', () => {
    const sink = buildChildAttestationSink({
      teamIdentity: { teamId: 'team-1', nodeId: 'node-1' },
      permissionLevel: 'full-access',
      handle: { sessionId: 'team-sess' },
      record: vi.fn(),
    })!;
    expect(sink.resolveContext()?.permissionLevel).toBe('full-access');
  });

  it('returns undefined when no truthful identity is available', () => {
    expect(buildChildAttestationSink({ permissionLevel: 'edit', handle: { sessionId: null }, record: vi.fn() })).toBeUndefined();
  });
});
