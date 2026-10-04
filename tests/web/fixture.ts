import { test as base, expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitFixture, isWithin, privateTestRoot, type GitFixture } from '../v2/helpers/isolatedEnvironment';
import type { WebFixtureAction, WebFixtureInspection, WebFixtureReady, WebFixtureReply } from '../v2/helpers/webProcessProtocol';
import { FaultProxy, type CommandCapture, type JsonRecord } from './faultProxy';
import { statePersistenceBackendSchema, type StatePersistenceBackend } from '../../src/shared/v2FeaturePolicy';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('No fixture loopback port.');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
export function object(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an actual JSON object.');
  return value as JsonRecord;
}
export interface BrowserClient { context: BrowserContext; page: Page; sessionId: string; code: string; csrf: string }

// The guard runs before this entry. Emit a private IPC milestone before loading
// the bundle so a silent import stall is distinguishable from host startup.
// This changes neither the bundled fixture nor its production transport factory.
const fixtureEntry = `
  import { pathToFileURL } from 'node:url';
  const stage = (name) => process.send?.({ type: 'fixture-stage', pid: process.pid, name });
  stage('loading-server-bundle');
  await import(pathToFileURL(process.argv[1]).href);
  stage('server-entry-complete');
`;
// Approved-3 IPC stages measured ~22 seconds before the last workspace finished
// on Windows. The real factory then verifies attachment-parent and host-id DACLs
// through PowerShell before binding HTTP. Keep those security checks; budget the
// full startup instead of killing its owner at 25 seconds. Non-Windows is unchanged.
const startupTimeoutMs = process.platform === 'win32' ? 60_000 : 25_000;
const startupStage = /^(?:loading-server-bundle|server-entry-complete|server-module-loaded|authority-and-journal-preflight|fixture-controls-installed|publishing-ready|(?:case-root|case-directories|authenticated-startup|core-load|workspace-a|workspace-b|workspace-unexpected):(?:begin|complete|failed))$/u;

