import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { privateTestRoot } from '../v2/helpers/isolatedEnvironment';
import { disposeProductionCliBuild, mustRetainCliFixture, runNoninteractiveCli } from './helpers/productionCliProcess';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) if (!mustRetainCliFixture(root)) await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});
afterAll(disposeProductionCliBuild);
async function fixture() {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'cli-init-example-')); roots.push(root);
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace space & dollar$');
  await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(workspace, { mode: 0o700 });
  await fs.writeFile(path.join(workspace, 'sentinel.txt'), 'No execution during initialization.\n');
  return { root, home, workspace: await fs.realpath(workspace) };
}

describe('actual built CLI explicit profile examples (no listener/provider)', () => {
  it('persists native storage and explicit unsandboxed terminal opt-in from literal argv without starting an engine', async () => {
    const { home, workspace } = await fixture();
    const result = await runNoninteractiveCli(home, ['init', '--profile', 'native-web', '--workspace', workspace, '--trust-workspace',
      '--port', '47119', '--state-persistence', 'native-durable', '--max-permission', 'edit', '--manual-terminal', '--accept-unsandboxed-shell']);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.output).toContain('No agent was started.');
    expect(result.output).toContain('unsandboxed execution-host shell');
    const profile = path.join(home, '.pi', 'fate-server', 'native-web');
    const descriptor: unknown = JSON.parse(await fs.readFile(path.join(profile, 'server.json'), 'utf8'));
    expect(descriptor).toEqual({ version: 1, profileId: 'native-web', workspaces: [workspace], host: '127.0.0.1', port: 47119,
      maxPermission: 'edit', statePersistence: 'native-durable', workspaceTrustAccepted: true,
      flags: { terminal: true, terminalWarningAccepted: true, browser: false } });
    await expect(fs.stat(path.join(profile, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(profile, 'pi'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(workspace, 'sentinel.txt'), 'utf8')).toBe('No execution during initialization.\n');
  });

  it('rejects a missing shell acknowledgement before creating a host profile', async () => {
    const { home, workspace } = await fixture();
    const result = await runNoninteractiveCli(home, ['init', '--profile', 'rejected', '--workspace', workspace, '--trust-workspace',
      '--max-permission', 'edit', '--manual-terminal']);
    expect(result.exitCode).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.output).toContain('Invalid CLI mode or argument');
    await expect(fs.stat(path.join(home, '.pi', 'fate-server', 'rejected'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
