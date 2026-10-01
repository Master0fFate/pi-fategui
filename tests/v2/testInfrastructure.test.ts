import { describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PiSdkAdapter } from '../../src/main/pi/PiRuntimeService';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { assertPrivatePath, isWithin, privateTestRoot, withGitFixture } from './helpers/isolatedEnvironment';

const launcherUrl = pathToFileURL(path.resolve('scripts/run-v2-tests.mjs')).href;
const webLauncherUrl = pathToFileURL(path.resolve('scripts/run-web-tests.mjs')).href;
function probe(source: string, args: string[] = []): unknown {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source, ...args], { encoding: 'utf8' }));
}

function selectWebBrowser(env: Record<string, string>): unknown {
  return probe(`
    const { selectChromiumExecutable } = await import(${JSON.stringify(webLauncherUrl)});
    try { console.log(JSON.stringify(await selectChromiumExecutable(${JSON.stringify(env)}))); }
    catch (error) { console.log(JSON.stringify({ error: error.message })); }
  `);
}

async function withBrowserSelectionFixture(run: (fixture: {
  root: string; cache: string; cached: string; executable: string; nonExecutable: string;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(privateTestRoot(), 'browser-selection-'));
  try {
    const cache = path.join(root, 'cache');
    const relative = process.platform === 'win32' ? 'chrome-win64/chrome.exe'
      : process.platform === 'darwin' ? 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
        : 'chrome-linux64/chrome';
    // Filesystem-only selection fixtures, never launched as browsers or cache installations.
    for (const revision of ['41', '42']) {
      const cached = path.join(cache, `chromium-${revision}`, relative);
      await mkdir(path.dirname(cached), { recursive: true });
      await writeFile(cached, 'selection fixture: never execute\n', { mode: 0o700 });
    }
    const executable = path.join(root, 'explicit browser; literal');
    const nonExecutable = path.join(root, 'non-executable');
    await writeFile(executable, 'selection fixture: never execute\n', { mode: 0o700 });
    await writeFile(nonExecutable, 'not executable\n', { mode: 0o600 });
    await run({ root, cache, cached: path.join(cache, 'chromium-42', relative), executable, nonExecutable });
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe('isolated v2 test infrastructure', () => {
  test('runs under Node without Electron and rejects Electron imports', () => {
    expect(process.versions.electron).toBeUndefined();
    expect(typeof document).toBe('undefined');
    const require = createRequire(import.meta.url);
    expect(Object.keys(require.cache).some((file) => /[\\/]electron[\\/]/.test(file))).toBe(false);
    expect(() => require('electron')).toThrow('V2_ELECTRON_BLOCKED');
  });

  test('all home, app, Pi, Fate and temporary roots are contained before Pi import', async () => {
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
      'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'PI_CODING_AGENT_DIR', 'FATE_GUI_DATA_DIR', 'TEMP', 'TMP', 'TMPDIR']) {
      const value = process.env[key];
      expect(value, key).toBeTruthy();
      if (!value) throw new Error(`Missing ${key}`);
      await assertPrivatePath(value);
    }
    const { getAgentDir } = await import('@earendil-works/pi-coding-agent');
    expect(await realpath(getAgentDir())).toBe(await realpath(process.env.PI_CODING_AGENT_DIR!));
  });

  test('allowlists environment, strips secrets and injection, retains absolute tool PATH', () => {
    const output = probe(`
      const { createIsolatedEnvironment } = await import(${JSON.stringify(launcherUrl)});
      const item = await createIsolatedEnvironment({
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        OPENAI_API_KEY: 'sentinel-not-a-key', ANTHROPIC_API_KEY: 'sentinel-not-a-key',
        AWS_PROFILE: 'private', GOOGLE_APPLICATION_CREDENTIALS: '/real/credentials',
        NODE_OPTIONS: '--require /unsafe', NODE_PATH: '/unsafe', ELECTRON_RUN_AS_NODE: '1',
        HTTPS_PROXY: 'http://unsafe', NPM_CONFIG_USERCONFIG: '/private', HOME: '/real/home', UNKNOWN_KEY: 'secret'
      });
      try { console.log(JSON.stringify({ env: item.env, root: item.root })); } finally { await item.cleanup(); }
    `);
    expect(output).toEqual(expect.objectContaining({ env: expect.not.objectContaining({ OPENAI_API_KEY: expect.anything() }) }));
    const parsed = typeof output === 'object' && output !== null && 'env' in output ? output.env : null;
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid probe result');
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS',
      'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'HTTPS_PROXY', 'NPM_CONFIG_USERCONFIG', 'UNKNOWN_KEY']) {
      expect(key in parsed, key).toBe(false);
    }
    if (!('PATH' in parsed) || typeof parsed.PATH !== 'string') throw new Error('Missing PATH');
    expect(parsed.PATH.split(path.delimiter).every((entry) => path.isAbsolute(entry))).toBe(true);
    expect(execFileSync('git', ['--version'], { encoding: 'utf8' })).toMatch(/^git version/);
  });

  test('forwards every CLI argument exactly without the Electron prefix', async () => {
    const args = ['tests/v2/testInfrastructure.test.ts', '-t', 'a spaced name', '--reporter=json', '--', 'literal;not-shell', ''];
    const output = probe(`const { buildV2Command } = await import(${JSON.stringify(launcherUrl)});
      console.log(JSON.stringify(buildV2Command(process.argv.slice(1))));`, args);
    expect(output).toEqual([path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'runner', '--config', path.resolve('vitest.v2.config.ts'), ...args]);
    const packageJson: unknown = JSON.parse(await readFile('package.json', 'utf8'));
    expect(packageJson).toHaveProperty('scripts.test:v2', 'node scripts/run-v2-tests.mjs');
  });

  test('web browser override takes precedence and resolves its actual executable without launching it', async () => {
    await withBrowserSelectionFixture(async (fixture) => {
      const alias = path.join(fixture.root, 'cache-alias');
      await symlink(fixture.cache, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const requested = path.join(alias, path.relative(fixture.cache, fixture.cached));
      const selected = selectWebBrowser({ PLAYWRIGHT_BROWSERS_PATH: path.join(fixture.root, 'missing-cache'),
        FATE_WEB_CHROMIUM_EXECUTABLE: requested });
      expect(selected).toEqual({ cache: path.join(fixture.root, 'missing-cache'), executable: await realpath(fixture.cached) });
      expect(selectWebBrowser({ PLAYWRIGHT_BROWSERS_PATH: fixture.cache,
        FATE_WEB_CHROMIUM_EXECUTABLE: fixture.executable }))
        .toEqual({ cache: fixture.cache, executable: await realpath(fixture.executable) });
    });
  });

  test('web browser override rejects invalid values without PATH lookup or cache fallback', async () => {
    await withBrowserSelectionFixture(async (fixture) => {
      const invalid = ['', '   ', 'chromium', './chromium', path.join(fixture.root, 'missing'), fixture.root,
        ...(process.platform === 'win32' ? [] : [fixture.nonExecutable])];
      for (const requested of invalid) {
        expect(selectWebBrowser({ PLAYWRIGHT_BROWSERS_PATH: fixture.cache,
          FATE_WEB_CHROMIUM_EXECUTABLE: requested }), JSON.stringify(requested))
          .toEqual({ error: expect.stringContaining('FATE_WEB_CHROMIUM_EXECUTABLE must') });
      }
    });
  });

  test('web browser selection preserves newest installed cache discovery when no override is supplied', async () => {
    await withBrowserSelectionFixture(async (fixture) => {
      expect(selectWebBrowser({ PLAYWRIGHT_BROWSERS_PATH: fixture.cache }))
        .toEqual({ cache: fixture.cache, executable: fixture.cached });
      expect(selectWebBrowser({ PLAYWRIGHT_BROWSERS_PATH: path.join(fixture.root, 'missing-cache') }))
        .toEqual({ error: expect.stringContaining('this runner never downloads a browser') });
    });
  });

  test.each([0, 7])('launcher sets roots before entry, forwards actual argv, and cleans only a confirmed successful run (exit %i)', async (exitCode) => {
    const args = ['with spaces', 'literal;not-shell', ''];
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { runIsolated } = await import(${JSON.stringify(launcherUrl)});
      const code = await runIsolated(['--input-type=module', '-e',
        'console.log(JSON.stringify({ root: process.env.FATE_V2_TEST_ROOT, home: process.env.HOME, args: process.argv.slice(1), secret: process.env.OPENAI_API_KEY })); process.exitCode = ${exitCode}',
        ...${JSON.stringify(args)}], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OPENAI_API_KEY: 'sentinel-not-a-key' } });
      process.exitCode = code;
    `], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(exitCode);
    const output: unknown = JSON.parse(result.stdout.trim());
    expect(output).toEqual({ root: expect.any(String), home: expect.any(String), args });
    if (typeof output !== 'object' || output === null || !('root' in output) || typeof output.root !== 'string'
      || !('home' in output) || typeof output.home !== 'string') throw new Error('Invalid child probe');
    expect(isWithin(output.root, output.home)).toBe(true);
    expect(existsSync(output.root)).toBe(exitCode !== 0);
    if (exitCode !== 0) {
      // Failed wrappers retain evidence even when ownership markers are lost.
      // This probe has no descendant process: it reports its own actual exit.
      await assertPrivatePath(output.root);
      expect(result.stderr).toContain('TEST_FIXTURE_RETAINED');
    }
  });

  test('blocks outbound provider attempts before network access', async () => {
    await expect(fetch('https://provider.invalid/v1/messages')).rejects.toThrow('V2_OUTBOUND_BLOCKED');
    const https = await import('node:https');
    expect(() => https.request('https://provider.invalid/v1/messages')).toThrow('V2_OUTBOUND_BLOCKED');
    const net = await import('node:net');
    expect(() => net.connect(443, 'provider.invalid')).toThrow('V2_OUTBOUND_BLOCKED');
  });

  test('explicit v2 Node and connection DOM projects preserve exact collection boundaries', async () => {
    const { createFilter } = await import('vite');
    const desktop = (await import('../../vitest.config')).default;
    let rendererChecked = false;
    for (const project of desktop.test?.projects ?? []) {
      if (typeof project !== 'object' || !('test' in project) || !project.test) continue;
      const collect = createFilter(project.test.include, project.test.exclude);
      for (const file of ['src/core/example.test.ts', 'src/server/example.test.tsx',
        'src/client/example.test.ts', 'src/protocol/example.test.ts', 'src/shared/protocol/example.test.ts', 'src/main/connections/example.test.ts', 'src/main/v2/example.test.ts',
        'src/renderer/v2/example.test.tsx', 'tests/v2/example.test.ts']) {
        expect(collect(path.resolve(file).split(path.sep).join('/')), `${project.test.name}: ${file}`).toBe(false);
      }
      if (project.test.name === 'renderer') {
        rendererChecked = true;
        expect(collect(path.resolve('src/renderer/example.test.tsx').split(path.sep).join('/'))).toBe(true);
      }
    }
    expect(rendererChecked).toBe(true);
    const config = (await import('../../vitest.v2.config')).default;
    const v2Projects = config.test?.projects ?? [];
    const names: string[] = [];
    const cases = [
      ['tests/v2/testInfrastructure.test.ts', 'v2-node'],
      ['tests/v2/example.test.tsx', 'v2-node'],
      ['src/core/example.test.ts', 'v2-node'],
      ['src/server/example.test.tsx', 'v2-node'],
      ['src/client/example.test.ts', 'v2-node'],
      ['src/protocol/example.test.ts', 'v2-node'],
      ['src/shared/protocol/example.test.ts', 'v2-node'],
      ['src/main/connections/example.test.ts', 'v2-node'],
      ['src/main/v2/example.test.ts', 'v2-node'],
      ['src/renderer/v2/example.test.tsx', 'v2-node'],
      ['tests/v2/connectionUi.test.tsx', 'v2-connection-ui'],
      ['src/renderer/features/connections/ConnectionStatus.test.tsx', 'v2-connection-ui'],
      ['src/renderer/features/connections/WorkspaceControlPanel.test.tsx', 'v2-connection-ui'],
      ['src/renderer/features/chat/Composer.test.tsx', null],
      ['src/renderer/features/shell/Inspector.test.tsx', null],
      ['tests/web/workspace.spec.ts', null],
      ['tests/e2e/pi-desktop.spec.ts', null],
    ] as const;
    for (const project of v2Projects) {
      if (typeof project !== 'object' || !('test' in project) || !project.test) {
        throw new Error('V2 projects must expose their explicit test configuration for boundary review.');
      }
      const name = project.test.name;
      if (typeof name !== 'string') throw new Error('V2 project requires an explicit name.');
      names.push(name);
      expect(project.test.environment, `${name}: environment`).toBe(name === 'v2-node' ? 'node' : 'jsdom');
      const collect = createFilter(project.test.include, project.test.exclude);
      for (const [file, owner] of cases) {
        expect(collect(path.resolve(file).split(path.sep).join('/')), `${name}: ${file}`).toBe(owner === name);
      }
    }
    expect(names.sort()).toEqual(['v2-connection-ui', 'v2-node']);
  });

  test('two Git repositories have local identities, independent sentinels, recorded writes and failure cleanup', async () => {
    let fixtureRoot = '';
    await expect(withGitFixture(async (fixture) => {
      fixtureRoot = fixture.root;
      expect(fixture.before.a.sentinel).not.toBe(fixture.before.b.sentinel);
      expect(fixture.sessions.a).not.toBe(fixture.sessions.b);
      expect(fixture.goals.a).not.toBe(fixture.goals.b);
      expect(execFileSync('git', ['-C', fixture.a, 'config', '--local', 'user.email'], { encoding: 'utf8' }).trim()).toBe('v2-fixture@example.invalid');
      await fixture.write(fixture.a, 'sentinel.txt', 'A changed only\n');
      expect(await fixture.snapshot(fixture.b)).toEqual(fixture.before.b);
      expect((await fixture.snapshot(fixture.a)).head).toBe(fixture.before.a.head);
      expect((await fixture.snapshot(fixture.a)).status).toContain('sentinel.txt');
      expect(fixture.writes).toHaveLength(1);
      await expect(fixture.write(fixture.a, '../../outside', 'bad')).rejects.toThrow('escapes');
      await expect(fixture.write(fixture.a, path.join(privateTestRoot(), 'pi/agent/auth.json'), 'bad')).rejects.toThrow('escapes');
      // Junctions work without symlink privileges on Windows.
      await symlink(fixture.b, path.join(fixture.a, 'other-repository'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(fixture.write(fixture.a, 'other-repository/sentinel.txt', 'bad')).rejects.toThrow('escapes');
      expect(await fixture.snapshot(fixture.b)).toEqual(fixture.before.b);
      throw new Error('deliberate fixture failure');
    })).rejects.toThrow('deliberate fixture failure');
    expect(existsSync(fixtureRoot)).toBe(false);
  });

  test('imports the real production runtime under the no-Electron guard', async () => {
    // T09 removed the native dependency instead of mocking it. Core composition
    // tests separately exercise actual fake-SDK admission and shutdown.
    const { PiRuntimeService } = await import('../../src/main/pi/PiRuntimeService');
    expect(typeof PiRuntimeService).toBe('function');
    expect(process.versions.electron).toBeUndefined();
  });

  test('real PiSdkAdapter seam has deterministic IDs, named acceptance/emission/settlement barriers and cancellation refusal', async () => {
    await withGitFixture(async (fixture) => {
      const fake = new FakePiSdkAdapter();
      const adapter: PiSdkAdapter = fake;
      try {
        const models = await adapter.createModelRuntime();
        const runtime = await adapter.createRuntime(fixture.a, models);
        const second = await adapter.createRuntime(fixture.b, models);
        expect(runtime.session.sessionId).toBe('00000000-0000-4000-8000-000000000001');
        expect(second.session.sessionId).toBe('00000000-0000-4000-8000-000000000002');
        const control = fake.controls.get(runtime.session.sessionId)!;
        for (const name of ['accept', 'emit', 'settle', 'cancelFailure', 'acknowledge'] as const) control.barriers.hold(name);
        const events: string[] = [];
        const unsubscribe = runtime.session.subscribe((event) => { events.push(event.type); });
        const running = runtime.session.prompt('private fixture prompt');
        await control.barriers.reached('accept');
        expect(runtime.session.isStreaming).toBe(false);
        expect(fake.invocations.filter((call) => call.kind === 'accepted')).toHaveLength(0);
        control.barriers.release('accept');
        await control.barriers.reached('emit');
        expect(runtime.session.isStreaming).toBe(true);
        control.refuseCancellation = true;
        const cancelled = expect(runtime.session.abort()).rejects.toThrow('refused cancellation');
        await control.barriers.reached('cancelFailure');
        expect(runtime.session.isStreaming).toBe(true);
        control.barriers.release('cancelFailure');
        await cancelled;
        expect(runtime.session.isStreaming).toBe(true);
        control.barriers.release('emit');
        await control.barriers.reached('settle');
        expect(events).toContain('message_end');
        expect(events).not.toContain('agent_settled');
        await fake.invokeTool(runtime.session.sessionId, 'write', { path: 'sentinel.txt' }, () => fixture.write(fixture.a, 'sentinel.txt', 'fake tool write\n'));
        expect(fake.invocations.filter((call) => call.kind === 'tool')).toHaveLength(1);
        expect(await fixture.snapshot(fixture.b)).toEqual(fixture.before.b);
        control.barriers.release('settle');
        await control.barriers.reached('acknowledge');
        expect(events).toContain('agent_settled');
        expect(runtime.session.isStreaming).toBe(false);
        control.barriers.release('acknowledge');
        await running;
        unsubscribe();
        expect(fake.invocations.filter((call) => call.kind === 'prompt')).toEqual([
          expect.objectContaining({ turnId: 'fake-turn-0001', sessionId: runtime.session.sessionId }),
        ]);
        const available = await models.getAvailable();
        const model = available[0];
        if (!model) throw new Error('Missing fake model');
        await expect(models.completeSimple(model, { messages: [] })).rejects.toThrow('V2_PROVIDER_BLOCKED');
        expect(fake.invocations.filter((call) => call.kind === 'providerBlocked')).toHaveLength(1);
      } finally { await fake.dispose(); }
    });
  });
});
