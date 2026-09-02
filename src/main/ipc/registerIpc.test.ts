import { BrowserWindow, ipcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getVersion: vi.fn(), isPackaged: false },
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  clipboard: { writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: vi.fn() },
}));

import { ipcChannels, type ProjectState } from '../../shared/contracts/ipc';
import type { MutationAttestationLedger } from '../pi/provenance/MutationAttestationLedger';
import type { ProjectActivation } from '../projects/ProjectService';
import { activatePreparedProject, assertProjectActivationIdle, createProjectActivationQueue, createProjectPathFocuser, createProjectPathOpener, discardCreatedWorktreeAfterFailure, registerIpc, resolveAttestationQuery } from './registerIpc';

const previousProject: ProjectState = { path: '/previous', name: 'previous', trusted: true };
const nextProject: ProjectState = { path: '/next', name: 'next', trusted: true };

function state(project: ProjectState | null, status = 'ready', overrides: Record<string, unknown> = {}) {
  return {
    project,
    status,
    sessionId: null,
    sessionFile: null,
    streaming: false,
    model: null,
    models: [],
    thinkingLevel: 'medium',
    messages: [],
    sessionOperation: false,
    error: null,
    ...overrides,
  } as never;
}

function activation(project = nextProject): ProjectActivation & { commit: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn> } {
  return {
    project,
    commit: vi.fn(async () => project),
    rollback: vi.fn(async () => undefined),
  };
}

function services() {
  let current = state(previousProject);
  let root: string | null = previousProject.path;
  const runtime = {
    getState: vi.fn(() => current),
    openProject: vi.fn(async (project: ProjectState) => {
      current = state(project);
      return current;
    }),
    focusProject: vi.fn(async (project: ProjectState) => {
      current = state(project, 'disconnected');
      return current;
    }),
    closeProject: vi.fn(async () => {
      current = state(null, 'disconnected');
      return current;
    }),
  };
  const files = {
    getRootOrNull: vi.fn(() => root),
    setRoot: vi.fn(async (nextRoot: string) => { root = nextRoot; }),
    clearRoot: vi.fn(async () => { root = null; }),
  };
  const settings = { load: vi.fn(async () => ({ thinkingLevel: 'medium' as const, defaultModel: null })) };
  const terminal = { disposeProjectTerminals: vi.fn() };
  const logs = { write: vi.fn() };
  return { runtime, files, settings, terminal, logs, setState: (next: never) => { current = next; } };
}

describe('runtime event sink transport hardening', () => {
  it('replaces an invalid runtime event batch with a resync error instead of crashing', () => {
    const runtime = {
      setEventSink: vi.fn(),
      setGoalEventSink: vi.fn(),
      setTaskEventSink: vi.fn(),
    };
    const logs = { write: vi.fn() };
    const sent: { channel: unknown; payload: unknown }[] = [];
    const getAllWindows = vi.mocked(BrowserWindow.getAllWindows);
    getAllWindows.mockReturnValue([{ webContents: { send: vi.fn((channel: unknown, payload: unknown) => sent.push({ channel, payload })) } } as never]);

    registerIpc({
      runtime,
      projects: {},
      files: {},
      git: {},
      settings: {},
      terminal: { setEventSink: vi.fn() },
      logs,
      music: { setDurationSink: vi.fn() },
      speech: { setEventSink: vi.fn(), setStreamSink: vi.fn() },
      hotkey: {},
      updates: {},
      browser: {},
      automations: {},
      attestations: {},
      rendererPolicy: {} as never,
    } as never);

    const sink = runtime.setEventSink.mock.calls[0]![0] as (events: unknown[]) => void;
    const invalidBatch = [{ type: 'state.changed', state: { model: { contextWindow: 0 } }, messagesIncluded: false, timestamp: 1 }];
    expect(() => sink(invalidBatch)).not.toThrow();
    expect(logs.write).toHaveBeenCalledWith('error', 'ipc', expect.stringContaining('failed transport validation'));
    expect(sent).toHaveLength(1);
    const replacement = sent[0]!.payload as { type: string; error: { code: string } }[];
    expect(replacement).toHaveLength(1);
    expect(replacement[0]!.type).toBe('error');
    expect(replacement[0]!.error.code).toBe('PI_RUNTIME_ERROR');

    sent.length = 0;
    const validBatch = [{ type: 'run.accepted', runId: 'run-1', timestamp: 1 }];
    sink(validBatch);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual(validBatch);

    getAllWindows.mockReset();
    getAllWindows.mockReturnValue([]);
  });
});

