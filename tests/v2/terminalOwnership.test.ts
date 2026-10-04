import path from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
const nodeExecutable = path.isAbsolute(process.execPath) ? process.execPath : (process.env.PATH ?? '').split(path.delimiter)
  .filter((directory) => path.isAbsolute(directory)).map((directory) => path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'))
  .find((candidate) => existsSync(candidate));
if (!nodeExecutable) throw new Error('The fixture requires an absolute Node executable.');
const canonicalNodeExecutable = realpathSync(nodeExecutable);
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthenticatedServerContext, createLocalIpcContext } from '../../src/core/dispatch/RequestContext';
import { TerminalOwner } from '../../src/core/terminal/TerminalOwner';
import type { WorkspaceRegistry } from '../../src/core/workspaces/WorkspaceRegistry';
import type { WorkspaceControl } from '../../src/core/security/WorkspaceControl';

const pty = vi.hoisted(() => {
  let data: ((value: string) => void) | undefined;
  const process = { write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(),
    onData: vi.fn((callback: (value: string) => void) => { data = callback; return { dispose: vi.fn() }; }),
    onExit: vi.fn(() => ({ dispose: vi.fn() })) };
  return { process, spawn: vi.fn(() => process), load: vi.fn(), emit: (value: string) => data?.(value) };
});
vi.mock('node-pty', () => { pty.load(); return { spawn: pty.spawn }; });

const workspaceId = '20000000-0000-4000-8000-000000000002';
const principalId = '40000000-0000-4000-8000-000000000004';
const a = createAuthenticatedServerContext({ principalId, clientId: '50000000-0000-4000-8000-000000000005', expiresAt: Date.now() + 600_000 }, null);
const b = createAuthenticatedServerContext({ principalId, clientId: '60000000-0000-4000-8000-000000000006', expiresAt: Date.now() + 600_000 }, null);
const local = createLocalIpcContext({ principalId, clientId: a.clientId, expiresAt: Date.now() + 600_000 });
const events: Array<{ type: string; sequence?: number; data?: string }> = [];
let root = process.cwd();
let hasControl = true;
let permission: 'read-only' | 'edit' = 'edit';
let enabled = true;
function owner(shell = canonicalNodeExecutable) {
  return new TerminalOwner({ enabled,
    registry: { resolve: (context: typeof a, id: string, generation: number) => {
      if (id !== workspaceId || generation !== 1 || context === b) throw new Error('Workspace membership required.');
      return { root };
    } } as unknown as WorkspaceRegistry,
    control: { hasControl: (context: typeof a, id: string, generation: number) => hasControl && context === a && id === workspaceId && generation === 4 } as unknown as WorkspaceControl,
    permission: () => permission, resolveShell: () => shell,
    loadPty: () => import('node-pty'), send: (_identity, event) => events.push(event),
  });
}
afterEach(() => {
  vi.useRealTimers(); vi.clearAllMocks(); events.length = 0; root = process.cwd(); hasControl = true; permission = 'edit'; enabled = true;
});

