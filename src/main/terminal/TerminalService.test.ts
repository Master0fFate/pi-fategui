import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLogService } from '../logging/AppLogService';

const ptyMock = vi.hoisted(() => {
  const state = {
    onData: undefined as ((data: string) => void) | undefined,
    onExit: undefined as ((event: { exitCode: number; signal?: number }) => void) | undefined,
    dataDispose: vi.fn(),
    exitDispose: vi.fn(),
  };
  const handle = {
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    onData: vi.fn((callback: (data: string) => void) => { state.onData = callback; return { dispose: state.dataDispose }; }),
    onExit: vi.fn((callback: (event: { exitCode: number; signal?: number }) => void) => { state.onExit = callback; return { dispose: state.exitDispose }; }),
  };
  return { state, handle, spawn: vi.fn(() => handle) };
});

vi.mock('node-pty', () => ({ spawn: ptyMock.spawn }));

import { defaultShellCandidates, smokeTerminalRuntime, TerminalService } from './TerminalService';

describe('defaultShellCandidates', () => {
  it('prefers the newest installed PowerShell on Windows with cmd as the floor', () => {
    expect(defaultShellCandidates('win32', { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' })).toEqual([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
    ]);
  });

  it('falls back to the Windows PowerShell and cmd floors when the environment is sparse', () => {
    const ladder = defaultShellCandidates('win32', {});
    expect(ladder).toContain('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(ladder.at(-1)).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('uses the login shell on macOS and Linux', () => {
    expect(defaultShellCandidates('darwin', { SHELL: '/opt/homebrew/bin/fish' })[0]).toBe('/opt/homebrew/bin/fish');
    expect(defaultShellCandidates('linux', {})).toEqual(['/bin/bash', '/bin/bash', '/bin/zsh']);
  });
});

function createService(trusted = true) {
  const logs = new AppLogService();
  let project = trusted ? { path: 'C:/project', trusted: true } : null;
  const service = new TerminalService(
    { getRoot: () => 'C:/project' } as never,
    { getState: () => ({ project }) } as never,
    { get: () => ({ terminalShell: 'pwsh.exe' }) } as never,
    logs,
    (configured) => configured || 'pwsh.exe',
  );
  return { service, logs, setProject: (next: typeof project) => { project = next; } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
    ptyMock.state.onData = undefined;
    ptyMock.state.onExit = undefined;
});

describe('TerminalService', () => {
  it('requires a trusted project', () => {
    expect(() => createService(false).service.create(1, 80, 24)).toThrow(/trust a project/i);
    expect(ptyMock.spawn).not.toHaveBeenCalled();
  });

  it('smokes the host default shell through a real PTY-shaped exchange', async () => {
    const pending = smokeTerminalRuntime(process.cwd());
    const command = ptyMock.handle.write.mock.calls.at(-1)?.[0] as string;
    const marker = command.match(/FATE_PTY_SMOKE_[a-f0-9]+/u)?.[0];
    expect(marker).toBeTruthy();
    ptyMock.state.onData?.(`${marker}\r\n`);
    ptyMock.state.onExit?.({ exitCode: 0 });

    await expect(pending).resolves.toEqual(expect.any(String));
    expect(ptyMock.spawn).toHaveBeenCalledWith(expect.any(String), [], expect.objectContaining({ cwd: process.cwd(), cols: 80, rows: 24 }));
    expect(ptyMock.state.dataDispose).toHaveBeenCalledOnce();
    expect(ptyMock.state.exitDispose).toHaveBeenCalledOnce();
  });

  it('owns PTYs per renderer and batches output before exit', () => {
    const { service, logs } = createService();
    const events: unknown[] = [];
    service.setEventSink((ownerId, event) => events.push({ ownerId, ...event }));

    const terminal = service.create(7, 100, 30);
    expect(ptyMock.spawn).toHaveBeenCalledWith('pwsh.exe', [], expect.objectContaining({ cwd: 'C:/project', cols: 100, rows: 30 }));

    service.write(7, terminal.id, 'echo ok\r');
    service.resize(7, terminal.id, 120, 40);
    expect(ptyMock.handle.write).toHaveBeenCalledWith('echo ok\r');
    expect(ptyMock.handle.resize).toHaveBeenCalledWith(120, 40);
    expect(() => service.write(8, terminal.id, 'denied')).toThrow(/unavailable/i);

    ptyMock.state.onData?.('PI_PTY_OK');
    vi.advanceTimersByTime(16);
    expect(events).toContainEqual({ ownerId: 7, type: 'data', id: terminal.id, data: 'PI_PTY_OK' });

    ptyMock.state.onExit?.({ exitCode: 0 });
    expect(events).toContainEqual({ ownerId: 7, type: 'exit', id: terminal.id, exitCode: 0 });
    expect(() => service.resize(7, terminal.id, 80, 24)).toThrow(/unavailable/i);
    expect(logs.list().map((entry) => entry.message)).toEqual(expect.arrayContaining([expect.stringContaining('started'), expect.stringContaining('exited')]));
  });

  it('pauses noisy PTYs until renderer acknowledgements drain the bounded queue', () => {
    const { service } = createService();
    const events: Array<{ type?: string; data?: string }> = [];
    service.setEventSink((_ownerId, event) => events.push(event));
    const terminal = service.create(7, 80, 24);

    ptyMock.state.onData?.('x'.repeat(900_000));
    expect(ptyMock.handle.pause).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === 'data')).toHaveLength(4);
    for (let index = 0; index < 20; index += 1) service.acknowledge(7, terminal.id, 65_536);
    vi.runOnlyPendingTimers();
    for (let index = 0; index < 20; index += 1) service.acknowledge(7, terminal.id, 65_536);

    expect(ptyMock.handle.resume).toHaveBeenCalled();
    expect(events.every((event) => event.data === undefined || event.data.length <= 65_536)).toBe(true);
  });

  it('closes idempotently and suppresses late PTY events', () => {
    const { service } = createService();
    const events: unknown[] = [];
    service.setEventSink((_ownerId, event) => events.push(event));
    const terminal = service.create(7, 80, 24);
    const lateData = ptyMock.state.onData;
    const lateExit = ptyMock.state.onExit;

    service.close(7, terminal.id);
    service.close(7, terminal.id);
    lateData?.('late');
    lateExit?.({ exitCode: 0 });

    expect(ptyMock.handle.kill).toHaveBeenCalledOnce();
    expect(ptyMock.state.dataDispose).toHaveBeenCalledOnce();
    expect(ptyMock.state.exitDispose).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
  });

  it('closes terminals whose project authority has changed', () => {
    const { service, setProject } = createService();
    const terminal = service.create(7, 80, 24);
    setProject({ path: 'C:/other', trusted: true });

    expect(() => service.write(7, terminal.id, 'denied')).toThrow(/different project/i);
    expect(ptyMock.handle.kill).toHaveBeenCalledOnce();
  });

  it('closes all terminals before a project transition', () => {
    const { service } = createService();
    service.create(7, 80, 24);
    service.disposeProjectTerminals();
    expect(ptyMock.handle.kill).toHaveBeenCalledOnce();
  });
});
