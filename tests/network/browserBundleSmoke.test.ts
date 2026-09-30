import { createServer as createNetServer } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium, expect as browserExpect } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { ownerCredentialPath } from '../../src/server/auth/AuthStore';
import { startAuthenticatedNodeServerWithFactory } from '../../src/server/http/startAuthenticatedNodeServer';
import { MultiProjectPiRuntime } from '../../src/main/pi/MultiProjectPiRuntime';
import type { MonitorDashboard, MonitorReadInput } from '../../src/shared/contracts/monitorDashboard';
import { FakePiSdkAdapter } from '../v2/helpers/fakePi';
import { privateTestRoot } from '../v2/helpers/isolatedEnvironment';

async function freePort(): Promise<number> {
  const probe = createNetServer();
  return new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') { probe.close(); reject(new Error('No loopback port')); return; }
    probe.close(() => resolve(address.port));
  }).once('error', reject));
}

/** Build the real browser entry, without the production config's fixed dist/web output. */
async function buildDisposableWebBundle(directory: string): Promise<void> {
  await build({ configFile: false, root: path.resolve('.'), base: '/', plugins: [react()],
    resolve: { alias: {
      '@renderer': path.resolve('src/renderer'), '@shared': path.resolve('src/shared'),
      'monaco-editor-esm': path.resolve('node_modules/monaco-editor/esm/vs'),
    } },
    build: { outDir: directory, emptyOutDir: true, assetsInlineLimit: 0,
      rollupOptions: { input: path.resolve('web.html') } }, logLevel: 'error' });
  await fs.rename(path.join(directory, 'web.html'), path.join(directory, 'index.html'));
}

