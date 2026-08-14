import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { PiDesktopError } from './errors';
import { createSecureWriteFile, ProjectPathPolicy, writeAllPositioned, type PositionedFileHandle, type ProjectToolAccess } from './PiToolPolicy';
import { buildAttestation, sha256Hex, type AttestationRecordInput, type AttestationSink } from './provenance/attestationRecord';

const ROOT_ACTOR = { kind: 'root' as const };

function makeSink(captured: AttestationRecordInput[]): AttestationSink {
  return {
    resolveContext: () => ({ actor: ROOT_ACTOR, sessionId: 'sess-1', permissionLevel: 'edit' }),
    record: (input) => captured.push(input),
  };
}

async function realRoot(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(tmpdir(), 'policy-'));
  return path.normalize(await fs.realpath(tmp));
}

describe('createSecureWriteFile attestation hook', () => {
  let projectDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    projectDir = await realRoot();
    outsideDir = await realRoot();
  });
  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  async function makeWriter(access: ProjectToolAccess, sink?: AttestationSink, maxPreHashBytes?: number) {
    const policy = await ProjectPathPolicy.create(projectDir, access);
    return createSecureWriteFile({ policy, access, canonicalCwd: projectDir, ...(sink ? { attestations: sink } : {}), ...(maxPreHashBytes !== undefined ? { maxPreHashBytes } : {}) });
  }

  it('records a new-file write with a missing pre-state and exact post hash', async () => {
    const captured: AttestationRecordInput[] = [];
    const writeFile = await makeWriter({ fullAccess: false }, makeSink(captured));

    await writeFile('new.txt', 'hello', 'write');

    expect(await fs.readFile(path.join(projectDir, 'new.txt'), 'utf8')).toBe('hello');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ operation: 'write', preState: 'missing', preHash: null, content: 'hello' });
    expect(buildAttestation(captured[0]!)!.postHash).toBe(sha256Hex('hello'));
    expect(buildAttestation(captured[0]!)!.path).toBe('new.txt');
  });

  it('records an edit with the hashed prior state and the new post hash', async () => {
    await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'src', 'old.ts'), 'old', 'utf8');
    const captured: AttestationRecordInput[] = [];
    const writeFile = await makeWriter({ fullAccess: false }, makeSink(captured));

    await writeFile('src/old.ts', 'new', 'edit');

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ operation: 'edit', preState: 'hashed', content: 'new' });
    expect(captured[0]!.preHash).toBe(sha256Hex('old'));
    expect(buildAttestation(captured[0]!)!.postHash).toBe(sha256Hex('new'));
  });

  it('records oversize prior state without reading it unbounded', async () => {
    await fs.writeFile(path.join(projectDir, 'big.txt'), '0123456789', 'utf8'); // 10 bytes
    const captured: AttestationRecordInput[] = [];
    const writeFile = await makeWriter({ fullAccess: false }, makeSink(captured), 4);

    await writeFile('big.txt', 'x', 'write');

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ preState: 'oversize', preHash: null });
  });

  it('records nothing when the linked/replacement defense refuses the write', async () => {
    await fs.writeFile(path.join(projectDir, 'orig.txt'), 'orig', 'utf8');
    await fs.link(path.join(projectDir, 'orig.txt'), path.join(projectDir, 'link.txt')); // nlink === 2
    const captured: AttestationRecordInput[] = [];
    const writeFile = await makeWriter({ fullAccess: false }, makeSink(captured));

    await expect(writeFile('link.txt', 'x', 'write')).rejects.toThrow(PiDesktopError);
    expect(captured).toHaveLength(0);
  });

  it('records nothing for a full-access write outside the active project', async () => {
    const captured: AttestationRecordInput[] = [];
    const writeFile = await makeWriter({ fullAccess: true }, makeSink(captured));
    const outsideTarget = path.join(outsideDir, 'outside.txt');

    await writeFile(outsideTarget, 'x', 'write');

    expect(await fs.readFile(outsideTarget, 'utf8')).toBe('x'); // still written
    expect(captured).toHaveLength(0);
  });

  it('records a full-access write that lands inside the active project', async () => {
    const captured: AttestationRecordInput[] = [];
    const writeFile = await makeWriter({ fullAccess: true }, makeSink(captured));

    await writeFile('inside.txt', 'x', 'write');

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ operation: 'write', preState: 'missing' });
    expect(buildAttestation(captured[0]!)!.path).toBe('inside.txt');
  });

  it('emits nothing when no sink is provided (preserves existing callers)', async () => {
    const writeFile = await makeWriter({ fullAccess: false });
    await writeFile('plain.txt', 'x', 'write'); // must not throw
    expect(await fs.readFile(path.join(projectDir, 'plain.txt'), 'utf8')).toBe('x');
  });

  it('skips attestation when the context resolver returns null', async () => {
    const captured: AttestationRecordInput[] = [];
    const sink: AttestationSink = {
      resolveContext: () => null,
      record: (input) => captured.push(input),
    };
    const writeFile = await makeWriter({ fullAccess: false }, sink);
    await writeFile('skipped.txt', 'x', 'write');
    expect(captured).toHaveLength(0);
  });

  it('records nothing when the real bash executor mutates the project', async () => {
    const { createProjectConfinedTools } = await import('./PiToolPolicy');
    const captured: AttestationRecordInput[] = [];
    // Wire the sink exactly as production does for the controlled write/edit tools.
    await createProjectConfinedTools(projectDir, { fullAccess: false }, [], { attestations: makeSink(captured) });
    // The real SDK bash executor (default child_process spawn). exposeSessionEnvironment:false
    // avoids needing a live session context; that flag only affects env vars passed to spawn,
    // not whether the controlled write choke point is involved.
    const bash = createBashToolDefinition(projectDir, { exposeSessionEnvironment: false });
    const target = path.join(projectDir, 'bash-only.txt');
    try {
      await bash.execute('bash', { command: `node -e "require('node:fs').writeFileSync('bash-only.txt','x')"` }, undefined, undefined, {} as never);
    } catch {
      // Cross-platform shell quoting can stop the one-liner from running here; the
      // mock-exec test below proves the guarantee unconditionally on every platform.
      return;
    }
    if (!existsSync(target)) return; // command did not create the file on this platform
    expect(await fs.readFile(target, 'utf8')).toBe('x');
    expect(captured).toHaveLength(0);
  });

  it('skips attestation for a full-access symlink that escapes the project', async () => {
    await fs.writeFile(path.join(outsideDir, 'escape.txt'), 'outside', 'utf8');
    let symlinkMade = false;
    try {
      await fs.symlink(path.join(outsideDir, 'escape.txt'), path.join(projectDir, 'link.txt'));
      symlinkMade = true;
    } catch {
      // Symlink creation needs elevated privileges on some Windows setups; skip there.
    }
    if (!symlinkMade) return;

    const captured: AttestationRecordInput[] = [];
    const writeFile = await makeWriter({ fullAccess: true }, makeSink(captured));
    await writeFile('link.txt', 'x', 'write');

    expect(await fs.readFile(path.join(outsideDir, 'escape.txt'), 'utf8')).toBe('x'); // written through the link
    expect(captured).toHaveLength(0); // but not attested: the real path is outside the project
  });

  it('preserves the original O_WRONLY path for write-only files when no sink is wired (POSIX)', async () => {
    if (process.platform === 'win32') return; // mode bits are not meaningful on Windows
    const target = path.join(projectDir, 'wo.txt');
    await fs.writeFile(target, 'old', { mode: 0o600 });
    await fs.chmod(target, 0o200); // write-only owner
    const writeFile = await makeWriter({ fullAccess: false }); // no sink -> original O_WRONLY flow
    await writeFile('wo.txt', 'new', 'write');
    await fs.chmod(target, 0o600); // restore so the test can read it back
    expect(await fs.readFile(target, 'utf8')).toBe('new');
  });

  it('falls back to the original O_WRONLY write (no attestation) for a write-only file when a sink is wired (POSIX)', async () => {
    if (process.platform === 'win32') return; // mode bits are not meaningful on Windows
    const target = path.join(projectDir, 'wo-sink.txt');
    await fs.writeFile(target, 'old', { mode: 0o600 });
    await fs.chmod(target, 0o200); // write-only owner rejects O_RDWR with EACCES
    const captured: AttestationRecordInput[] = [];
    const writeFile = await makeWriter({ fullAccess: false }, makeSink(captured)); // sink wired
    await writeFile('wo-sink.txt', 'new', 'write');
    await fs.chmod(target, 0o600); // restore so the test can read it back
    expect(await fs.readFile(target, 'utf8')).toBe('new');
    expect(captured).toHaveLength(0); // the write-only file is written but not attested
  });

  it('full-access writes a linked in-project file plainly and emits no row, while project-confined still refuses it', async () => {
    await fs.writeFile(path.join(projectDir, 'orig.txt'), 'orig', 'utf8');
    let linked = false;
    try {
      await fs.link(path.join(projectDir, 'orig.txt'), path.join(projectDir, 'link.txt')); // nlink === 2
      linked = true;
    } catch {
      // Hard-link creation needs elevated privileges on some Windows setups; skip there.
    }
    if (!linked) return;

    // Full-access + sink: the previously allowed plain write is preserved; no row is emitted.
    const capturedFull: AttestationRecordInput[] = [];
    const fullWriter = await makeWriter({ fullAccess: true }, makeSink(capturedFull));
    await fullWriter('link.txt', 'linked', 'write');
    expect(await fs.readFile(path.join(projectDir, 'link.txt'), 'utf8')).toBe('linked');
    expect(capturedFull).toHaveLength(0);

    // Project-confined + sink: the linked file is still refused.
    const capturedConfined: AttestationRecordInput[] = [];
    const confinedWriter = await makeWriter({ fullAccess: false }, makeSink(capturedConfined));
    await expect(confinedWriter('link.txt', 'denied', 'write')).rejects.toThrow(PiDesktopError);
    expect(capturedConfined).toHaveLength(0);
  });

  it('records nothing when the bash tool mutates the project', async () => {
    const { createProjectConfinedTools } = await import('./PiToolPolicy');
    const captured: AttestationRecordInput[] = [];
    // Wire the sink to the controlled write/edit tools.
    await createProjectConfinedTools(projectDir, { fullAccess: false }, [], { attestations: makeSink(captured) });
    // The bash tool mutates through its own exec and bypasses secureWriteFile.
    const exec = vi.fn(async (_command: string, _cwd: string, options: { onData: (data: Buffer) => void }) => {
      await fs.writeFile(path.join(projectDir, 'bash-created.txt'), 'bash');
      options.onData(Buffer.from('ok'));
      return { exitCode: 0 };
    });
    const bash = createBashToolDefinition(projectDir, { operations: { exec }, exposeSessionEnvironment: false });
    await bash.execute('bash', { command: 'echo bash > bash-created.txt' }, undefined, undefined, {} as never);

    expect(await fs.readFile(path.join(projectDir, 'bash-created.txt'), 'utf8')).toBe('bash');
    expect(captured).toHaveLength(0);
  });
});

