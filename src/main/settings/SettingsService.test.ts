import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLogService } from '../logging/AppLogService';

const appState = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => appState.userData } }));

import { SettingsService } from './SettingsService';

let directory = '';

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'pi-settings-'));
  appState.userData = directory;
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('SettingsService', () => {
  it('persists and reloads validated settings atomically', async () => {
    const logs = new AppLogService();
    const service = new SettingsService(logs);
    const saved = await service.set({
      appearance: 'system', defaultModel: 'provider/model', thinkingLevel: 'high',
      confirmRiskyCommands: false, terminalShell: 'pwsh.exe', reduceMotion: true,
    });

    expect(saved.reduceMotion).toBe(true);
    expect(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'))).toEqual(saved);
    expect(await new SettingsService(logs).load()).toEqual(saved);
    expect(logs.list().at(-1)?.message).toContain('saved');
  });

  it('recovers to defaults and records a warning for malformed persisted data', async () => {
    await writeFile(path.join(directory, 'settings.json'), '{not-json', 'utf8');
    const logs = new AppLogService();

    const loaded = await new SettingsService(logs).load();

    expect(loaded).toMatchObject({ appearance: 'dark', thinkingLevel: 'medium', confirmRiskyCommands: true });
    expect(logs.list()).toEqual(expect.arrayContaining([expect.objectContaining({ level: 'warn', scope: 'settings' })]));
  });
});