describe('host manual terminal ownership', () => {
  it('defaults off without importing node-pty; denies local desktop contexts and read-only clients', async () => {
    enabled = false;
    await expect(owner().create(a, workspaceId, 1, 4, 80, 24)).rejects.toThrow(/disabled/);
    expect(pty.load).not.toHaveBeenCalled();
    enabled = true;
    await expect(owner().create(local, workspaceId, 1, 4, 80, 24)).rejects.toThrow(/authenticated network/i);
    permission = 'read-only';
    await expect(owner().create(a, workspaceId, 1, 4, 80, 24)).rejects.toThrow(/read-only/i);
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  it('uses the host registry root; rejects guessing, other clients, and changed control/root', async () => {
    const service = owner();
    const created = await service.create(a, workspaceId, 1, 4, 80, 24);
    expect(created.cwd).toBe(process.cwd());
    expect(created.warning).toMatch(/unsandboxed shell/);
    expect(pty.spawn).toHaveBeenCalledWith(expect.any(String), [], expect.objectContaining({ cwd: process.cwd() }));
    expect(() => service.write(b, created.id, 'bad')).toThrow(/unavailable/);
    expect(() => service.write(a, '00000000-0000-4000-8000-000000000000', 'bad')).toThrow(/unavailable/);
    expect(pty.process.write).not.toHaveBeenCalled();
    service.write(a, created.id, 'ok');
    expect(pty.process.write).toHaveBeenCalledWith('ok');
    hasControl = false;
    expect(() => service.write(a, created.id, 'bad')).toThrow(/control/);
    expect(pty.process.kill).toHaveBeenCalledOnce();
    hasControl = true;
    const next = await service.create(a, workspaceId, 1, 4, 80, 24);
    root = process.platform === 'win32' ? 'C:\\another-root' : '/another-root';
    expect(() => service.write(a, next.id, 'bad')).toThrow(/root changed/);
  });

  it.skipIf(process.platform !== 'win32')('disables registry AutoRun for the installed Windows command shell', async () => {
    const shell = realpathSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'));
    const service = owner(shell);
    try {
      await service.create(a, workspaceId, 1, 4, 80, 24);
      expect(pty.spawn).toHaveBeenCalledWith(shell, ['/d'], expect.objectContaining({ cwd: process.cwd() }));
    } finally { service.dispose(); }
  });

  it('drops the late frames of a session that ended by a real exit, and still refuses a guessed one', async () => {
    const service = owner();
    const terminal = await service.create(a, workspaceId, 1, 4, 80, 24);
    pty.emit('last output');
    // The shell exits. The acknowledgement of its last output, a key and a close are already on the wire.
    const exit = (pty.process.onExit.mock.calls as unknown as Array<[(event: { exitCode: number }) => void]>)[0]![0];
    exit({ exitCode: 0 });
    expect(events.at(-1)).toMatchObject({ type: 'exit', id: terminal.id });
    pty.process.write.mockClear(); pty.process.resize.mockClear(); pty.process.kill.mockClear();
    expect(() => service.acknowledge(a, terminal.id, 1, 11)).not.toThrow();
    expect(() => service.write(a, terminal.id, 'x')).not.toThrow();
    expect(() => service.resize(a, terminal.id, 100, 30)).not.toThrow();
    expect(() => service.close(a, terminal.id)).not.toThrow();
    expect(pty.process.write).not.toHaveBeenCalled();
    expect(pty.process.resize).not.toHaveBeenCalled();
    expect(pty.process.kill).not.toHaveBeenCalled();
    // Another client, and an identifier that never was a session, are still refused.
    expect(() => service.acknowledge(b, terminal.id, 1, 1)).toThrow(/unavailable/);
    expect(() => service.write(a, '00000000-0000-4000-8000-000000000000', 'x')).toThrow(/unavailable/);
    expect(() => service.close(a, '00000000-0000-4000-8000-000000000000')).toThrow(/unavailable/);
    // The slot is free again for the same controller.
    await expect(service.create(a, workspaceId, 1, 4, 80, 24)).resolves.toMatchObject({ cwd: process.cwd() });
  });

  it('closes immediately on disconnect and never replays input on a replacement ticket', async () => {
    const service = owner();
    const terminal = await service.create(a, workspaceId, 1, 4, 80, 24);
    service.write(a, terminal.id, 'once');
    service.disconnect(a);
    expect(pty.process.kill).toHaveBeenCalledOnce();
    const reissued = createAuthenticatedServerContext({ principalId, clientId: a.clientId, expiresAt: Date.now() + 600_000 }, null);
    expect(() => service.write(reissued, terminal.id, 'again')).toThrow(/unavailable/);
    expect(pty.process.write).toHaveBeenCalledTimes(1);
  });

  it('does not grant output credit for duplicate, guessed, or oversized acknowledgments', async () => {
    const service = owner();
    const terminal = await service.create(a, workspaceId, 1, 4, 80, 24);
    pty.emit('x'.repeat(900_000));
    expect(pty.process.pause).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === 'data')).toHaveLength(4);
    const first = events[0]!;
    service.acknowledge(a, terminal.id, first.sequence!, 1_000_000);
    service.acknowledge(a, terminal.id, 999, 65_536);
    expect(events.filter((event) => event.type === 'data')).toHaveLength(4);
    service.acknowledge(a, terminal.id, first.sequence!, first.data!.length);
    service.acknowledge(a, terminal.id, first.sequence!, first.data!.length);
    expect(events.filter((event) => event.type === 'data').length).toBeGreaterThan(4);
    expect(pty.process.resume).not.toHaveBeenCalled();
    service.dispose();
  });
});
