import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PI_THEME_CANDIDATES,
  MAX_PI_THEME_DIAGNOSTICS,
  MAX_PI_THEME_FILE_BYTES,
  MAX_PI_THEME_RESULTS,
  PI_THEME_REQUIRED_COLOR_KEYS,
  PiThemeService,
  ansi256ToHex,
  createPiThemeId,
  inferPiThemeTone,
  mapPiThemeToFateTheme,
  piColorToHex,
  resolvePiColorValue,
  validatePiThemeJson,
  type PiThemeColorValue,
  type PiThemeJson,
} from './PiThemeService';
import { isPiFunctionColor, piFunctionColorToHex } from './piThemeColor';

const temporaryDirectories: string[] = [];

type MutablePiTheme = {
  name: string;
  appearance?: 'dark' | 'light';
  vars?: Record<string, PiThemeColorValue>;
  colors: Record<string, PiThemeColorValue>;
  export?: { pageBg?: PiThemeColorValue; cardBg?: PiThemeColorValue; infoBg?: PiThemeColorValue };
};

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function themeJson(name: string, color: PiThemeColorValue = '#334455'): MutablePiTheme {
  return {
    name,
    colors: Object.fromEntries(PI_THEME_REQUIRED_COLOR_KEYS.map((key) => [key, color])),
  };
}

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fate-pi-themes-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeTheme(filePath: string, theme: PiThemeJson): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(theme), 'utf8');
}

async function writeBundledThemes(packageDir: string): Promise<void> {
  const directory = path.join(packageDir, 'dist', 'modes', 'interactive', 'theme');
  await writeTheme(path.join(directory, 'dark.json'), {
    ...themeJson('dark', '#30323a'),
    export: { pageBg: '#101218', cardBg: '#171b28' },
  });
  await writeTheme(path.join(directory, 'light.json'), {
    ...themeJson('light', '#d8dce5'),
    export: { pageBg: '#f5f7fb', cardBg: '#ffffff' },
  });
}

