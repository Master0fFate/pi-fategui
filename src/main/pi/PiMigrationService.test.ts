import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiMigrationService } from './PiMigrationService';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'fate-pi-migration-'));
  roots.push(root);
  const pi = path.join(root, '.pi', 'agent');
  const fate = path.join(root, '.pi', 'fateGUI');
  await mkdir(pi, { recursive: true });
  await mkdir(fate, { recursive: true });
  return { root, pi, fate, service: new PiMigrationService(pi, fate, root) };
}

// All fixtures use synthetic profile files; no personal credentials or live servers are read.
describe('PiMigrationService', () => {
  it('merges missing providers and basic global MCP without replacing Fate settings or invoking servers', async () => {
    const { root, pi, fate, service } = await fixture();
    await writeFile(path.join(pi, 'auth.json'), JSON.stringify({ old: { type: 'api_key', key: 'SYNTHETIC' }, new: { type: 'api_key', key: 'SYNTHETIC2' } }));
    await writeFile(path.join(fate, 'auth.json'), JSON.stringify({ old: { type: 'api_key', key: 'FATE-ONLY' } }));
    await writeFile(path.join(pi, 'models.json'), JSON.stringify({ providers: { first: { baseUrl: 'https://first.test' }, next: { baseUrl: 'https://next.test' } } }));
    await writeFile(path.join(fate, 'models.json'), JSON.stringify({ providers: { first: { baseUrl: 'https://fate.test' } } }));
    await mkdir(path.join(root, '.config', 'mcp'), { recursive: true });
    await writeFile(path.join(root, '.config', 'mcp', 'mcp.json'), JSON.stringify({ mcpServers: {
      docs: { command: 'not-a-real-server', args: ['--safe'] },
      disabled: { url: 'https://example.org/mcp', disabled: true },
      advanced: { url: 'https://example.org/mcp', headers: { Authorization: 'SECRET' } },
    } }));
    await writeFile(path.join(fate, 'mcp-servers.json'), JSON.stringify([{ name: 'existing', enabled: true, transport: 'http', url: 'https://example.net/mcp' }]));
    const before = await service.inspect();
    expect(before).toMatchObject({ providerEntriesToImport: 2, providerConflicts: 2, mcpServersToImport: 2, mcpServersSkipped: 1 });
    const result = await service.importMissing();
    expect(result).toMatchObject({ providerEntriesImported: 2, providerConflicts: 2, mcpServersImported: 2, mcpServersSkipped: 1 });
    const auth = JSON.parse(await readFile(path.join(fate, 'auth.json'), 'utf8'));
    expect(auth).toEqual({ old: { type: 'api_key', key: 'FATE-ONLY' }, new: { type: 'api_key', key: 'SYNTHETIC2' } });
    const models = JSON.parse(await readFile(path.join(fate, 'models.json'), 'utf8'));
    expect(models.providers).toEqual({ first: { baseUrl: 'https://fate.test' }, next: { baseUrl: 'https://next.test' } });
    const mcp = JSON.parse(await readFile(path.join(fate, 'mcp-servers.json'), 'utf8'));
    expect(mcp).toHaveLength(3);
    expect(mcp.find((entry: { name: string }) => entry.name === 'disabled')).toMatchObject({ enabled: false });
    expect(JSON.stringify(mcp)).not.toContain('SECRET');
    await expect(service.importMissing()).resolves.toMatchObject({ providerEntriesImported: 0, mcpServersImported: 0 });
    expect(await readFile(path.join(pi, 'auth.json'), 'utf8')).toContain('SYNTHETIC2');
  });

  it('reports project-local extensions and MCP config as blockers without loading them', async () => {
    const { root, service } = await fixture();
    const project = path.join(root, 'project');
    await mkdir(path.join(project, '.pi', 'extensions'), { recursive: true });
    await writeFile(path.join(project, '.pi', 'extensions', 'unsafe.js'), 'throw new Error("never execute");');
    await writeFile(path.join(project, '.mcp.json'), '{"mcpServers":{}}');
    const report = await service.inspect(project);
    expect(report).toMatchObject({ projectExtensionsBlocked: true, projectMcpRequiresBridge: true });
    expect(report.warnings.join(' ')).toMatch(/Project-local Pi extensions are blocked/u);
  });

  it('keeps the existing Pi MCP bridge and does not add duplicate Fate servers', async () => {
    const { root, pi, fate, service } = await fixture();
    await writeFile(path.join(pi, 'settings.json'), JSON.stringify({ packages: [{ source: 'npm:pi-mcp-adapter@2.34.0' }] }));
    await writeFile(path.join(pi, 'mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'node', args: ['index.js'] } } }));
    expect(await service.inspect()).toMatchObject({ bridgeConfigured: true, sharedSettings: true, mcpServersToImport: 1 });
    expect(await service.importMissing()).toMatchObject({ mcpServersImported: 0 });
    await expect(readFile(path.join(fate, 'mcp-servers.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(root).toBeTruthy();
  });

  it.skipIf(process.platform === 'win32')('refuses a symbolic-link credential source or target', async () => {
    const { root, pi, fate, service } = await fixture();
    const outside = path.join(root, 'outside.json');
    await writeFile(outside, '{"stolen":"NO"}');
    await symlink(outside, path.join(pi, 'auth.json'));
    await expect(service.importMissing()).rejects.toThrow(/Unsafe or oversized/u);
    await rm(path.join(pi, 'auth.json'));
    await writeFile(path.join(pi, 'auth.json'), '{"pi":"YES"}');
    await symlink(outside, path.join(fate, 'auth.json'));
    await expect(service.importMissing()).rejects.toThrow(/Unsafe or oversized/u);
    await expect(readFile(outside, 'utf8')).resolves.toBe('{"stolen":"NO"}');
  });

  it('does not write any provider file if a later migration input is corrupt', async () => {
    const { pi, fate, service } = await fixture();
    await writeFile(path.join(pi, 'auth.json'), '{"pi":{"type":"api_key","key":"SYNTHETIC"}}');
    await writeFile(path.join(pi, 'models.json'), 'not JSON');
    await expect(service.importMissing()).rejects.toThrow();
    await expect(readFile(path.join(fate, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not turn a prototype key into object inheritance', async () => {
    const { pi, fate, service } = await fixture();
    await writeFile(path.join(pi, 'auth.json'), '{"__proto__":{"polluted":true}}');
    await service.importMissing();
    expect(JSON.parse(await readFile(path.join(fate, 'auth.json'), 'utf8'))).toHaveProperty('__proto__');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
