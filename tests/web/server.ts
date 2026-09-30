import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createFateCore } from '../../src/core/createFateCore';
import { startAuthenticatedNodeServerWithFactory } from '../../src/server/http/startAuthenticatedNodeServer';
import { ownerCredentialPath } from '../../src/server/auth/AuthStore';
import { hostCheckoutLockRoot } from '../../src/core/ownership/CheckoutOwnership';
import { MultiProjectPiRuntime } from '../../src/main/pi/MultiProjectPiRuntime';
import { FakePiSdkAdapter } from '../v2/helpers/fakePi';
import { assertPrivatePath } from '../v2/helpers/isolatedEnvironment';
import type { WebFixtureAction, WebFixtureInspection, WebFixtureMessage, WebFixtureReady, WebFixtureReply } from '../v2/helpers/webProcessProtocol';

const root = process.env.FATE_WEB_CASE_ROOT;
const projectRoot = process.env.FATE_WEB_PROJECT_ROOT;
const proxyOrigin = process.env.FATE_WEB_PROXY_ORIGIN;
const port = Number(process.env.FATE_WEB_SERVER_PORT);
if (!process.send || !root || !projectRoot || !proxyOrigin || !Number.isSafeInteger(port) || port < 1) {
  throw new Error('The built test fixture requires parent-owned private IPC startup. It is not a production entry.');
}
// Private parent IPC only: fixed labels, not paths, config, keys or errors.
// A ready signal is still sent only after the genuine authenticated listener
// and both genuine registered workspaces exist.
const stage = (name: string) => { process.send?.({ type: 'fixture-stage', pid: process.pid, name }); };
async function phase<T>(name: string, operation: () => Promise<T>): Promise<T> {
  stage(`${name}:begin`);
  try { const result = await operation(); stage(`${name}:complete`); return result; }
  catch (error) { stage(`${name}:failed`); throw error; }
}
stage('server-module-loaded');
await phase('case-root', () => assertPrivatePath(root));
const home = path.join(root, 'home');
const projects = { a: path.join(root, 'a'), b: path.join(root, 'b') };
await phase('case-directories', () => Promise.all([home, projects.a, projects.b].map((directory) => assertPrivatePath(directory))));
const adapter = new FakePiSdkAdapter();
const server = await phase('authenticated-startup', () => startAuthenticatedNodeServerWithFactory({ profile: { profileId: 'web-acceptance', home },
  workspaces: [projects.a, projects.b], host: '127.0.0.1', port, browserOrigins: [proxyOrigin],
  flags: { terminal: false, browser: false }, maxPermission: 'edit' },
async (options) => {
  const core = await phase('core-load', () => createFateCore({ ...options, adapter,
    createRuntime: (dependencies) => new MultiProjectPiRuntime({ ...dependencies,
      createSessionTitleGenerator: () => ({ generate: async () => null }) }) }));
  if (core.workspaces) {
    const registry = core.workspaces;
    const register = registry.registerHostPath.bind(registry);
    // Forward the real registry operation and its actual result unchanged.
    // This test-only factory observes startup; it does not bypass admission,
    // checkout ownership, private ACL checks or runtime acquisition.
    registry.registerHostPath = (directory) => phase(directory === projects.a ? 'workspace-a'
      : directory === projects.b ? 'workspace-b' : 'workspace-unexpected', () => register(directory));
  }
  // The production composer now checks permissions, journal, credentials and
  // Windows private trees before it calls the observed workspace registration.
  stage('authority-and-journal-preflight');
  return core;
},
(entry) => { process.stderr.write(`${entry}\n`); }, path.join(projectRoot, 'dist', 'web'),
// Host-only trusted startup policy. The production default remains deny;
// browser envelopes cannot create this authority or bypass lease fencing.
{ hostName: 'T42 private test host', mayTakeOver: () => true }));
const runtimeFor = (key: 'a' | 'b' = 'a') => {
  const runtime = server.core.runtime.peekWorkspace(projects[key]);
  if (!runtime) throw new Error(`Fixture workspace ${key} runtime is unavailable.`);
  return runtime;
};
const runtime = runtimeFor();
const sessionId = runtime.getState(false).sessionId;
if (!sessionId) throw new Error('Fixture A has no selected session.');
const control = adapter.controls.get(sessionId);
if (!control) throw new Error('Fake Pi session control is unavailable.');
let monitorState: 'ready' | 'partial' | 'failure' = 'ready';
// Change only the explicit optional source seam. The dashboard projection,
// actual TaskRepository rows, reads, sanitization and transport remain genuine.
for (const key of ['a', 'b'] as const) runtimeFor(key).setMonitorRunsSource(async () => {
  if (monitorState === 'failure') throw new Error('Private fixture source failure must not appear in browser output.');
  return { runs: [], names: {}, checkedAt: Date.now(), partial: monitorState === 'partial' };
});
const git = (directory: string, ...args: string[]) => execFileSync('git', ['-C', directory, ...args],
  { encoding: 'utf8', windowsHide: true }).trim();
