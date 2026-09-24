import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyAutomations, legacyDocumentPath } from './LegacyAutomations';

const id = '00000000-0000-4000-8000-000000000001';
const source = (projectPath: string, name = 'Review') => ({
  id, projectPath, name, prompt: 'Review the changes.', permissionLevel: 'read-only' as const,
  createdAt: 1, updatedAt: 2, lastLaunchedAt: null, lastLaunchOutcome: null, launchCount: 0,
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('LegacyAutomations', () => {
  it('reads the retired hashed document, sorts entries, and never writes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-automations-')); roots.push(root);
    const projectPath = path.join(root, 'project'); await fs.mkdir(projectPath);
    const first = source(projectPath, 'Zed'); const second = { ...source(projectPath), id: '00000000-0000-4000-8000-000000000002', name: 'Alpha', updatedAt: 3 };
    const target = legacyDocumentPath(projectPath, root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const bytes = JSON.stringify({ version: 1, projectPath, automations: [first, second] }, null, 2) + '\n';
    await fs.writeFile(target, bytes);
    const logs = { write: vi.fn() };
    const reader = new LegacyAutomations(logs, root);
    expect(await reader.list(projectPath)).toEqual([second, first]);
    expect(await fs.readFile(target, 'utf8')).toBe(bytes);
    expect(logs.write).not.toHaveBeenCalled();
  });

  it('returns an empty list and logs when the archive is malformed or belongs to another project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-automations-')); roots.push(root);
    const projectPath = path.join(root, 'project'); await fs.mkdir(projectPath);
    const target = legacyDocumentPath(projectPath, root); await fs.mkdir(path.dirname(target), { recursive: true });
    const logs = { write: vi.fn() }; const reader = new LegacyAutomations(logs, root);
    await fs.writeFile(target, '{not-json');
    await expect(reader.list(projectPath)).resolves.toEqual([]);
    await fs.writeFile(target, JSON.stringify({ version: 1, projectPath: path.join(root, 'other'), automations: [source(projectPath)] }));
    await expect(reader.list(projectPath)).resolves.toEqual([]);
    expect(logs.write).toHaveBeenCalledTimes(2);
  });

  it('does not expose a missing project archive as an error', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-automations-')); roots.push(root);
    const logs = { write: vi.fn() };
    await expect(new LegacyAutomations(logs, root).list(path.join(root, 'missing'))).resolves.toEqual([]);
    expect(logs.write).not.toHaveBeenCalled();
  });
});