export class WebHost {
  private child: ChildProcess | null = null;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private childOutput = '';
  private readonly browserErrors: string[] = [];
  private readonly contexts: BrowserContext[] = [];
  private readonly outbound: string[] = [];
  private readonly startupStages: string[][] = [];
  ready!: WebFixtureReady;
  readonly boots: WebFixtureReady[] = [];
  private constructor(readonly repositories: GitFixture, readonly proxy: FaultProxy, private readonly browser: Browser,
    readonly statePersistence: StatePersistenceBackend, private readonly terminalEnabled: boolean) {}
  get origin(): string { return this.proxy.origin; }
  static async start(browser: Browser, statePersistence: StatePersistenceBackend, terminalEnabled = false): Promise<WebHost> {
    const repositories = await createGitFixture();
    let proxy: FaultProxy | undefined;
    let host: WebHost | undefined;
    try {
      await fs.mkdir(path.join(repositories.root, 'home'), { mode: 0o700 });
      proxy = await FaultProxy.start();
      host = new WebHost(repositories, proxy, browser, statePersistence, terminalEnabled);
      await host.boot();
      return host;
    } catch (reason) {
      await proxy?.close();
      // Never remove a private profile/checkout while the spawned owner is
      // still unobserved. A timeout itself is not process settlement.
      if (host?.child?.pid && host.child.exitCode === null && host.child.signalCode === null) {
        throw new AggregateError([reason], 'Fixture startup failed; process settlement is unknown and its private files are retained.');
      }
      await repositories.cleanup();
      throw reason;
    }
  }
  private async terminateOwnedChild(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const exited = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child.off('exit', exited); reject(new Error('Fixture startup owner did not exit after termination.')); }, 10_000);
      child.once('exit', exited);
      if (!child.kill('SIGKILL')) {
        clearTimeout(timer); child.off('exit', exited);
        reject(new Error('Fixture startup owner could not be terminated; private files must be retained.'));
      }
    });
  }
  private async boot(): Promise<void> {
    const projectRoot = process.env.FATE_WEB_PROJECT_ROOT;
    const buildRoot = process.env.FATE_WEB_BUILD_ROOT;
    if (!projectRoot || !buildRoot || !privateTestRoot()) throw new Error('Use scripts/run-web-tests.mjs.');
    const port = await freePort();
    const home = path.join(this.repositories.root, 'home');
    const environment = { ...process.env, HOME: home, USERPROFILE: home,
      FATE_WEB_CASE_ROOT: this.repositories.root, FATE_WEB_PROXY_ORIGIN: this.origin, FATE_WEB_SERVER_PORT: String(port),
      FATE_WEB_STATE_PERSISTENCE: this.boots.length === 0 ? this.statePersistence : undefined,
      FATE_WEB_TERMINAL_ENABLED: this.terminalEnabled ? '1' : '0' };
    // The test child also inherits the Node outbound/Electron guard. No CLI flag
    // or environment setting enables the fake adapter in production main.ts.
    this.childOutput = '';
    const startedAt = Date.now();
    const stages: string[] = [];
    const recordStage = (name: string) => {
      if (stages.length < 48) stages.push(`${Date.now() - startedAt}ms ${name}`);
    };
    const diagnostic = () => `pid=${child.pid ?? 'not-spawned'}; stages=${stages.join(', ') || 'none'}\n${this.childOutput}`;
    const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(projectRoot, 'tests/network/loopbackGuard.mjs')).href,
      '--input-type=module', '--eval', fixtureEntry, path.join(buildRoot, 'server.mjs')], { cwd: projectRoot, env: environment, shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    this.child = child;
    child.once('spawn', () => recordStage('process-spawned'));
    child.stdout?.on('data', (bytes: Buffer) => { this.childOutput = `${this.childOutput}${bytes.toString('utf8')}`.slice(-24_000); });
    child.stderr?.on('data', (bytes: Buffer) => { this.childOutput = `${this.childOutput}${bytes.toString('utf8')}`.slice(-24_000); });
    try {
      const ready = await new Promise<WebFixtureReady>((resolve, reject) => {
        const timer = setTimeout(() => { fail(new Error(`Fixture startup timed out after ${startupTimeoutMs}ms.\n${diagnostic()}`)); }, startupTimeoutMs);
        let startupSettled = false;
        const fail = (reason: Error) => {
          if (startupSettled) return;
          startupSettled = true; clearTimeout(timer); reject(reason);
        };
        child.once('error', fail);
        child.once('exit', (code, signal) => {
          for (const [id, waiting] of this.pending) { clearTimeout(waiting.timer); waiting.reject(new Error(`Fixture exited (${code}/${signal}); RPC ${id} unresolved.\n${this.childOutput}`)); }
          this.pending.clear();
          fail(new Error(`Fixture exited before readiness (${code}/${signal}).\n${diagnostic()}`));
        });
        child.on('message', (input: unknown) => {
          let message: JsonRecord;
          try { message = object(input); }
          catch { fail(new Error('Fixture sent a malformed private IPC message.')); return; }
          if (message.type === 'fixture-stage' && message.pid === child.pid
            && typeof message.name === 'string' && startupStage.test(message.name)) {
            recordStage(message.name); return;
          }
          if (message.type === 'ready') {
            if (startupSettled) return;
            if (message.pid !== child.pid || message.port !== port) {
              fail(new Error('Fixture readiness does not identify its actual server process.')); return;
            }
            startupSettled = true; clearTimeout(timer); recordStage('authenticated-server-ready');
            resolve(input as WebFixtureReady); return;
          }
          if (message.type !== 'reply' || typeof message.id !== 'string') return;
          const reply = input as WebFixtureReply;
          const waiting = this.pending.get(reply.id);
          if (!waiting) return;
          this.pending.delete(reply.id); clearTimeout(waiting.timer);
          if (reply.ok) waiting.resolve(reply.result); else waiting.reject(new Error(reply.error));
        });
      });
      expect(ready.statePersistence).toBe(this.statePersistence);
      expect(ready.nativeDatabasePresent).toBe(this.statePersistence === 'native-durable');
      this.ready = ready; this.boots.push(ready); this.startupStages.push(stages);
      this.proxy.target(port); this.proxy.resumeEvents();
    } catch (reason) {
      try { await this.terminateOwnedChild(child); }
      catch (cleanup) { throw new AggregateError([reason, cleanup], 'Fixture startup and owned-process cleanup failed.'); }
      this.child = null;
      throw reason;
    }
  }
  rpc<T = unknown>(action: WebFixtureAction): Promise<T> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error('Fixture process IPC is unavailable.'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Fixture RPC ${action.type} timed out.\n${this.childOutput}`)); }, 20_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      child.send({ type: 'request', id, action }, (error) => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  inspect(workspace: 'a' | 'b' = 'a', section: 'overview' | 'tasks' | 'runs' = 'overview', offset = 0): Promise<WebFixtureInspection> {
    return this.rpc({ type: 'inspect', workspace, section, offset });
  }
  async login(): Promise<BrowserClient> {
    const { code } = await this.rpc<{ code: string }>({ type: 'code' });
    const context = await this.browser.newContext({ baseURL: this.origin, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    this.contexts.push(context);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    page.on('pageerror', (error) => this.browserErrors.push(error.message));
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol !== 'data:' && url.protocol !== 'blob:' && url.origin !== this.origin) this.outbound.push(url.origin);
    });
    await page.goto('/#discarded-accidental-secret');
    await expect(page.getByLabel('One-time code')).toBeVisible();
    expect(page.url()).toBe(`${this.origin}/`);
    expect(await page.evaluate(() => 'piDesktop' in window || 'require' in window || 'process' in window)).toBe(false);
    await page.getByLabel('One-time code').fill(code);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim control', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => 'piDesktop' in window || 'process' in window)).toBe(false);
    const session = await context.request.get('/api/auth/session');
    expect(session.status()).toBe(200);
    const metadata = object(object(await session.json()).session);
    const sessionId = String(metadata.sessionId);
    const csrf = String(metadata.csrfToken);
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(csrf).toMatch(/^fx1_[A-Za-z0-9_-]{43}$/u);
    const stored = await page.evaluate(() => ({ url: location.href, history: history.state,
      local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
    expect(JSON.stringify(stored)).not.toContain(code);
    return { context, page, sessionId, code, csrf };
  }
  captured(client: BrowserClient, method: string): CommandCapture {
    const result = [...this.proxy.commands].reverse().find((entry) => entry.method === method
      && entry.headers['x-fate-csrf'] === client.csrf && entry.response?.ok === true);
    if (!result?.response) throw new Error(`No actual ${method} for this browser identity.`);
    return result;
  }
  async claim(page: Page): Promise<CommandCapture> {
    const before = this.proxy.commands.length;
    await expect(page.getByRole('button', { name: 'Claim control', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Claim control', exact: true }).click();
    try { await expect(page.getByRole('button', { name: 'Release control', exact: true })).toBeEnabled(); }
    catch (error) {
      // Preserve the original assertion, with bounded real wire/UI facts in the
      // streamed log. No token, ticket, prompt body or receipt is logged.
      console.error('[actual claim failure]', JSON.stringify({
        commands: this.proxy.commands.slice(before).slice(-20).map((entry) => ({ method: entry.method,
          requestId: entry.request.requestId, status: entry.status, dropped: entry.dropped, ok: entry.response?.ok })),
        frames: this.proxy.frames.slice(-20).map((entry) => ({ direction: entry.direction, type: entry.value.type,
          dropped: entry.dropped, sequence: entry.value.type === 'event' ? object(entry.value.event).sequence : undefined })),
        status: (await page.getByRole('region', { name: 'Connection status', exact: true }).innerText()).slice(0, 1024),
        alerts: (await page.getByRole('alert').allTextContents()).map((text) => text.slice(0, 512)).slice(0, 4),
      }));
      throw error;
    }
    const captured = this.proxy.commands.slice(before).find((entry) => entry.method === 'control.claim');
    if (!captured?.response) throw new Error('No actual claim response was captured.');
    expect(captured.response.ok).toBe(true);
    return captured;
  }
  /** Raw authenticated request uses the browser context's real cookie and its
   * server-issued socket ticket. This proves backend fencing, not just labels. */
  async command(client: BrowserClient, captured: CommandCapture, body: JsonRecord): Promise<JsonRecord> {
    const csrf = captured.headers['x-fate-csrf'];
    const ticket = captured.headers['x-fate-client-ticket'];
    if (typeof csrf !== 'string' || typeof ticket !== 'string') throw new Error('No authenticated ticket/CSRF captured.');
    const response = await client.context.request.post('/api/command', { headers: { Origin: this.origin,
      'X-Fate-Csrf': csrf, 'X-Fate-Client-Ticket': ticket }, data: body });
    expect(response.status()).toBe(200);
    return object(await response.json());
  }
  async crashAndRestart(): Promise<void> {
    const child = this.child;
    if (!child?.pid) throw new Error('No live fixture process to restart.');
    const deadPid = child.pid;
    // Actual abrupt process loss, not dispose/recreate of a JS server object.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Killed fixture process did not exit.')), 10_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGKILL');
    });
    this.child = null;
    this.proxy.disconnectEvents();
    // Explicit fixture-operator recovery, AFTER observing the exact owned
    // process exit. Production must not auto-break locks by PID/heartbeat.
    for (const namespace of this.ready.lockRoots) {
      if (!isWithin(this.repositories.root, namespace)) throw new Error('Refusing recovery outside this private fixture.');
      const names = await fs.readdir(namespace).catch((reason: NodeJS.ErrnoException) => {
        if (reason.code === 'ENOENT') return []; throw reason;
      });
      for (const name of names) {
        if (!/^(?:profile|checkout|git)-[a-f0-9]{64}\.lock$/u.test(name)) throw new Error('Unexpected lock in private recovery namespace.');
        const directory = path.join(namespace, name);
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe fixture recovery lock.');
        // The record is named after its owner's token.
        const recordName = (await fs.readdir(directory)).find((entry) => /^owner-[0-9a-f-]{36}\.json$/u.test(entry));
        if (!recordName) throw new Error('Fixture recovery lock has no owner record.');
        const record = object(JSON.parse(await fs.readFile(path.join(directory, recordName), 'utf8')));
        if (record.pid !== deadPid || typeof record.resource !== 'string' || !isWithin(this.repositories.root, record.resource)) {
          throw new Error('Lock does not belong to the killed fixture process.');
        }
        await fs.unlink(path.join(directory, recordName)); await fs.rmdir(directory);
      }
    }
    await this.boot();
    expect(this.ready.pid).not.toBe(deadPid);
    expect(this.ready.serverEpoch).not.toBe(this.boots[0]!.serverEpoch);
  }
  async evidence(info: TestInfo): Promise<void> {
    for (const [index, context] of this.contexts.entries()) {
      const failed = info.status !== info.expectedStatus;
      const trace = failed ? info.outputPath(`browser-${index + 1}.zip`) : undefined;
      await context.tracing.stop(trace ? { path: trace } : {});
      if (trace) await info.attach(`browser-${index + 1}-trace`, { path: trace, contentType: 'application/zip' });
      const page = context.pages()[0];
      if (failed && page && !page.isClosed()) {
        const screenshot = info.outputPath(`browser-${index + 1}.png`);
        // A failed/hung host can leave lazy font requests unresolved. Evidence
        // capture must not consume teardown's entire budget before owned cleanup.
        await page.screenshot({ path: screenshot, fullPage: true, timeout: 5_000 });
        await info.attach(`browser-${index + 1}-screenshot`, { path: screenshot, contentType: 'image/png' });
      }
    }
    // Deliberately omit Cookie, bootstrap, CSRF, tickets and source text.
    await info.attach('real-wire-evidence', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      boots: this.boots.map((boot) => ({ pid: boot.pid, serverEpoch: boot.serverEpoch,
        statePersistence: boot.statePersistence, nativeDatabasePresent: boot.nativeDatabasePresent })),
      startupStages: this.startupStages,
      commands: this.proxy.commands.map((entry) => ({ method: entry.method, requestId: entry.request.requestId,
        originalId: entry.method === 'command.status' ? object(entry.request.input).requestId : undefined,
        status: entry.status, dropped: entry.dropped, ok: entry.response?.ok })),
      frames: this.proxy.frames.map((entry) => ({ socketId: entry.socketId, direction: entry.direction, type: entry.value.type,
        dropped: entry.dropped, sequence: entry.value.type === 'event' ? object(entry.value.event).sequence : undefined })),
      browserErrors: this.browserErrors, outbound: this.outbound }, null, 2)) });
  }
  async close(): Promise<void> {
    const failures: unknown[] = [];
    let ownedShutdownConfirmed = false;
    for (const context of this.contexts) { try { await context.close(); } catch (error) { failures.push(error); } }
    try {
      if (this.child?.connected) {
        const child = this.child;
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        const outcome = await this.rpc<{ status: string; providerCallsBlocked: number; nativePtySettled: boolean }>({ type: 'shutdown' });
        expect(outcome.status).toBe('settled');
        expect(outcome.providerCallsBlocked).toBe(0);
        expect(outcome.nativePtySettled).toBe(true);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([exited, new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => { reject(new Error('Fixture cleanup did not exit.')); }, 10_000);
          })]);
          ownedShutdownConfirmed = true;
        } finally { if (deadline) clearTimeout(deadline); }
      }
    } catch (error) { failures.push(error); }
    const child = this.child;
    try { if (child) await this.terminateOwnedChild(child); } catch (error) { failures.push(error); }
    try { await this.proxy.close(); } catch (error) { failures.push(error); }
    try { expect(this.browserErrors).toEqual([]); expect(this.outbound).toEqual([]); } catch (error) { failures.push(error); }
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      failures.push(new Error('Fixture owner settlement is unknown; its private files are retained.'));
    } else {
      this.child = null;
      if (ownedShutdownConfirmed) {
        try { await this.repositories.cleanup(); } catch (error) { failures.push(error); }
      } else failures.push(new Error('Host/native shutdown was not confirmed; private workspace files are retained even after the host PID exits.'));
    }
    if (failures.length) throw new AggregateError(failures, 'Real browser fixture cleanup/invariants failed.');
  }
}

export const test = base.extend<{ host: WebHost; terminalEnabled: boolean }>({
  terminalEnabled: [false, { option: true }],
  // Separate host construction from the unchanged 90s user-workflow budget.
  // A native restart scenario has TWO genuine cold boots; each boot still has
  // its original 60s Windows limit, and teardown must still prove settlement.
  host: [async ({ browser, terminalEnabled }, use, info) => {
    const host = await WebHost.start(browser, statePersistenceBackendSchema.parse(info.project.name), terminalEnabled);
    try { await use(host); }
    finally { try { await host.evidence(info); } finally { await host.close(); } }
  }, { timeout: 75_000 }],
});
export { expect };
export async function inspector(page: Page, destination: 'Work' | 'Run', tab: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Inspector destinations' }).getByRole('button', { name: destination, exact: true }).click();
  await page.getByRole('tab', { name: tab, exact: true }).click();
}
export async function actualTaskRow(page: Page, title: string, status: 'todo' | 'in-progress' | 'blocked' | 'done'): Promise<void> {
  const details = page.getByRole('region', { name: 'Host agents and tasks' });
  const strip = details.getByRole('region', { name: 'Task list strip', exact: true });
  const toggle = strip.getByRole('button', { name: /^(Expand|Collapse) task list$/ });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const row = strip.getByRole('list', { name: 'Task status' }).locator('li').filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-status', status);
  await expect(row.getByText(title, { exact: true })).toBeVisible();
}
