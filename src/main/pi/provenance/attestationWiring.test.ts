import { AppLogService } from '../../logging/AppLogService';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionLevel } from '../../../shared/contracts/ipc';
import { createSecureWriteFile, ProjectPathPolicy } from '../PiToolPolicy';
import { sha256Hex } from './attestationRecord';
import { MutationAttestationLedger } from './MutationAttestationLedger';
import { buildChildAttestationSink, buildRootAttestationSink, createMutationRecorder } from './mutationRecorder';

async function realRoot(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(tmpdir(), 'wire-'));
  return path.normalize(await fs.realpath(tmp));
}

describe('attestation wiring through real direct write/edit tools', () => {
  let projectDir: string;
  let dataRoot: string;
  let logs: AppLogService;

  beforeEach(async () => {
    projectDir = await realRoot();
    dataRoot = await fs.mkdtemp(path.join(tmpdir(), 'wire-data-'));
    logs = new AppLogService();
  });
  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(dataRoot, { recursive: true, force: true });
  });

  async function makeWriter(attestations: Parameters<typeof createSecureWriteFile>[0]['attestations']) {
    const policy = await ProjectPathPolicy.create(projectDir, { fullAccess: false });
    return createSecureWriteFile({
      policy,
      access: { fullAccess: false },
      canonicalCwd: projectDir,
      ...(attestations ? { attestations } : {}),
    });
  }

  it('records a root actor row from a real direct write', async () => {
    const ledger = new MutationAttestationLedger(logs, dataRoot);
    const sink = buildRootAttestationSink({
      resolveSessionId: () => 'root-sess',
      resolvePermissionLevel: () => 'edit',
      hasProject: () => true,
      record: createMutationRecorder(ledger, logs),
    });
    const writeFile = await makeWriter(sink);

    await writeFile('root-file.ts', 'root-content', 'write');
    await ledger.flush();

    const result = await ledger.query({ projectPath: projectDir, limit: 10 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      actor: { kind: 'root' },
      sessionId: 'root-sess',
      permissionLevel: 'edit',
      operation: 'write',
      path: 'root-file.ts',
    });
    expect(result.rows[0]?.postHash).toBe(sha256Hex('root-content'));
  });

  it('records a legacy actor row from a real direct edit', async () => {
    await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'src', 'legacy.ts'), 'old', 'utf8');

    const ledger = new MutationAttestationLedger(logs, dataRoot);
    const handle = { sessionId: null as string | null };
    const sink = buildChildAttestationSink({
      runId: 'run-1',
      parentToolCallId: 'call-1',
      permissionLevel: 'edit',
      handle,
      record: createMutationRecorder(ledger, logs),
    })!;
    handle.sessionId = 'legacy-child-sess';
    const writeFile = await makeWriter(sink);

    await writeFile('src/legacy.ts', 'new', 'edit');
    await ledger.flush();

    const result = await ledger.query({ projectPath: projectDir, limit: 10 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      actor: { kind: 'legacy', runId: 'run-1', parentToolCallId: 'call-1' },
      sessionId: 'legacy-child-sess',
      permissionLevel: 'edit',
      operation: 'edit',
      path: 'src/legacy.ts',
      preState: 'hashed',
    });
    expect(result.rows[0]?.preHash).toBe(sha256Hex('old'));
    expect(result.rows[0]?.postHash).toBe(sha256Hex('new'));
  });

  it('records a team actor row (with current taskId) from a real direct write', async () => {
    const ledger = new MutationAttestationLedger(logs, dataRoot);
    const handle = { sessionId: null as string | null };
    const sink = buildChildAttestationSink({
      teamIdentity: { teamId: 'team-1', nodeId: 'node-1' },
      permissionLevel: 'read-only',
      handle,
      record: createMutationRecorder(ledger, logs),
      resolveCurrentTaskId: () => 'task-7',
    })!;
    handle.sessionId = 'team-child-sess';
    const writeFile = await makeWriter(sink);

    await writeFile('team-file.ts', 'team-content', 'write');
    await ledger.flush();

    const result = await ledger.query({ projectPath: projectDir, limit: 10 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      actor: { kind: 'team', teamId: 'team-1', nodeId: 'node-1', taskId: 'task-7' },
      sessionId: 'team-child-sess',
      permissionLevel: 'read-only',
      operation: 'write',
      path: 'team-file.ts',
    });
  });

  it('reflects a root permission update on the next attested write', async () => {
    const ledger = new MutationAttestationLedger(logs, dataRoot);
    let permissionLevel: PermissionLevel = 'edit';
    const sink = buildRootAttestationSink({
      resolveSessionId: () => 'root-sess',
      resolvePermissionLevel: () => permissionLevel,
      hasProject: () => true,
      record: createMutationRecorder(ledger, logs),
    });
    const writeFile = await makeWriter(sink);

    await writeFile('a.ts', 'first', 'write');
    permissionLevel = 'read-only'; // simulates setPermissionLevel before the next write
    await writeFile('b.ts', 'second', 'write');
    await ledger.flush();

    const result = await ledger.query({ projectPath: projectDir, limit: 10 });
    expect(result.rows.map((row) => row.permissionLevel)).toEqual(['edit', 'read-only']);
  });

  it('records nothing when the context resolver returns null', async () => {
    const ledger = new MutationAttestationLedger(logs, dataRoot);
    const sink = buildRootAttestationSink({
      resolveSessionId: () => null,
      resolvePermissionLevel: () => 'edit',
      hasProject: () => false, // no project open -> skip
      record: createMutationRecorder(ledger, logs),
    });
    const writeFile = await makeWriter(sink);
    await writeFile('skipped.ts', 'x', 'write');
    await ledger.flush();
    const result = await ledger.query({ projectPath: projectDir, limit: 10 });
    expect(result.rows).toHaveLength(0);
  });
});