describe('project cleanup IPC', () => {
  it('uses the missing-directory-safe trusted cleanup resolver for forget and bulk session deletion', async () => {
    const handlers = new Map<string, (event: Electron.IpcMainInvokeEvent, input: unknown) => Promise<unknown>>();
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler as (event: Electron.IpcMainInvokeEvent, input: unknown) => Promise<unknown>);
    });
    const cleanupPath = vi.fn(async () => '/deleted-trusted-project');
    const sessionListPath = vi.fn();
    const closeProjectPath = vi.fn(async () => undefined);
    const deleteSessionsForPath = vi.fn(async () => ({ deleted: 3, skipped: 0 }));
    const runtime = {
      getState: vi.fn(() => state(previousProject)),
      closeProjectPath,
      deleteSessionsForPath,
      setEventSink: vi.fn(),
      setGoalEventSink: vi.fn(),
      setTaskEventSink: vi.fn(),
    };
    registerIpc({
      runtime,
      projects: { prepareKnownProjectCleanupPath: cleanupPath, prepareSessionListPath: sessionListPath },
      files: {}, git: {}, settings: {}, terminal: { setEventSink: vi.fn() }, logs: { write: vi.fn() },
      music: { setDurationSink: vi.fn() }, speech: { setEventSink: vi.fn(), setStreamSink: vi.fn() },
      hotkey: {}, updates: {}, browser: {}, automations: {}, attestations: {},
      rendererPolicy: { documentUrl: 'file:///fate/index.html', developmentOrigin: null },
    } as never);
    const frame = { url: 'file:///fate/index.html' } as Electron.WebFrameMain;
    const event = { sender: { mainFrame: frame }, senderFrame: frame } as Electron.IpcMainInvokeEvent;
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ isDestroyed: () => false } as Electron.BrowserWindow);

    await expect(handlers.get(ipcChannels.projectCloseRuntime)!(event, { projectPath: '/deleted-trusted-project' })).resolves.toBeUndefined();
    await expect(handlers.get(ipcChannels.projectDeleteSessions)!(event, { projectPath: '/deleted-trusted-project' })).resolves.toEqual({ deleted: 3, skipped: 0 });
    expect(cleanupPath).toHaveBeenCalledTimes(2);
    expect(closeProjectPath).toHaveBeenCalledWith('/deleted-trusted-project');
    expect(deleteSessionsForPath).toHaveBeenCalledWith('/deleted-trusted-project');
    expect(sessionListPath).not.toHaveBeenCalled();
  });
});

