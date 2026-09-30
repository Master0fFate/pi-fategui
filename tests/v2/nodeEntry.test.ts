import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { parseServerConfig } from '../../src/server/config';
import { startTestNodeServer } from './helpers/nodeServerFactory';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(privateTestRoot(), 'node-entry-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  return { root, home, workspace, config: {
    profile: { profileId: 'test', home }, workspaces: [workspace], host: '127.0.0.1', port: 47819,
    flags: { terminal: false, browser: false }, maxPermission: 'edit',
  } };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })));
});

describe('Node-only server entry', () => {
  it('starts with a test-only fake adapter, safe permission cap, null browser, and no listener', async () => {
    const { config, workspace } = await fixture();
    const adapter = new FakePiSdkAdapter();
    const server = await startTestNodeServer(config, adapter);
    try {
      expect(server.readiness).toMatchObject({ ready: true, profileLock: 'held', workspaceRegistry: 'ready',
        permissionStore: 'healthy', commandJournal: 'healthy', provider: 'auth-required', listener: 'disabled',
        configuredPort: config.port, maxPermission: 'edit', registeredWorkspaces: [workspace] });
      expect(server.core.workspaces).not.toBeNull();
      expect(server.core.runtime.peekWorkspace(workspace)).toBeNull();
      expect(server.core.savedAgents).toBeNull();
      expect(adapter.invocations.filter((entry) => entry.kind === 'createModelRuntime')).toHaveLength(0);
      const competingAdapter = new FakePiSdkAdapter();
      try { await expect(startTestNodeServer(config, competingAdapter)).rejects.toThrow(); } // Profile lock is owned.
      finally { await competingAdapter.dispose(); }
    } finally { expect(await server.stop()).toEqual({ status: 'settled' }); await adapter.dispose(); }
  });

  it('rejects unknown, unsafe, aliased or unsupported host config before ownership', async () => {
    const { config, workspace } = await fixture();
    const invalid = [
      { ...config, unexpected: true }, { ...config, host: '0.0.0.0' }, { ...config, host: 'localhost' },
      { ...config, port: '47819' }, { ...config, port: 0 }, { ...config, port: 65_536 },
      { ...config, flags: { ...config.flags, terminal: true } }, { ...config, flags: { ...config.flags, browser: true } },
      { ...config, maxPermission: 'owner' }, { ...config, profile: { ...config.profile, extra: true } },
      { ...config, workspaces: [workspace, workspace] }, { ...config, workspaces: ['relative/path'] },
    ];
    for (const input of invalid) await expect(parseServerConfig(input)).rejects.toThrow();
  });

  it('fails closed on a corrupt grant store after the lock is acquired and releases the lock after clean teardown', async () => {
    const { config, home } = await fixture();
    const dataRoot = path.join(home, '.pi', 'fate-server', 'test', 'data');
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dataRoot, 'session-permissions.json'), '{bad json');
    const adapter = new FakePiSdkAdapter();
    try {
      await expect(startTestNodeServer(config, adapter)).rejects.toThrow('permission');
      await rm(path.join(dataRoot, 'session-permissions.json'));
      const restarted = await startTestNodeServer(config, adapter);
      expect(restarted.readiness.provider).toBe('auth-required');
      expect(await restarted.stop()).toEqual({ status: 'settled' });
    } finally { await adapter.dispose(); }
  });

  it('rejects a damaged command journal without declaring readiness', async () => {
    const { config, home } = await fixture();
    const journalRoot = path.join(home, '.pi', 'fate-server', 'test', 'data', 'commands', 'v1');
    await mkdir(journalRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(journalRoot, 'unknown.json'), '{}');
    const adapter = new FakePiSdkAdapter();
    try {
      await expect(startTestNodeServer(config, adapter)).rejects.toThrow();
      await rm(path.join(journalRoot, 'unknown.json'));
      const restarted = await startTestNodeServer(config, adapter);
      expect(restarted.readiness.commandJournal).toBe('healthy');
      expect(await restarted.stop()).toEqual({ status: 'settled' });
    } finally { await adapter.dispose(); }
  });

  it('builds an independent artifact and imports/starts it in a real Node process without Electron or a socket', async () => {
    const { config, home } = await fixture();
    const output = path.resolve('.test-dist', `node-entry-${randomUUID()}`);
    try {
      await build({ configFile: path.resolve('vite.server.config.ts'), build: { outDir: output, emptyOutDir: true } });
      const entry = pathToFileURL(path.join(output, 'main.js')).href;
      const script = `import net from 'node:net';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (/^(electron|node-pty|transcribe-cpp|uiohook-napi)(?:$|\\/)/.test(specifier)) throw new Error('UNEXPECTED_NATIVE_IMPORT: ' + specifier);
  return next(specifier, context);
} });
process.dlopen = function () { throw new Error('UNEXPECTED_NATIVE_ADDON'); };
net.Server.prototype.listen = function () { throw new Error('UNEXPECTED_LISTENER'); };
const { startNodeServer } = await import(${JSON.stringify(entry)});
const server = await startNodeServer(JSON.parse(process.argv[1]));
if (!server.readiness.ready || server.readiness.provider !== 'auth-required' || server.readiness.listener !== 'disabled') throw new Error('NOT_READY');
if ((await server.stop()).status !== 'settled') throw new Error('INCOMPLETE_SHUTDOWN');
console.log('NODE_ENTRY_OK');`;
      const guard = pathToFileURL(path.resolve('tests/v2/helpers/nodeGuard.mjs')).href;
      const result = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e', script, JSON.stringify(config)], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
          FATE_GUI_DATA_DIR: path.join(home, '.pi', 'desktop-data') },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('NODE_ENTRY_OK');
    } finally { await rm(output, { recursive: true, force: true, maxRetries: 3 }); }
  }, 120_000); // Real Rollup build and separate Node startup can exceed the 5s unit-test default.
});
