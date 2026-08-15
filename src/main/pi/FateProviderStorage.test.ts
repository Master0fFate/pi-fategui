import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareFateProviderStorage } from './FateProviderStorage';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fate-provider-storage-'));
  temporaryRoots.push(root);
  return root;
}

describe('prepareFateProviderStorage', () => {
  it('copies only Pi auth and model files when Fate UI starts for the first time', async () => {
    const root = await fixtureRoot();
    const piAgentDir = path.join(root, '.pi', 'agent');
    const fateRoot = path.join(root, '.pi', 'fateGUI');
    await mkdir(path.join(piAgentDir, 'sessions'), { recursive: true });
    await writeFile(path.join(piAgentDir, 'auth.json'), '{"openai":{"type":"oauth"}}\n');
    await writeFile(path.join(piAgentDir, 'models.json'), '{"providers":[]}\n');
    await writeFile(path.join(piAgentDir, 'sessions', 'shared.jsonl'), 'shared session\n');
    await writeFile(path.join(piAgentDir, 'settings.json'), '{"mcp":true}\n');

    const result = await prepareFateProviderStorage({ dataRoot: fateRoot, piAgentDir });

    expect(result.firstRun).toBe(true);
    expect(result.imported).toEqual(['auth.json', 'models.json']);
    await expect(readFile(result.paths.authPath, 'utf8')).resolves.toBe('{"openai":{"type":"oauth"}}\n');
    await expect(readFile(result.paths.modelsPath, 'utf8')).resolves.toBe('{"providers":[]}\n');
    await expect(readFile(path.join(fateRoot, 'sessions', 'shared.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(fateRoot, 'settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a non-file provider target instead of following it', async () => {
    const root = await fixtureRoot();
    const fateRoot = path.join(root, '.pi', 'fateGUI');
    await prepareFateProviderStorage({ dataRoot: fateRoot, piAgentDir: path.join(root, '.pi', 'agent') });
    await mkdir(path.join(fateRoot, 'auth.json'));

    await expect(prepareFateProviderStorage({ dataRoot: fateRoot })).rejects.toThrow(/regular file/u);
  });

  it('never imports or overwrites Pi provider files after Fate UI storage exists', async () => {
    const root = await fixtureRoot();
    const piAgentDir = path.join(root, '.pi', 'agent');
    const fateRoot = path.join(root, '.pi', 'fateGUI');
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(fateRoot, { recursive: true });
    await writeFile(path.join(piAgentDir, 'auth.json'), '{"pi":"credential"}\n');
    await writeFile(path.join(piAgentDir, 'models.json'), '{"pi":"models"}\n');
    await writeFile(path.join(fateRoot, 'auth.json'), '{"fate":"credential"}\n');

    const result = await prepareFateProviderStorage({ dataRoot: fateRoot, piAgentDir });

    expect(result).toMatchObject({ firstRun: false, imported: [] });
    await expect(readFile(path.join(fateRoot, 'auth.json'), 'utf8')).resolves.toBe('{"fate":"credential"}\n');
    await expect(readFile(path.join(fateRoot, 'models.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