describe('transactional project activation', () => {
  it('opens a launcher path through the same trusted activation transaction', async () => {
    const candidate = activation();
    const deps = services();
    const owner = {} as Electron.BrowserWindow;
    const projects = { prepareOpenPath: vi.fn(async () => candidate) };
    const openProjectPath = createProjectPathOpener(projects, deps);

    await expect(openProjectPath('/next', owner)).resolves.toMatchObject({ project: nextProject });
    expect(projects.prepareOpenPath).toHaveBeenCalledWith('/next', owner);
    expect(deps.files.setRoot).toHaveBeenCalledWith(nextProject.path);
    expect(deps.runtime.openProject).toHaveBeenCalledWith(nextProject, { thinkingLevel: 'medium', defaultModel: null });
    expect(candidate.commit).toHaveBeenCalledOnce();
  });

  it('focuses a known launcher path without spawning a runtime', async () => {
    const candidate = activation();
    const deps = services();
    const projects = { prepareOpenPath: vi.fn(async () => candidate) };
    const focusProjectPath = createProjectPathFocuser(projects, deps);

    await expect(focusProjectPath('/next')).resolves.toMatchObject({ project: nextProject, status: 'disconnected' });
    expect(deps.runtime.focusProject).toHaveBeenCalledWith(nextProject);
    expect(deps.runtime.openProject).not.toHaveBeenCalled();
    expect(candidate.commit).toHaveBeenCalledOnce();
  });

  it('does not mutate runtime state when launcher trust is cancelled', async () => {
    const deps = services();
    const projects = { prepareOpenPath: vi.fn(async () => null) };
    const openProjectPath = createProjectPathOpener(projects, deps);

    await expect(openProjectPath('/next')).resolves.toMatchObject({ project: previousProject });
    expect(deps.files.setRoot).not.toHaveBeenCalled();
    expect(deps.runtime.openProject).not.toHaveBeenCalled();
  });

  it('rejects any selected or background run and session operations before activation', () => {
    expect(() => assertProjectActivationIdle({ getState: () => state(previousProject, 'ready', { streaming: true }) } as never, 'changing projects'))
      .toThrow('Stop all active Pi operations before changing projects.');
    expect(() => assertProjectActivationIdle({ getState: () => state(previousProject, 'ready', { streaming: false, runningSessionCount: 2 }) } as never, 'changing projects'))
      .toThrow('Stop all active Pi operations before changing projects.');
    expect(() => assertProjectActivationIdle({ getState: () => state(previousProject, 'ready', { sessionOperation: true }) } as never, 'changing projects'))
      .toThrow('Stop all active Pi operations before changing projects.');
  });

  it('serializes preparation and activation so an older rollback cannot overwrite a newer request', async () => {
    const queue = createProjectActivationQueue();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = queue.run(async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push('first-end');
    });
    const second = queue.run(async () => { order.push('second'); });

    await expect(queue.runRuntimeMutation('sending a prompt', async () => undefined)).rejects.toThrow('Wait for the project change');
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    await expect(queue.runRuntimeMutation('sending a prompt', async () => undefined)).resolves.toBeUndefined();
  });

  it('serializes runtime mutations in request order', async () => {
    const queue = createProjectActivationQueue();
    const order: string[] = [];
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseFirst: (() => void) | undefined;
    const first = queue.runRuntimeMutation('sending a prompt', async () => {
      order.push('first-start');
      markStarted?.();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push('first-end');
    });
    const second = queue.runRuntimeMutation('changing the model', async () => { order.push('second'); });

    await started;
    expect(order).toEqual(['first-start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('waits for an already-running runtime mutation before activating a project', async () => {
    const queue = createProjectActivationQueue();
    const order: string[] = [];
    let releaseMutation: (() => void) | undefined;
    const mutation = queue.runRuntimeMutation('changing the model', async () => {
      order.push('mutation-start');
      await new Promise<void>((resolve) => { releaseMutation = resolve; });
      order.push('mutation-end');
    });
    const activation = queue.run(async () => { order.push('activation'); });
    await Promise.resolve();

    expect(order).toEqual(['mutation-start']);
    releaseMutation?.();
    await Promise.all([mutation, activation]);
    expect(order).toEqual(['mutation-start', 'mutation-end', 'activation']);
  });

  it('serializes an in-flight Git operation before project activation', async () => {
    const queue = createProjectActivationQueue();
    const order: string[] = [];
    let releaseGit: (() => void) | undefined;
    const gitOperation = queue.runSerializedMutation(async () => {
      order.push('git-start');
      await new Promise<void>((resolve) => { releaseGit = resolve; });
      order.push('git-end');
    });
    const activation = queue.run(async () => { order.push('activation'); });
    await Promise.resolve();

    expect(order).toEqual(['git-start']);
    releaseGit?.();
    await Promise.all([gitOperation, activation]);
    expect(order).toEqual(['git-start', 'git-end', 'activation']);
  });

  it('waits for project activation before starting a queued Git operation', async () => {
    const queue = createProjectActivationQueue();
    const order: string[] = [];
    let releaseActivationStarted: (() => void) | undefined;
    const activationStarted = new Promise<void>((resolve) => { releaseActivationStarted = resolve; });
    let releaseActivation: (() => void) | undefined;
    const activation = queue.run(async () => {
      order.push('activation-start');
      releaseActivationStarted?.();
      await new Promise<void>((resolve) => { releaseActivation = resolve; });
      order.push('activation-end');
    });
    const gitOperation = queue.runSerializedMutation(async () => { order.push('git'); });
    await activationStarted;

    expect(order).toEqual(['activation-start']);
    releaseActivation?.();
    await Promise.all([activation, gitOperation]);
    expect(order).toEqual(['activation-start', 'activation-end', 'git']);
  });

  it('allows a project switch while another project has an active operation', async () => {
    const candidate = activation();
    const deps = services();
    deps.settings.load.mockImplementationOnce(async () => {
      deps.setState(state(previousProject, 'ready', { sessionOperation: true }));
      return { thinkingLevel: 'medium', defaultModel: null };
    });

    await expect(activatePreparedProject(candidate, deps, 'changing projects')).resolves.toMatchObject({ project: nextProject });
    expect(deps.files.setRoot).toHaveBeenCalledWith(nextProject.path);
    expect(deps.runtime.openProject).toHaveBeenCalledOnce();
    expect(candidate.commit).toHaveBeenCalledOnce();
  });

  it('leaves all activation state untouched when settings loading fails', async () => {
    const candidate = activation();
    const deps = services();
    deps.settings.load.mockRejectedValueOnce(new Error('settings failed'));

    await expect(activatePreparedProject(candidate, deps, 'changing projects')).rejects.toThrow('settings failed');
    expect(deps.files.setRoot).not.toHaveBeenCalled();
    expect(deps.runtime.openProject).not.toHaveBeenCalled();
    expect(candidate.commit).not.toHaveBeenCalled();
    expect(candidate.rollback).not.toHaveBeenCalled();
    expect(deps.terminal.disposeProjectTerminals).not.toHaveBeenCalled();
  });

  it('commits only after filesystem and runtime activation and disposes terminals last', async () => {
    const order: string[] = [];
    const candidate = activation();
    const deps = services();
    deps.settings.load.mockImplementationOnce(async () => { order.push('settings'); return { thinkingLevel: 'medium', defaultModel: null }; });
    deps.files.setRoot.mockImplementationOnce(async () => { order.push('filesystem'); });
    deps.runtime.openProject.mockImplementationOnce(async () => { order.push('runtime'); return state(nextProject); });
    candidate.commit.mockImplementationOnce(async () => { order.push('project'); return nextProject; });
    deps.terminal.disposeProjectTerminals.mockImplementationOnce(() => { order.push('terminals'); });

    await expect(activatePreparedProject(candidate, deps, 'changing projects')).resolves.toMatchObject({ project: nextProject });
    expect(order).toEqual(['settings', 'filesystem', 'runtime', 'project', 'terminals']);
  });

  it('does not roll back a committed project if terminal cleanup fails afterward', async () => {
    const candidate = activation();
    const deps = services();
    deps.terminal.disposeProjectTerminals.mockImplementationOnce(() => { throw new Error('terminal cleanup failed'); });

    await expect(activatePreparedProject(candidate, deps, 'changing projects')).resolves.toMatchObject({ project: nextProject });
    expect(deps.runtime.openProject).toHaveBeenCalledOnce();
    expect(deps.files.setRoot).toHaveBeenCalledOnce();
    expect(candidate.commit).toHaveBeenCalledOnce();
    expect(candidate.rollback).not.toHaveBeenCalled();
    expect(deps.logs.write).toHaveBeenCalledWith('error', 'terminal', expect.stringContaining('terminal cleanup failed'));
  });

  it('restores the previous root when filesystem activation fails before runtime mutation', async () => {
    const candidate = activation();
    const deps = services();
    deps.files.setRoot
      .mockRejectedValueOnce(new Error('candidate root failed'))
      .mockResolvedValueOnce(undefined);

    await expect(activatePreparedProject(candidate, deps, 'changing projects')).rejects.toThrow('candidate root failed');
    expect(deps.files.setRoot).toHaveBeenLastCalledWith(previousProject.path);
    expect(deps.runtime.openProject).not.toHaveBeenCalled();
    expect(candidate.rollback).toHaveBeenCalledOnce();
    expect(deps.terminal.disposeProjectTerminals).not.toHaveBeenCalled();
  });

  it('restores runtime, filesystem, project authority, and persistence after a runtime error state', async () => {
    const candidate = activation();
    const deps = services();
    deps.runtime.openProject
      .mockResolvedValueOnce(state(nextProject, 'error', { error: { code: 'PI_RUNTIME_ERROR', message: 'candidate failed', retryable: true } }))
      .mockResolvedValueOnce(state(previousProject));

    await expect(activatePreparedProject(candidate, deps, 'changing projects')).rejects.toThrow('candidate failed');
    expect(deps.runtime.openProject).toHaveBeenNthCalledWith(2, previousProject, { thinkingLevel: 'medium', defaultModel: null });
    expect(deps.files.setRoot).toHaveBeenLastCalledWith(previousProject.path);
    expect(candidate.rollback).toHaveBeenCalledOnce();
    expect(candidate.commit).not.toHaveBeenCalled();
    expect(deps.terminal.disposeProjectTerminals).not.toHaveBeenCalled();
  });

  it('does not dispose an existing destination runtime when focus persistence rolls back', async () => {
    const candidate = activation();
    candidate.commit.mockRejectedValueOnce(new Error('recent project write failed'));
    const deps = services();
    const closeProjectPath = vi.fn(async () => undefined);
    Object.assign(deps.runtime, { closeProjectPath });

    await expect(activatePreparedProject(candidate, deps, 'changing projects', 'focus')).rejects.toThrow('recent project write failed');
    expect(closeProjectPath).not.toHaveBeenCalled();
    expect(deps.runtime.focusProject).toHaveBeenNthCalledWith(1, nextProject);
    expect(deps.runtime.focusProject).toHaveBeenNthCalledWith(2, previousProject);
    expect(deps.files.setRoot).toHaveBeenLastCalledWith(previousProject.path);
  });

  it('compensates a persistence failure without disposing old terminals', async () => {
    const candidate = activation();
    candidate.commit.mockRejectedValueOnce(new Error('recent project write failed'));
    const deps = services();

    await expect(activatePreparedProject(candidate, deps, 'changing projects')).rejects.toThrow('recent project write failed');
    expect(deps.runtime.openProject).toHaveBeenCalledTimes(2);
    expect(deps.files.setRoot).toHaveBeenLastCalledWith(previousProject.path);
    expect(candidate.rollback).toHaveBeenCalledOnce();
    expect(deps.terminal.disposeProjectTerminals).not.toHaveBeenCalled();
  });

  it('aggregates independent rollback failures with the primary failure', async () => {
    const candidate = activation();
    candidate.commit.mockRejectedValueOnce(new Error('commit failed'));
    candidate.rollback.mockRejectedValueOnce(new Error('persistence restore failed'));
    const deps = services();
    deps.runtime.openProject
      .mockResolvedValueOnce(state(nextProject))
      .mockRejectedValueOnce(new Error('runtime restore failed'));
    deps.files.setRoot
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('root restore failed'));

    await expect(activatePreparedProject(candidate, deps, 'changing projects')).rejects.toThrow(
      /commit failed.*runtime restore failed.*root restore failed.*persistence restore failed/u,
    );
  });

  it('restores the no-project and no-root state through narrow reset APIs', async () => {
    const candidate = activation();
    candidate.commit.mockRejectedValueOnce(new Error('commit failed'));
    const deps = services();
    deps.setState(state(null, 'disconnected'));
    deps.files.getRootOrNull.mockReturnValueOnce(null);

    await expect(activatePreparedProject(candidate, deps, 'changing projects')).rejects.toThrow('commit failed');
    expect(deps.runtime.closeProject).toHaveBeenCalledOnce();
    expect(deps.files.clearRoot).toHaveBeenCalledOnce();
  });

  it('reports both isolated-session activation and managed-worktree cleanup failures', async () => {
    await expect(discardCreatedWorktreeAfterFailure(
      new Error('activation failed'),
      async () => { throw new Error('discard failed'); },
    )).rejects.toThrow(/activation failed.*discard failed/u);
  });
});

