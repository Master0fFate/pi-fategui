// @vitest-environment node
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopFatePaths, FatePaths } from '../../src/core/FatePaths';
import { prepareFateProviderStorage } from '../../src/main/pi/FateProviderStorage';

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function homeDirectory() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'fate-paths-'));
  homes.push(home);
  vi.stubEnv('FATE_GUI_DATA_DIR', '');
  vi.stubEnv('PI_CODING_AGENT_DIR', '');
  return home;
}

describe('FatePaths', () => {
  it('describes existing desktop paths without creating directories', async () => {
    const home = await homeDirectory();
    const paths = createDesktopFatePaths({ home, temporaryDirectory: path.join(home, 'tmp') });
    expect(paths.dataRoot).toBe(path.join(home, '.pi', 'fateGUI'));
    expect(paths.piAgentDir).toBe(path.join(home, '.pi', 'agent'));
    expect(paths.sessionsRoot).toBe(path.join(home, '.pi', 'agent', 'sessions'));
    expect(paths.profileId).toBe('desktop');
    expect(Object.isFrozen(paths)).toBe(true);
    for (const location of [paths.dataRoot, paths.piAgentDir, paths.sessionsRoot, paths.attachmentRoot, paths.lockRoot]) {
      await expect(access(location)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(path.relative(paths.dataRoot, paths.lockRoot)).toMatch(/^\.\./u);
  });

  it('does not suppress provider first-run credential import, even when the separate lock root exists', async () => {
    const home = await homeDirectory();
    const paths = createDesktopFatePaths({ home });
    await mkdir(paths.piAgentDir, { recursive: true });
    await mkdir(paths.lockRoot, { recursive: true });
    await writeFile(path.join(paths.piAgentDir, 'auth.json'), '{"fixture":"not-a-real-credential"}');
    const result = await prepareFateProviderStorage({ dataRoot: paths.dataRoot, piAgentDir: paths.piAgentDir });
    expect(result.firstRun).toBe(true);
    expect(result.imported).toEqual(['auth.json']);
    await expect(readFile(path.join(paths.dataRoot, 'auth.json'), 'utf8')).resolves.toContain('not-a-real-credential');
    expect((await prepareFateProviderStorage({ dataRoot: paths.dataRoot, piAgentDir: paths.piAgentDir })).firstRun).toBe(false);
  });

  it('honors explicit desktop overrides without mutating the environment', async () => {
    const home = await homeDirectory();
    vi.stubEnv('FATE_GUI_DATA_DIR', path.join(home, 'fate-profile'));
    vi.stubEnv('PI_CODING_AGENT_DIR', '~/pi-custom');
    const paths = createDesktopFatePaths({ home, profileId: 'desktop-2' });
    expect(paths.dataRoot).toBe(path.join(home, 'fate-profile'));
    expect(paths.piAgentDir).toBe(path.join(home, 'pi-custom'));
    expect(process.env.PI_CODING_AGENT_DIR).toBe('~/pi-custom');
    const explicit = createDesktopFatePaths({ home, dataRoot: path.join(home, 'other'), piAgentDir: path.join(home, 'agent-override') });
    expect(explicit.dataRoot).toBe(path.join(home, 'other'));
    expect(explicit.sessionsRoot).toBe(path.join(home, 'agent-override', 'sessions'));
  });

  it('requires explicit absolute paths for a non-desktop profile', async () => {
    const home = await homeDirectory();
    const desktop = createDesktopFatePaths({ home });
    expect(() => new FatePaths({ ...desktop, dataRoot: 'relative-root' })).toThrow('absolute host paths');
    expect(() => new FatePaths({ ...desktop, profileId: '' })).toThrow('profile identity');
  });
});
