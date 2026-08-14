import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builtInThemes } from '../../shared/themes';
import { AppLogService } from '../logging/AppLogService';

const appState = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => appState.userData } }));

import { SettingsService } from './SettingsService';

let directory = '';
let dataRoot = '';

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'pi-settings-'));
  appState.userData = directory;
  dataRoot = path.join(directory, 'fateGUI');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function createSettings(logs = new AppLogService(), piThemes: ConstructorParameters<typeof SettingsService>[2] = {
  discover: async () => ({ themes: [], diagnostics: [] }),
}) {
  return new SettingsService(logs, dataRoot, piThemes);
}

describe('SettingsService', () => {
  it('persists and reloads validated settings atomically', async () => {
    const logs = new AppLogService();
    const service = createSettings(logs);
    const saved = await service.set({
      appearance: 'system', defaultModel: 'provider/model', thinkingLevel: 'high', agentTeamMode: 'v2',
      confirmRiskyCommands: false, terminalShell: 'pwsh.exe', reduceMotion: true, performanceMode: true, holyShitMode: true, musicPlayerEnabled: true, sendMessageWithModifier: true, compactSessions: false, themeId: 'graphite',
      interfaceFont: 'poppins', codeFont: 'noto-sans-mono',
      imageGeneration: { provider: 'google', model: 'gemini-3.1-flash-image', customProvider: null },
      speech: { enabled: true, modelId: 'parakeet-unified', language: 'auto', inputDeviceId: null, liveTranscription: true, finalAccuracyPass: false, voiceHotkey: null, voiceHotkeyMode: 'toggle' },
    });

    expect(saved.reduceMotion).toBe(true);
    expect(saved.holyShitMode).toBe(true);
    expect(saved.musicPlayerEnabled).toBe(true);
    expect(saved.sendMessageWithModifier).toBe(true);
    expect(saved.interfaceFont).toBe('poppins');
    expect(JSON.parse(await readFile(path.join(dataRoot, 'settings.json'), 'utf8'))).toEqual(saved);
    expect(await createSettings(logs).load()).toEqual(saved);
    expect(logs.list().at(-1)?.message).toContain('saved');
  });

  it('migrates valid legacy settings when the new store is absent', async () => {
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({
      appearance: 'system', defaultModel: null, thinkingLevel: 'high', confirmRiskyCommands: false, terminalShell: null, reduceMotion: true, performanceMode: false,
    }), 'utf8');
    const logs = new AppLogService();
    const loaded = await createSettings(logs).load();
    expect(loaded).toMatchObject({ appearance: 'system', thinkingLevel: 'high', holyShitMode: false, sendMessageWithModifier: false, interfaceFont: 'noto-sans', codeFont: 'jetbrains-mono', imageGeneration: { provider: 'auto', model: null, customProvider: null } });
    expect(JSON.parse(await readFile(path.join(dataRoot, 'settings.json'), 'utf8'))).toEqual(loaded);
  });

  it('merges validated custom JSON themes with built-ins', async () => {
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, 'themes.json'), JSON.stringify({ themes: [{
      id: 'storm', name: 'Storm', tone: 'dark', colors: {
        canvas: '#101218', panel: '#151821', raised: '#1c202b', raisedHover: '#252b38', border: '#303746', borderStrong: '#444d60',
        text: '#f0f2f7', textSoft: '#c5cad5', muted: '#8d96a8', subtle: '#657084', accent: '#6f8cff', accentHover: '#8ca2ff', accentSoft: '#222b49',
        onAccent: '#ffffff', success: '#55c78a', warning: '#d2a94b', danger: '#e35d6a', shadow: '#020308',
      },
    }] }), 'utf8');
    const themes = await createSettings().loadThemes();
    expect(themes.map((theme) => theme.id)).toEqual(expect.arrayContaining(['catppuccin-mocha', 'catppuccin-latte', 'midnight', 'daylight', 'storm']));
  });

  it('merges Pi themes using the explicit Fate project trust decision', async () => {
    const piTheme = { ...builtInThemes[2]!, id: 'pi-terminal-0123456789ab', name: 'Pi · Terminal' };
    const discover = vi.fn(async () => ({ themes: [piTheme], diagnostics: [] }));
    const themes = await createSettings(new AppLogService(), { discover }).loadThemes({
      path: '/trusted/project', name: 'project', trusted: true,
    });

    expect(discover).toHaveBeenCalledWith({ cwd: '/trusted/project', projectTrusted: true });
    expect(themes).toEqual(expect.arrayContaining([piTheme]));
  });

  it('recovers to defaults and records a warning for malformed persisted data', async () => {
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, 'settings.json'), '{not-json', 'utf8');
    const logs = new AppLogService();

    const loaded = await createSettings(logs).load();

    expect(loaded).toMatchObject({ appearance: 'dark', thinkingLevel: 'medium', confirmRiskyCommands: true });
    expect(logs.list()).toEqual(expect.arrayContaining([expect.objectContaining({ level: 'warn', scope: 'settings' })]));
  });

  it('serializes concurrent writes and returns each persisted snapshot', async () => {
    const logs = new AppLogService();
    const service = createSettings(logs);
    const first = { appearance: 'dark', defaultModel: null, thinkingLevel: 'low', agentTeamMode: 'legacy', confirmRiskyCommands: true, terminalShell: null, reduceMotion: false, performanceMode: false, holyShitMode: false, musicPlayerEnabled: false, sendMessageWithModifier: false, compactSessions: false, themeId: 'midnight', interfaceFont: 'noto-sans', codeFont: 'jetbrains-mono', imageGeneration: { provider: 'auto', model: null, customProvider: null }, speech: { enabled: true, modelId: 'canary-flash', language: 'auto', inputDeviceId: null, liveTranscription: true, finalAccuracyPass: false, voiceHotkey: null, voiceHotkeyMode: 'toggle' } } as const;
    const second = { ...first, thinkingLevel: 'high' as const, reduceMotion: true };

    const [firstSaved, secondSaved] = await Promise.all([service.set(first), service.set(second)]);

    expect(firstSaved).toEqual(first);
    expect(secondSaved).toEqual(second);
    expect(service.get()).toEqual(second);
    expect(JSON.parse(await readFile(path.join(dataRoot, 'settings.json'), 'utf8'))).toEqual(second);
  });
});