describe('attestation query resolves the main-owned current project', () => {
  const project = { path: '/project', name: 'project', trusted: true } as ProjectState;

  it('queries the ledger with the current trusted project path and renderer request', async () => {
    const runtime = { getState: vi.fn(() => ({ project })) } as never;
    const ledger = { query: vi.fn(async () => ({ rows: [], truncated: false })) } as Pick<MutationAttestationLedger, 'query'>;
    await resolveAttestationQuery(runtime, ledger, { limit: 10, pathPrefix: 'src' });
    expect(ledger.query).toHaveBeenCalledWith({ projectPath: '/project', limit: 10, pathPrefix: 'src' });
  });

  it('forwards the renderer limit and omits an absent pathPrefix', async () => {
    const runtime = { getState: vi.fn(() => ({ project })) } as never;
    const ledger = { query: vi.fn(async () => ({ rows: [], truncated: false })) } as Pick<MutationAttestationLedger, 'query'>;
    await resolveAttestationQuery(runtime, ledger, { limit: 256 });
    expect(ledger.query).toHaveBeenCalledWith({ projectPath: '/project', limit: 256 });
    expect(ledger.query).not.toHaveBeenCalledWith(expect.objectContaining({ pathPrefix: expect.anything() }));
  });

  it('returns an empty result without touching the ledger when no project is open', async () => {
    const runtime = { getState: vi.fn(() => ({ project: null })) } as never;
    const ledger = { query: vi.fn(async () => ({ rows: [], truncated: false })) } as Pick<MutationAttestationLedger, 'query'>;
    await expect(resolveAttestationQuery(runtime, ledger, { limit: 256 })).resolves.toEqual({ rows: [], truncated: false });
    expect(ledger.query).not.toHaveBeenCalled();
  });

  it('returns an empty result without touching the ledger for an untrusted project', async () => {
    const untrusted = { ...project, trusted: false } as ProjectState;
    const runtime = { getState: vi.fn(() => ({ project: untrusted })) } as never;
    const ledger = { query: vi.fn(async () => ({ rows: [], truncated: false })) } as Pick<MutationAttestationLedger, 'query'>;
    await expect(resolveAttestationQuery(runtime, ledger, { limit: 256 })).resolves.toEqual({ rows: [], truncated: false });
    expect(ledger.query).not.toHaveBeenCalled();
  });
});