async function inspect(action: Extract<WebFixtureAction, { type: 'inspect' }>): Promise<WebFixtureInspection> {
  const key = action.workspace ?? 'a';
  const selected = runtimeFor(key);
  return { runtime: selected.getState(false), goal: await selected.getGoalMax(), tasks: await selected.getTaskList(),
    monitor: await selected.getMonitorDashboard({ section: action.section ?? 'overview', offset: action.offset ?? 0, limit: 25 }),
    invocations: [...adapter.invocations], head: git(projects[key], 'rev-parse', 'HEAD'),
    sentinel: await fs.readFile(path.join(projects[key], 'sentinel.txt'), 'utf8'),
    status: git(projects[key], 'status', '--porcelain'), diff: git(projects[key], 'diff', '--', 'sentinel.txt'),
    recovered: server.core.recovered };
}
let stopped = false;
async function dispatch(action: WebFixtureAction): Promise<unknown> {
  switch (action.type) {
    case 'code': {
      const owner = await fs.readFile(ownerCredentialPath(server.core.paths), 'utf8');
      return server.auth.createBootstrapCode(owner);
    }
    case 'inspect': return inspect(action);
    case 'barrier': {
      if (action.operation === 'hold') control!.barriers.hold(action.name);
      else if (action.operation === 'release') control!.barriers.release(action.name);
      else await control!.barriers.reached(action.name);
      return null;
    }
    case 'planEdit': {
      adapter.plannedEdits.set(sessionId!, { path: path.join(projects.a, 'sentinel.txt'),
        before: await fs.readFile(path.join(projects.a, 'sentinel.txt'), 'utf8'), after: action.after });
      control!.text = action.text ?? 'Fixture edit completed exactly once.';
      return null;
    }
    case 'seedTasks': {
      if (!Number.isSafeInteger(action.count) || action.count < 1 || action.count > 40) throw new Error('Invalid private fixture task count.');
      let list = await runtime.getTaskList();
      for (let index = 0; index < action.count; index++) list = await runtime.createTask({
        title: `Actual backend task ${String(index + 1).padStart(2, '0')}`,
        detail: `Private task detail ${index + 1}`, status: index === 0 ? 'in-progress' : 'todo', required: false });
      return list;
    }
    case 'taskStatus': return runtime.updateTask({ id: action.id, status: action.status });
    case 'monitorSource': monitorState = action.state; return null;
    case 'goal': return action.operation === 'create'
      ? runtime.createGoalMax({ objective: action.objective ?? 'Verify the actual browser sentinel',
        verificationLevel: 'normal', agentStrategy: 'off', tokenLimit: 128, timeLimitMs: 60_000 })
      : runtime.controlGoalMax({ action: 'pause', reason: 'Explicit private fixture operator pause; no continuation is authorized.' });
    case 'checkpoint': await server.core.recovery.flush(); return server.core.recovery.repository.read();
    case 'shutdown': {
      if (stopped) return { status: 'settled' };
      stopped = true;
      // Release held test barriers only for deliberate orderly cleanup. The
      // restart test kills the process without dispatching this action.
      for (const entry of adapter.controls.values()) entry.barriers.releaseAll();
      const result = await server.stop();
      await adapter.dispose();
      return { ...result, providerCallsBlocked: adapter.invocations.filter((entry) => entry.kind === 'providerBlocked').length };
    }
  }
}
process.on('message', (input: unknown) => {
  if (!input || typeof input !== 'object' || !('type' in input) || input.type !== 'request') return;
  const message = input as WebFixtureMessage;
  void dispatch(message.action).then((result) => {
    const reply: WebFixtureReply = { type: 'reply', id: message.id, ok: true, result };
    process.send?.(reply, () => { if (message.action.type === 'shutdown') process.disconnect(); });
  }, (reason: unknown) => {
    const reply: WebFixtureReply = { type: 'reply', id: message.id, ok: false,
      error: reason instanceof Error ? reason.message : 'Fixture action failed.' };
    process.send?.(reply);
  });
});
process.on('disconnect', () => { if (!stopped) void dispatch({ type: 'shutdown' }).finally(() => process.exit(1)); });
const a = server.core.runtime.workspaceOrigin(projects.a);
const b = server.core.runtime.workspaceOrigin(projects.b);
const sessionB = runtimeFor('b').getState(false).sessionId;
if (!a || !b || !sessionB) throw new Error('Fixture scopes were not registered.');
stage('fixture-controls-installed');
const ready: WebFixtureReady = { type: 'ready', pid: process.pid, serverEpoch: server.serverEpoch, port: server.readiness.port,
  lockRoots: [server.core.paths.lockRoot, hostCheckoutLockRoot()],
  workspaces: { a: { path: projects.a, sessionId, workspaceId: a.workspaceId, workspaceGeneration: a.workspaceGeneration },
    b: { path: projects.b, sessionId: sessionB, workspaceId: b.workspaceId, workspaceGeneration: b.workspaceGeneration } },
  recovered: server.core.recovered };
stage('publishing-ready');
process.send(ready);