describe('Pi theme mapping', () => {
  it('resolves variables, ANSI 0-255 colors, and empty terminal defaults into all Fate tokens', () => {
    const input = themeJson('Ocean');
    input.vars = { cyan: 39, surface: '#18202a', terminal: '' };
    input.colors.accent = 'cyan';
    input.colors.selectedBg = 'surface';
    input.colors.text = 'terminal';
    input.colors.muted = 244;
    input.export = { pageBg: 'surface', cardBg: 236 };

    const mapped = mapPiThemeToFateTheme(input, { sourceIdentity: '/themes/ocean.json' });

    expect(mapped.id).toMatch(/^pi-ocean-[0-9a-f]{12}$/u);
    expect(mapped.name).toBe('Pi · Ocean');
    expect(mapped.tone).toBe('dark');
    expect(mapped.colors.accent).toBe('#00afff');
    expect(mapped.colors.canvas).toBe('#18202a');
    expect(mapped.colors.panel).toBe('#303030');
    expect(mapped.colors.text).toBe('#f0f2f7');
    expect(Object.keys(mapped.colors)).toHaveLength(20);
    expect(mapped.colors.currentSession).toBe('#18202a');
    expect(mapped.colors.lastActiveSession).toBe('#334455');
    expect(resolvePiColorValue('cyan', input.vars)).toBe(39);
    expect(piColorToHex('terminal', input.vars, '#abcdef')).toBe('#abcdef');
  });

  it('matches Pi ANSI palette conversion at basic, cube, and grayscale boundaries', () => {
    expect(ansi256ToHex(0)).toBe('#000000');
    expect(ansi256ToHex(15)).toBe('#ffffff');
    expect(ansi256ToHex(16)).toBe('#000000');
    expect(ansi256ToHex(39)).toBe('#00afff');
    expect(ansi256ToHex(231)).toBe('#ffffff');
    expect(ansi256ToHex(232)).toBe('#080808');
    expect(ansi256ToHex(255)).toBe('#eeeeee');
    expect(() => ansi256ToHex(256)).toThrow(/0 to 255/u);
  });

  it('infers light themes and bounds stable IDs and labels without splitting Unicode', () => {
    const input = {
      ...themeJson(`Very long light ${'🎨'.repeat(40)}`, '#222222'),
      export: { pageBg: '#ffffff', cardBg: '#f4f4f4' },
    };
    const first = mapPiThemeToFateTheme(input, '/same/source.json');
    const second = mapPiThemeToFateTheme(input, '/same/source.json');

    expect(inferPiThemeTone(input)).toBe('light');
    expect(first.tone).toBe('light');
    expect(first.id).toBe(second.id);
    expect(first.id.length).toBeLessThanOrEqual(48);
    expect(first.name.length).toBeLessThanOrEqual(48);
    expect(first.name.endsWith('…')).toBe(true);
    expect(createPiThemeId(input.name, '/other/source.json')).toBe(first.id);
  });

  it('rejects incomplete, invalid, and circular Pi theme data safely', () => {
    expect(() => validatePiThemeJson({ name: 'empty', colors: {} })).toThrow(/missing required color/u);
    expect(() => validatePiThemeJson({ ...themeJson('bad'), colors: { ...themeJson('bad').colors, accent: 256 } })).toThrow(/0 to 255/u);
    expect(() => validatePiThemeJson({
      ...themeJson('cycle'),
      vars: { first: 'second', second: 'first' },
      colors: { ...themeJson('cycle').colors, accent: 'first' },
    })).toThrow(/Circular/u);
    expect(() => validatePiThemeJson({ ...themeJson('bad/name') })).toThrow(/cannot contain/u);
  });

  it('maps Pi 1.0 function colors, short hex, and a declared appearance', () => {
    const input = themeJson('Modern');
    input.appearance = 'light';
    input.vars = { violet: 'okhsl(295 50% 67%)' };
    input.colors.accent = 'violet';
    input.colors.border = 'oklch(62% 0.2 250)';
    input.colors.text = '#AbC';

    const mapped = mapPiThemeToFateTheme(input);

    // The backgrounds are dark; the declared appearance still decides, as it does in Pi.
    expect(mapped.tone).toBe('light');
    expect(inferPiThemeTone({ ...input, appearance: undefined })).toBe('dark');
    expect(mapped.colors.accent).toBe(piFunctionColorToHex('okhsl(295 50% 67%)'));
    expect(mapped.colors.border).toBe(piFunctionColorToHex('oklch(62% 0.2 250)'));
    expect(mapped.colors.text).toBe('#aabbcc');
    expect(resolvePiColorValue('violet', input.vars)).toMatch(/^#[0-9a-f]{6}$/u);
    expect(() => validatePiThemeJson({ ...themeJson('bad'), appearance: 'sepia' })).toThrow(/appearance/u);
    expect(() => validatePiThemeJson({ ...themeJson('bad'), colors: { ...themeJson('bad').colors, accent: 'okhsl(10 120% 50%)' } })).toThrow(/saturation/u);
    expect(() => validatePiThemeJson({ ...themeJson('bad'), colors: { ...themeJson('bad').colors, accent: 'oklch(nope)' } })).toThrow(/Invalid Pi theme color value/u);
    expect(() => validatePiThemeJson({ ...themeJson('bad'), colors: { ...themeJson('bad').colors, accent: `okhsl(${'1'.repeat(200)} 1 1)` } })).toThrow(/too long/u);
    expect(() => validatePiThemeJson({ ...themeJson('bad'), colors: { ...themeJson('bad').colors, accent: '#abcd' } })).toThrow(/Invalid hex color/u);
  });

  it('converts OKHSL and OKLCH exactly as the installed Pi package does', async () => {
    // Pi's converter is a dependency of the SDK, not of Fate. Load it from beside the SDK.
    const sdkRoot = await realpath(path.resolve('node_modules/@earendil-works/pi-coding-agent'));
    const pi = await import(pathToFileURL(path.join(sdkRoot, '..', 'pi-tui', 'dist', 'colors.js')).href) as {
      parseColor(value: string): unknown;
      colorToHex(color: unknown): string;
    };
    const values: string[] = [];
    for (const name of ['dark', 'light']) {
      const bundled = JSON.parse(await readFile(path.join(sdkRoot, 'dist', 'modes', 'interactive', 'theme', `${name}.json`), 'utf8')) as PiThemeJson;
      for (const value of [...Object.values(bundled.vars ?? {}), ...Object.values(bundled.colors)]) {
        if (typeof value === 'string' && isPiFunctionColor(value)) values.push(value);
      }
    }
    const bundledCount = values.length;
    for (let hue = 0; hue < 360; hue += 30) {
      for (const saturation of [0, 35, 79, 80, 81, 100]) {
        for (const lightness of [0, 12, 50, 88, 100]) values.push(`okhsl(${hue} ${saturation}% ${lightness}%)`);
      }
    }
    for (let hue = 0; hue < 360; hue += 45) {
      for (const chroma of [0, 0.08, 0.2, 0.4]) {
        for (const lightness of [0, 0.3, 0.7, 1]) values.push(`oklch(${lightness} ${chroma} ${hue})`);
      }
    }
    values.push('OKHSL(295deg 0.5 0.67)', 'oklch(62% 0.2 250deg)', 'okhsl(-65 50% 67%)', 'oklch(100% 0.3 150)', 'okhsl( 1e1 .5 5e-1 )');

    // The bundled themes must really use function colors, or this test proves nothing about them.
    expect(bundledCount).toBeGreaterThan(20);
    for (const value of values) expect(piFunctionColorToHex(value), value).toBe(pi.colorToHex(pi.parseColor(value)));
  });
});

describe('PiThemeService', () => {
  it('uses explicit project trust, follows resolved ordering, and skips unavailable packages without installing', async () => {
    const root = await temporaryRoot();
    const packageDir = path.join(root, 'pi-package');
    const agentDir = path.join(root, 'agent');
    const projectDir = path.join(root, 'project');
    await writeBundledThemes(packageDir);
    const globalPath = path.join(agentDir, 'themes', 'global.json');
    const projectPath = path.join(projectDir, '.pi', 'themes', 'project.json');
    const oversizedPath = path.join(agentDir, 'themes', 'oversized.json');
    await writeTheme(globalPath, themeJson('Global'));
    await writeTheme(projectPath, themeJson('Project'));
    await mkdir(path.dirname(oversizedPath), { recursive: true });
    await writeFile(oversizedPath, Buffer.alloc(MAX_PI_THEME_FILE_BYTES + 1, 0x20));

    const missingActions: string[] = [];
    const trustDecisions: boolean[] = [];
    const service = new PiThemeService({
      agentDir,
      packageDir,
      cacheTtlMs: 0,
      settingsManagerFactory: (_cwd, _agentDir, trusted) => {
        trustDecisions.push(trusted);
        return SettingsManager.inMemory({}, { projectTrusted: trusted });
      },
      packageManagerFactory: () => ({
        resolve: async (onMissing) => {
          missingActions.push(await onMissing?.('npm:not-installed') ?? 'none');
          return {
            themes: [
              { path: projectPath, enabled: true, metadata: { scope: 'project' } },
              { path: globalPath, enabled: true, metadata: { scope: 'user' } },
              { path: path.join(root, 'disabled.json'), enabled: false, metadata: { scope: 'user' } },
              { path: oversizedPath, enabled: true, metadata: { scope: 'user' } },
            ],
          };
        },
      }),
    });

    const untrusted = await service.discover({ cwd: projectDir, projectTrusted: false });
    expect(untrusted.themes.map((theme) => theme.name)).toEqual(['Pi · dark', 'Pi · Global', 'Pi · light']);
    expect(untrusted.themes.some((theme) => theme.name === 'Pi · Project')).toBe(false);
    expect(untrusted.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('was not installed') }),
      expect.objectContaining({ message: expect.stringContaining('exceeds') }),
    ]));

    const trusted = await service.loadThemes({ cwd: projectDir, projectTrusted: true });
    expect(trusted.map((theme) => theme.name)).toContain('Pi · Project');
    expect(trustDecisions).toEqual([false, true]);
    expect(missingActions).toEqual(['skip', 'skip']);
    await expect(service.discover({ cwd: projectDir } as never)).rejects.toThrow(/explicit projectTrusted/u);
  });

  it('discovers Pi auto, configured, and local-package themes with the default public resolver', async () => {
    const root = await temporaryRoot();
    const packageDir = path.join(root, 'pi-package');
    const agentDir = path.join(root, 'agent');
    const projectDir = path.join(root, 'project');
    vi.stubEnv('HOME', root);
    await writeBundledThemes(packageDir);

    await writeTheme(path.join(agentDir, 'themes', 'global-auto.json'), themeJson('Global auto'));
    await writeTheme(path.join(agentDir, 'configured', 'global.json'), themeJson('Global configured'));
    await writeTheme(path.join(agentDir, 'theme-package', 'palette.json'), themeJson('Package theme'));
    await writeFile(path.join(agentDir, 'theme-package', 'package.json'), JSON.stringify({
      name: 'local-theme-package', version: '1.0.0', pi: { themes: ['palette.json'] },
    }), 'utf8');
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
      themes: ['configured/global.json'], packages: ['./theme-package'],
    }), 'utf8');

    await writeTheme(path.join(projectDir, '.pi', 'themes', 'project-auto.json'), themeJson('Project auto'));
    await writeTheme(path.join(projectDir, '.pi', 'configured.json'), themeJson('Project configured'));
    await writeFile(path.join(projectDir, '.pi', 'settings.json'), JSON.stringify({ themes: ['configured.json'] }), 'utf8');

    const service = new PiThemeService({ agentDir, packageDir, cacheTtlMs: 0 });
    const untrusted = await service.loadThemes({ cwd: projectDir, projectTrusted: false });
    expect(untrusted.map((theme) => theme.name)).toEqual(expect.arrayContaining([
      'Pi · dark', 'Pi · light', 'Pi · Global auto', 'Pi · Global configured', 'Pi · Package theme',
    ]));
    expect(untrusted.map((theme) => theme.name)).not.toEqual(expect.arrayContaining(['Pi · Project auto', 'Pi · Project configured']));

    const trusted = await service.loadThemes({ cwd: projectDir, projectTrusted: true });
    expect(trusted.map((theme) => theme.name)).toEqual(expect.arrayContaining(['Pi · Project auto', 'Pi · Project configured']));
  });

  it('discovers the standard themes bundled with the installed Pi package on a clean profile', async () => {
    // No fixture themes: this is the real package a consumer gets, with no Pi profile of their own.
    const root = await temporaryRoot();
    vi.stubEnv('HOME', root);
    const service = new PiThemeService({ agentDir: path.join(root, 'agent'), cacheTtlMs: 0 });

    const result = await service.discover({ cwd: root, projectTrusted: false });

    expect(result.diagnostics).toEqual([]);
    expect(result.themes.map((theme) => `${theme.name} (${theme.tone})`)).toEqual(['Pi · dark (dark)', 'Pi · light (light)']);
  });

  it('deduplicates concurrent requests and keeps only one short-lived cache entry', async () => {
    const root = await temporaryRoot();
    const packageDir = path.join(root, 'pi-package');
    await writeBundledThemes(packageDir);
    let now = 0;
    let resolutions = 0;
    const resolveGate = vi.fn(async () => {
      resolutions += 1;
      await Promise.resolve();
      return { themes: [] };
    });
    const service = new PiThemeService({
      agentDir: path.join(root, 'agent'),
      packageDir,
      cacheTtlMs: 2_000,
      now: () => now,
      settingsManagerFactory: (_cwd, _agentDir, trusted) => SettingsManager.inMemory({}, { projectTrusted: trusted }),
      packageManagerFactory: () => ({ resolve: resolveGate }),
    });
    const request = { cwd: path.join(root, 'project-a'), projectTrusted: false } as const;

    const [first, second] = await Promise.all([service.discover(request), service.discover(request)]);
    expect(first).toEqual(second);
    expect(resolutions).toBe(1);
    first.themes[0]!.colors.canvas = '#ffffff';
    expect((await service.discover(request)).themes[0]!.colors.canvas).toBe('#101218');
    expect(resolutions).toBe(1);

    now = 2_001;
    await service.discover(request);
    expect(resolutions).toBe(2);
    await service.discover({ cwd: path.join(root, 'project-b'), projectTrusted: false });
    await service.discover(request);
    expect(resolutions).toBe(4);
  });

  it('caps candidates, results, and diagnostics', async () => {
    const root = await temporaryRoot();
    const packageDir = path.join(root, 'pi-package');
    await writeBundledThemes(packageDir);
    const candidateDir = path.join(root, 'candidates');
    const candidates = await Promise.all(Array.from({ length: MAX_PI_THEME_CANDIDATES + 4 }, async (_, index) => {
      const filePath = path.join(candidateDir, `theme-${String(index).padStart(3, '0')}.json`);
      await writeTheme(filePath, themeJson(`Theme ${String(index).padStart(3, '0')}`));
      return { path: filePath, enabled: true, metadata: { scope: 'user' } };
    }));
    const service = new PiThemeService({
      agentDir: path.join(root, 'agent'),
      packageDir,
      cacheTtlMs: 0,
      settingsManagerFactory: (_cwd, _agentDir, trusted) => SettingsManager.inMemory({}, { projectTrusted: trusted }),
      packageManagerFactory: () => ({ resolve: async () => ({ themes: candidates }) }),
    });

    const result = await service.discover({ cwd: path.join(root, 'project'), projectTrusted: false });

    expect(result.themes).toHaveLength(MAX_PI_THEME_RESULTS);
    expect(result.diagnostics.length).toBeLessThanOrEqual(MAX_PI_THEME_DIAGNOSTICS);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('candidate limit') }),
      expect.objectContaining({ message: expect.stringContaining('result limit') }),
    ]));
  });
});
