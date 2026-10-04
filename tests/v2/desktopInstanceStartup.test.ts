import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OwnershipConflict } from '../../src/core/ownership/OwnerLock';
import { desktopStartupExitCode, desktopStartupFailure } from '../../src/main/bootstrap/startupFailure';
import { ShutdownCoordinator } from '../../src/main/bootstrap/shutdown';
import { acquireInstanceProfile, isMultiInstanceProbe } from '../../src/main/instanceProfile';
import { parseConnectionProfile, parseForwardedProjectPath } from '../../src/main/launchProject';

// Pure host policy/metadata tests: no Electron, filesystem writer, SDK session,
// real credential, product process or operating-system shutdown is created.
describe('desktop primary ignores multi-instance slot probes', () => {
  it('classifies --new-instance before project/connection forwarding, even without metadata', () => {
    const argv = ['fate-ui', '--new-instance', '--project', 'private fixture', '--connection-profile=fixture'];
    expect(isMultiInstanceProbe(argv, undefined)).toBe(true);
    expect(isMultiInstanceProbe(argv, { mode: 'single' })).toBe(true);
  });

  it('classifies every environment-only multi slot probe using acquisition metadata', () => {
    const probes: Record<string, unknown>[] = [];
    const project = path.resolve('private-fixture/project with spaces');
    const profile = acquireInstanceProfile({
      getPath: () => path.resolve('private-fixture/chromium'),
      setPath: () => undefined,
      requestSingleInstanceLock: (data) => {
        probes.push(data ?? {});
        return probes.length === 3;
      },
    }, 'multi', () => undefined, project);
    expect(profile.slot).toBe(3);
    expect(probes).toEqual([
      { instanceSlot: 1, mode: 'multi' },
      { instanceSlot: 2, mode: 'multi' },
      { instanceSlot: 3, mode: 'multi' },
    ]);
    for (const probe of probes) {
      // FATE_NEW_INSTANCE=1 need not occur in the forwarded argv.
      expect(isMultiInstanceProbe(['fate-ui', '--project', project], probe)).toBe(true);
    }
  });

  it('keeps ordinary single-instance project metadata and forwarding with spaces', () => {
    const cwd = path.resolve('private-fixture');
    const project = path.resolve(cwd, 'zażółć 日本語 project');
    const requestSingleInstanceLock = vi.fn((_data?: Record<string, unknown>) => false);
    const profile = acquireInstanceProfile({
      getPath: () => path.join(cwd, 'chromium'),
      setPath: () => undefined,
      requestSingleInstanceLock,
    }, 'single', () => undefined, project);
    const data = requestSingleInstanceLock.mock.calls[0]?.[0];
    expect(profile).toMatchObject({ slot: 1, mode: 'single', isPrimary: false });
    expect(data).toEqual({ instanceSlot: 1, mode: 'single', projectPath: project });
    const argv = ['fate-ui', '--project', '--chromium-inserted-switch', project];
    expect(isMultiInstanceProbe(argv, data)).toBe(false);
    expect(parseForwardedProjectPath(argv, cwd, data)).toBe(project);
  });

  it('keeps unlabelled legacy argv project forwarding', () => {
    const cwd = path.resolve('private-fixture');
    const argv = ['fate-ui', '--project', 'folder with spaces'];
    for (const data of [undefined, null, {}, { mode: 'unknown' }, 1, 'multi']) {
      expect(isMultiInstanceProbe(argv, data)).toBe(false);
      expect(parseForwardedProjectPath(argv, cwd, data)).toBe(path.resolve(cwd, 'folder with spaces'));
    }
  });

  it('keeps ordinary approved-profile selector parsing, rather than treating it as a probe', () => {
    const argv = ['fate-ui', '--connection-profile=fixtureA'];
    expect(isMultiInstanceProbe(argv, { mode: 'single' })).toBe(false);
    expect(parseConnectionProfile(argv)).toBe('fixtureA');
  });
});

describe('fixed desktop startup failure guidance', () => {
  it('explains typed ownership uncertainty without exposing a lock path or owner/error text', () => {
    const raw = 'synthetic-untrusted-sdk-response-and-key';
    const error = new OwnershipConflict(path.resolve('private-fixture', raw), raw);
    error.message = raw;
    const failure = desktopStartupFailure(error);
    expect(failure.title).toBe('Fate UI could not start this instance');
    expect(failure.message).toContain('running or retained owner');
    expect(failure.message).toContain('recovered automatically at the next start');
    expect(failure.message).toContain('Do not delete ownership records');
    expect(failure.message).toContain('explicit operator recovery review');
    expect(failure.message).toContain('does not authorize a second Pi runtime');
    expect(JSON.stringify(failure)).not.toContain(raw);
    expect(JSON.stringify(failure)).not.toContain(error.lockPath);
  });

  it('never reads even a throwing error-message accessor', () => {
    const error = new OwnershipConflict(path.resolve('private-fixture/lock'), 'synthetic-only');
    Object.defineProperty(error, 'message', { get: () => { throw new Error('must not be read'); } });
    expect(() => desktopStartupFailure(error)).not.toThrow();
    expect(desktopStartupFailure(error).message).toContain('running or retained owner');
  });

  it('uses one generic fixed message for non-ownership failures, without trusting error shape', () => {
    const raw = 'synthetic-untrusted-sdk-response-and-key';
    const expected = desktopStartupFailure(undefined);
    for (const error of [new Error(raw), { name: 'OwnershipConflict', message: raw }, raw, null,
      new AggregateError([new Error(raw)], raw)]) {
      expect(desktopStartupFailure(error)).toEqual(expected);
      expect(JSON.stringify(desktopStartupFailure(error))).not.toContain(raw);
    }
    expect(expected.message).toContain('Check your configuration');
    expect(expected.message).not.toContain('exclusive runtime ownership');
  });
});

describe('failed startup exits only through the existing desktop disposal result', () => {
  it.each([
    [false, 'settled', 0],
    [false, 'incomplete', 1],
    [true, 'settled', 1],
    [true, 'incomplete', 1],
  ] as const)('startupFailed=%s, disposal=%s yields %s', (failed, status, code) => {
    expect(desktopStartupExitCode(failed, status)).toBe(code);
  });

  it('does not turn successful owned disposal after startup failure into a successful process exit', async () => {
    const cleanup = vi.fn(async () => ({ status: 'settled' as const }));
    const exit = vi.fn();
    const coordinator = new ShutdownCoordinator({
      disposeAsync: () => [cleanup()],
      onExit: (status) => exit(desktopStartupExitCode(true, status)),
    });
    expect(coordinator.requestShutdown()).toBe(true);
    await coordinator.settled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(coordinator.requestShutdown()).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('keeps incomplete rejected core-startup cleanup truthful and still attempts other cleanup', async () => {
    const startup = Promise.reject(new OwnershipConflict(path.resolve('private-fixture/lock'), 'synthetic-only'));
    await startup.catch(() => undefined); // The entry's rejection handler has already observed it.
    const otherCleanup = vi.fn(async () => undefined);
    const markClean = vi.fn();
    const exit = vi.fn();
    const coordinator = new ShutdownCoordinator({
      disposeAsync: () => [startup.then(() => ({ status: 'settled' as const })), otherCleanup()],
      onClean: markClean,
      onError: () => undefined,
      onExit: (status) => exit(status, desktopStartupExitCode(true, status)),
    });
    expect(coordinator.requestShutdown()).toBe(true);
    await coordinator.settled();
    expect(otherCleanup).toHaveBeenCalledOnce();
    expect(markClean).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith('incomplete', 1);
  });
});