// The ordinary network suite has no browser executable in its private HOME.
// The explicit smoke runner passes one preinstalled Chromium executable path.
describe.skipIf(!process.env.FATE_BROWSER_CHROMIUM_EXECUTABLE)('T39 real Chromium browser bundle over authenticated loopback HTTP and WS', () => {
  it('consumes a code once, recovers on reload, and pages a partial/unknown Monitor without Electron', async () => {
    const root = await fs.mkdtemp(path.join(privateTestRoot(), 'browser-bundle-'));
    const adapter = new FakePiSdkAdapter();
    let server: Awaited<ReturnType<typeof startAuthenticatedNodeServerWithFactory>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    // AuthStore captures its clock at startup; keep an injectable monotonic clock
    // for the final expiry assertion rather than replacing Date.now afterward.
    const wallNow = Date.now;
    let fixtureNow = wallNow();
    vi.spyOn(Date, 'now').mockImplementation(() => fixtureNow);
    try {
      const home = path.join(root, 'home');
      const workspace = path.join(root, 'workspace');
      const built = path.join(root, 'web');
      await Promise.all([fs.mkdir(home), fs.mkdir(workspace)]);
      await buildDisposableWebBundle(built);
      const port = await freePort();
      const url = `http://127.0.0.1:${port}`;
      server = await startAuthenticatedNodeServerWithFactory({ profile: { profileId: 'browser-smoke', home }, workspaces: [workspace],
        host: '127.0.0.1', port, flags: { terminal: false, browser: false }, maxPermission: 'edit' },
      (options) => createFateCore({ ...options, adapter,
        createRuntime: (deps) => new MultiProjectPiRuntime({ ...deps,
          createSessionTitleGenerator: () => ({ generate: async () => null }) }) }), () => {}, built);
      const runtime = server.core.runtime.peekWorkspace(workspace);
      if (!runtime) throw new Error('Fixture runtime not registered.');
      const selectedSessionId = runtime.getState(false).sessionId;
      if (!selectedSessionId) throw new Error('Fixture has no selected host session.');
      const sentinel = path.join(workspace, 'browser-smoke.txt');
      await fs.writeFile(sentinel, 'before browser prompt\n');
      adapter.plannedEdits.set(selectedSessionId, { path: sentinel, before: 'before browser prompt\n', after: 'after browser prompt\n' });
      const monitorReads: MonitorReadInput[] = [];
      // Fake only the core's monitor data. HTTP, auth, dispatcher, ticket, WS,
      // browser adapter, bundled App, and DOM are production code.
      vi.spyOn(runtime, 'getMonitorDashboard').mockImplementation(async (query) => {
        monitorReads.push(query ?? {});
        const selectedSession = runtime.getState(false).sessionId;
        if (!selectedSession) throw new Error('Fixture has no selected session.');
        const section = query?.section ?? 'overview';
        const offset = query?.offset ?? 0;
        const limit = query?.limit ?? 25;
        const now = Date.now();
        const total = section === 'runs' ? 27 : 0;
        const items: MonitorDashboard['items'] = section !== 'runs' ? []
          : Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => ({
            id: `private-run-${offset + index}`, source: 'runs' as const, state: 'active' as const,
            title: `Private provider text ${offset + index}`, detail: 'must not be shipped', updatedAt: now,
            ref: { kind: 'run' as const, id: `private-run-${offset + index}` },
          }));
        return { projectPath: workspace, sessionId: selectedSession, checkedAt: now, revision: 'smoke-revision',
          overall: 'unknown', sources: { runs: 'partial', teams: 'unknown', tasks: 'ready', activity: 'ready' },
          sourceCheckedAt: { runs: now, teams: null, tasks: now, activity: now },
          counts: { active: 27, attention: 0, runs: 27, teams: 0, tasks: 0, activity: 0 },
          section, total, offset, limit, unchanged: false, items };
      });
      const owner = await fs.readFile(ownerCredentialPath(server.core.paths), 'utf8');
      const { code } = await server.auth.createBootstrapCode(owner);
      const websocketPaths: string[] = [];
      server.http.server.on('upgrade', (request) => { websocketPaths.push(request.url ?? ''); });
      browser = await chromium.launch({ executablePath: process.env.FATE_BROWSER_CHROMIUM_EXECUTABLE!,
        headless: true, args: ['--disable-background-networking'] });
      const context = await browser.newContext({ baseURL: url, serviceWorkers: 'block' });
      await context.route('**/*', (route) => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
      const page = await context.newPage();
      const commandMethods: string[] = [];
      const statusIds: string[] = [];
      const responses: string[] = [];
      const browserErrors: string[] = [];
      page.on('pageerror', (error) => browserErrors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
      page.on('request', (request) => { if (request.url() === `${url}/api/command`) {
        const body = request.postDataJSON() as { method?: string; input?: { requestId?: string } };
        if (body.method) commandMethods.push(body.method);
        if (body.method === 'command.status' && body.input?.requestId) statusIds.push(body.input.requestId);
      } });
      page.on('response', (response) => { if (response.url().startsWith(`${url}/api/`)) responses.push(`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`); });
      // Static serving rejects query strings before the entry can load. A
      // fragment reaches the entry without being sent to the HTTP server.
      expect((await context.request.get(`${url}/?code=discard-me`)).status()).toBe(400);
      await page.goto('/#fragment-secret');
      await browserExpect(page.getByLabel('One-time code')).toBeVisible({ timeout: 10_000 }).catch(async (error: unknown) => {
        throw new Error(`Login failed at ${page.url()}; body: ${(await page.locator('body').innerText()).slice(0, 800)}; errors: ${browserErrors.join(' | ')}`, { cause: error });
      });
      expect(page.url()).toBe(`${url}/`);
      expect(await page.evaluate(() => 'piDesktop' in window)).toBe(false);
      await page.getByLabel('One-time code').fill(code);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await browserExpect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 20_000 }).catch(async (error: unknown) => {
        throw new Error(`Workspace failed: ${(await page.locator('body').innerText()).slice(0, 1000)}; errors: ${browserErrors.join(' | ')}; api: ${responses.join(' | ')}; ws: ${websocketPaths.join(',')}`, { cause: error });
      });
      await page.getByRole('navigation', { name: 'Inspector destinations' }).getByRole('button', { name: 'Run' }).click();
      await page.getByRole('tab', { name: 'Monitor' }).click();
      await browserExpect(page.getByRole('region', { name: 'Monitoring dashboard' })).toContainText('Unavailable: teams', { timeout: 10_000 }).catch(async (error: unknown) => {
        throw new Error(`Monitor failed: ${(await page.locator('body').innerText()).slice(0, 1600)}; errors: ${browserErrors.join(' | ')}; api: ${responses.join(' | ')}; commands: ${commandMethods.join(',')}`, { cause: error });
      });
      await browserExpect(page.getByRole('region', { name: 'Monitoring dashboard' })).toContainText('Runs: latest 1,000 only.');
      await browserExpect(page.getByRole('region', { name: 'Monitoring dashboard' })).toContainText('does not prove there is no active work');
      await page.getByRole('region', { name: 'Monitoring dashboard' }).getByRole('button', { name: /Runs/ }).click();
      await browserExpect(page.getByRole('region', { name: 'Monitoring dashboard' }).locator('.monitor-dashboard-row')).toHaveCount(25);
      await page.getByRole('region', { name: 'Monitoring dashboard' }).getByRole('button', { name: 'Next' }).click();
      await browserExpect(page.getByRole('region', { name: 'Monitoring dashboard' }).locator('.monitor-dashboard-row')).toHaveCount(2);
      await browserExpect(page.getByRole('region', { name: 'Monitoring dashboard' })).toContainText('26–27 / 27');
      expect(monitorReads.some((query) => query.section === 'runs' && query.offset === 25 && query.limit === 25)).toBe(true);
      expect(await page.getByRole('region', { name: 'Monitoring dashboard' }).innerText()).not.toContain('Private provider text');
      expect(websocketPaths).toContain('/api/events');
      expect(commandMethods).toEqual(expect.arrayContaining(['host.info', 'workspace.list', 'workspace.snapshot', 'workspace.monitor']));
      expect(responses).toContain('POST /api/auth/exchange 200');
      // Drop only the original HTTP response AFTER the real server has admitted
      // the command. The browser adapter must query status, not resend a prompt.
      const promptText = 'Apply the fixture edit in the selected host session.';
      let dropped: { requestId: string; workspaceId: string; expectedSessionId: string; controlGeneration: number } | undefined;
      let admitted: { ok: boolean; result?: { requestId: string; kind: string; outcome: string; sessionId: string; durability: string } } | undefined;
      await browserExpect(page.getByRole('button', { name: 'Claim control' })).toBeEnabled({ timeout: 10_000 });
      await browserExpect(page.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
      await page.getByRole('button', { name: 'Claim control' }).click();
      await browserExpect(page.getByRole('button', { name: 'Release control' })).toBeEnabled();
      await page.route(`${url}/api/command`, async (route) => {
        const request = route.request().postDataJSON() as { method: string; requestId: string; workspaceId: string;
          expectedSessionId: string; controlGeneration: number; input: { text?: string } };
        if (request.method !== 'runtime.prompt') { await route.continue(); return; }
        if (dropped) throw new Error('Browser sent a second runtime.prompt instead of reviewing its original request.');
        expect(request.input.text).toBe(promptText);
        dropped = { requestId: request.requestId, workspaceId: request.workspaceId,
          expectedSessionId: request.expectedSessionId, controlGeneration: request.controlGeneration };
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        admitted = await response.json() as typeof admitted;
        await route.abort('failed');
      });
      await page.getByLabel('Message to selected host session').fill(promptText);
      // A real pointer must reach the button; the browser guidance must not cover it.
      await page.getByRole('button', { name: 'Send prompt' }).click();
      await browserExpect(page.getByRole('button', { name: 'Review original request' })).toBeVisible({ timeout: 15_000 });
      expect(dropped).toMatchObject({ expectedSessionId: selectedSessionId, controlGeneration: expect.any(Number) });
      expect(admitted).toMatchObject({ ok: true, result: { requestId: dropped!.requestId, kind: 'prompt',
        outcome: 'accepted', sessionId: selectedSessionId, durability: 'journaled' } });
      expect(adapter.invocations.filter((entry) => entry.kind === 'prompt' && entry.input === promptText)).toHaveLength(1);
      await vi.waitFor(async () => expect(await fs.readFile(sentinel, 'utf8')).toBe('after browser prompt\n'));
      await browserExpect(page.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
      await browserExpect(page.getByRole('button', { name: 'Review original request' })).toBeEnabled();
      await page.getByRole('button', { name: 'Review original request' }).click();
      await browserExpect(page.getByText(`Original request ${dropped!.requestId} was admitted. The run may still be active.`)).toBeVisible({ timeout: 10_000 });
      expect(commandMethods.filter((method) => method === 'runtime.prompt')).toHaveLength(1);
      expect(commandMethods.filter((method) => method === 'command.status').length).toBeGreaterThanOrEqual(2);
      expect(statusIds).toEqual(expect.arrayContaining([dropped!.requestId]));
      expect(statusIds.every((id) => id === dropped!.requestId)).toBe(true);
      expect(adapter.invocations.filter((entry) => entry.kind === 'prompt')).toHaveLength(1);
      await vi.waitFor(() => expect(runtime.getState(false).activeSessionRunning).toBe(false));
      expect(adapter.invocations.filter((entry) => entry.kind === 'toolResult' && entry.name === 'edit')).toHaveLength(1);
      const firstSession = await context.request.get(`${url}/api/auth/session`);
      expect(firstSession.status()).toBe(200);
      const firstSessionId = (await firstSession.json() as { session: { sessionId: string } }).session.sessionId;
      const exchanges = responses.filter((entry) => entry.startsWith('POST /api/auth/exchange')).length;
      await page.reload();
      await browserExpect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 20_000 });
      expect(responses.filter((entry) => entry.startsWith('POST /api/auth/exchange')).length).toBe(exchanges);
      expect((await context.request.get(`${url}/api/auth/session`)).status()).toBe(200);
      expect((await (await context.request.get(`${url}/api/auth/session`)).json() as { session: { sessionId: string } }).session.sessionId).toBe(firstSessionId);
      expect(JSON.stringify(await page.evaluate(() => ({ url: location.href, history: history.state,
        local: Object.entries(localStorage), session: Object.entries(sessionStorage) })))).not.toContain(code);
      const reused = await context.request.post(`${url}/api/auth/exchange`, { headers: { Origin: url }, data: { code } });
      expect(reused.status()).toBe(403); // The logged-in cookie itself forbids another exchange.
      const fresh = await browser.newContext({ baseURL: url });
      const secondUse = await fresh.request.post(`${url}/api/auth/exchange`, { headers: { Origin: url }, data: { code } });
      expect(secondUse.status()).toBe(401);
      const hostile = await context.request.get(`${url}/`, { headers: { Origin: 'http://evil.example' } });
      expect(hostile.status()).toBe(403);
      const expired = await server.auth.createBootstrapCode(owner);
      // Move the host's captured monotonic clock after the one-use code expires.
      fixtureNow = expired.expiresAt + 1;
      const stale = await fresh.request.post(`${url}/api/auth/exchange`, { headers: { Origin: url }, data: { code: expired.code } });
      expect(stale.status()).toBe(401);
      await fresh.close();
      await context.close();
    } finally {
      vi.restoreAllMocks();
      await browser?.close();
      if (server) expect((await server.stop()).status).toBe('settled');
      await adapter.dispose();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 180_000);
});
