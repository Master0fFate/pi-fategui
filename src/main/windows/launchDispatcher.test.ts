import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { LaunchDispatcher } from './launchDispatcher';

interface FakeWindow {
  id: number;
}

type OpenProjectPath = (projectPath: string, owner: FakeWindow) => void;

function makeDispatcher(isLive: (handle: FakeWindow) => boolean): {
  dispatcher: LaunchDispatcher<FakeWindow>;
  /** Raw mock for call assertions. */
  opener: MockInstance<OpenProjectPath>;
  reportLaunchError: ReturnType<typeof vi.fn>;
  onLastWindowClosed: ReturnType<typeof vi.fn>;
  /** Wire the dispatcher opener to the mock without exposing the mock type. */
  bindOpener: () => void;
} {
  const opener = vi.fn<OpenProjectPath>();
  const reportLaunchError = vi.fn();
  const onLastWindowClosed = vi.fn();
  const dispatcher = new LaunchDispatcher<FakeWindow>({ isLive, reportLaunchError, onLastWindowClosed });
  // A plain delegating arrow satisfies the typed opener signature while the
  // raw mock stays available for `toHaveBeenCalledWith` assertions.
  const bindOpener = () => dispatcher.setOpener(async (projectPath, owner) => { opener(projectPath, owner); });
  return { dispatcher, opener, reportLaunchError, onLastWindowClosed, bindOpener };
}

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('LaunchDispatcher', () => {
  it('keeps a forwarded project path pending until the renderer, opener, and an owner are ready', () => {
    const { dispatcher, opener, bindOpener } = makeDispatcher(() => true);
    const owner = { id: 1 };

    // Nothing is ready yet: the path must stay pending.
    expect(dispatcher.dispatch('/p1')).toBe(false);
    expect(opener).not.toHaveBeenCalled();
    expect(dispatcher.getPendingProjectPath()).toBe('/p1');

    // Once an owner exists, the renderer is ready, and the opener is wired, dispatch opens immediately.
    dispatcher.register(owner);
    dispatcher.markRendererReady();
    bindOpener();
    expect(dispatcher.dispatch('/p1')).toBe(true);
    expect(opener).toHaveBeenCalledWith('/p1', owner);
    expect(dispatcher.getPendingProjectPath()).toBeNull();
  });

  it('selects the focused window when live, otherwise the first live window', () => {
    const live = new Set<number>([1, 2]);
    const { dispatcher } = makeDispatcher((handle) => live.has(handle.id));
    const first = { id: 1 };
    const second = { id: 2 };
    dispatcher.register(first);
    dispatcher.register(second);
    dispatcher.setFocused(second);

    expect(dispatcher.activeHandle()).toBe(second);

    live.delete(2); // focused window destroyed
    expect(dispatcher.activeHandle()).toBe(first);

    live.delete(1); // no live windows remain
    expect(dispatcher.activeHandle()).toBeNull();
  });

  it('tears down shared state only when the last window closes and clears renderer readiness', () => {
    const { dispatcher, opener, onLastWindowClosed, bindOpener } = makeDispatcher(() => true);
    const first = { id: 1 };
    const second = { id: 2 };
    dispatcher.register(first);
    dispatcher.register(second);
    dispatcher.markRendererReady();
    bindOpener();

    expect(dispatcher.close(first)).toBe(false);
    expect(onLastWindowClosed).not.toHaveBeenCalled();
    expect(dispatcher.dispatch('/x')).toBe(true); // still ready

    expect(dispatcher.close(second)).toBe(true);
    expect(onLastWindowClosed).toHaveBeenCalledTimes(1);
    // Readiness cleared: further dispatches must pend again.
    expect(dispatcher.dispatch('/y')).toBe(false);
    expect(dispatcher.getPendingProjectPath()).toBe('/y');
  });

  it('initial restore prioritizes an explicit pending path over the last trusted project', () => {
    const { dispatcher, opener, bindOpener } = makeDispatcher(() => true);
    const owner = { id: 1 };
    dispatcher.register(owner);
    dispatcher.markRendererReady();
    bindOpener();
    dispatcher.setPendingProjectPath('/explicit');

    const restore = vi.fn(async () => '/recent');
    dispatcher.runInitialRestore({ restoreLastTrustedProject: restore, consumeLaunchError: () => null });

    expect(restore).not.toHaveBeenCalled();
    expect(opener).toHaveBeenCalledWith('/explicit', owner);
    expect(dispatcher.getPendingProjectPath()).toBeNull();
  });

  it('initial restore falls back to the last trusted project when no path is pending', async () => {
    const { dispatcher, opener, bindOpener } = makeDispatcher(() => true);
    const owner = { id: 1 };
    dispatcher.register(owner);
    dispatcher.markRendererReady();
    bindOpener();

    const restore = vi.fn(async () => '/recent');
    dispatcher.runInitialRestore({ restoreLastTrustedProject: restore, consumeLaunchError: () => null });

    await flushMicrotasks();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(opener).toHaveBeenCalledWith('/recent', owner);
  });

  it('an intervening explicit dispatch invalidates a pending initial restore so it does not override the forwarded path', async () => {
    const { dispatcher, opener, bindOpener } = makeDispatcher(() => true);
    const owner = { id: 1 };
    dispatcher.register(owner);
    dispatcher.markRendererReady();
    bindOpener();

    // A restore that resolves only when we release it, returning a stale recent project.
    let releaseRestore!: (value: string | null) => void;
    const restore = vi.fn(() => new Promise<string | null>((resolve) => { releaseRestore = resolve; }));
    dispatcher.runInitialRestore({ restoreLastTrustedProject: restore, consumeLaunchError: () => null });
    await flushMicrotasks();
    expect(restore).toHaveBeenCalledTimes(1);

    // A second instance forwards a path while restore is still pending; it opens immediately.
    expect(dispatcher.dispatch('/forwarded')).toBe(true);
    expect(opener).toHaveBeenCalledWith('/forwarded', owner);

    // Restore later resolves with the stale last-trusted project; it must NOT override the forwarded path.
    releaseRestore('/stale-recent');
    await flushMicrotasks();

    expect(opener).toHaveBeenCalledTimes(1);
    expect(opener).not.toHaveBeenCalledWith('/stale-recent', owner);
  });

  it('reports a launch-time argv error during initial restore', () => {
    const { dispatcher, reportLaunchError } = makeDispatcher(() => true);
    dispatcher.register({ id: 1 });
    dispatcher.setOpener(async () => undefined);

    dispatcher.runInitialRestore({
      restoreLastTrustedProject: async () => null,
      consumeLaunchError: () => new Error('Invalid project path'),
    });

    expect(reportLaunchError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid project path' }));
  });

  it('only initial windows own restore: pending is consumed once and a forwarded path still routes after', () => {
    // Ownership is enforced by the factory only calling runInitialRestore for
    // initial windows. Here we verify the dispatcher consumes pending exactly
    // once during restore, and a later second-instance dispatch still routes.
    const { dispatcher, opener, bindOpener } = makeDispatcher(() => true);
    const owner = { id: 1 };
    dispatcher.register(owner);
    dispatcher.markRendererReady();
    bindOpener();

    dispatcher.runInitialRestore({ restoreLastTrustedProject: async () => null, consumeLaunchError: () => null });
    expect(dispatcher.getPendingProjectPath()).toBeNull();

    opener.mockClear();
    expect(dispatcher.dispatch('/forwarded')).toBe(true);
    expect(opener).toHaveBeenCalledWith('/forwarded', owner);
  });
});