describe('writeAllPositioned', () => {
  it('loops across partial writes, advancing offset and position until the buffer is flushed', async () => {
    const buffer = Buffer.from('hello-world-data', 'utf8');
    const calls: { offset: number; length: number; position: number }[] = [];
    const handle: PositionedFileHandle = {
      write: async (_buffer, offset, length, position) => {
        calls.push({ offset, length, position });
        return { bytesWritten: 1 }; // simulate one-byte-at-a-time partial writes
      },
    };

    await writeAllPositioned(handle, buffer);

    expect(calls).toHaveLength(buffer.length);
    expect(calls[0]).toEqual({ offset: 0, length: buffer.length, position: 0 });
    expect(calls[1]).toEqual({ offset: 1, length: buffer.length - 1, position: 1 });
    expect(calls.at(-1)).toEqual({ offset: buffer.length - 1, length: 1, position: buffer.length - 1 });
  });

  it('completes without writing for an empty buffer', async () => {
    let calls = 0;
    const handle: PositionedFileHandle = { write: async () => { calls += 1; return { bytesWritten: 0 }; } };
    await writeAllPositioned(handle, Buffer.alloc(0));
    expect(calls).toBe(0);
  });

  it('throws instead of looping forever when no progress can be made', async () => {
    const handle: PositionedFileHandle = { write: async () => ({ bytesWritten: 0 }) };
    await expect(writeAllPositioned(handle, Buffer.from('x'))).rejects.toThrow();
  });
});
