import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLogService } from '../logging/AppLogService';

const ptyMock = vi.hoisted(() => {
  const state: { onData: ((data: string) => void) | undefined; onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined } = { onData: undefined, onExit: undefined };
  const handle = {
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: vi.fn((callback: (data: string) => void) => { state.onData = callback; return { dispose: vi.fn() }; }),
    onExit: vi.fn((callback: (event: { exitCode: number; signal?: number }) => void) => { state.onExit = callback; return { dispose: vi.fn() }; }),
  };
  return { state, handle, spawn: vi.fn(() => handle) };
});

vi.mock('node-pty', () => ({ spawn: ptyMock.spawn }));

import { TerminalService } from './TerminalService';

function createService(trusted = true) {
  const logs = new AppLogService();
  const service = new TerminalService(
    { getRoot: () => 'C:/project' } as never,
    { getState: () => ({ project: trusted ? { trusted: true } : null }) } as never,
    { get: () => ({ terminalShell: 'pwsh.exe' }) } as never,
    logs,
  );
  return { service, logs };
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
});
