import type { Display, Rectangle } from 'electron';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppLogService } from './logging/AppLogService';
import {
  MINIMUM_WINDOW_SIZE,
  WindowStateService,
  defaultWindowPlacement,
  resolveWindowPlacement,
  type WindowPlacement,
} from './windowState';

function createDisplay(
  id: number,
  workArea: Rectangle,
  size: Readonly<{ width: number; height: number }> = workArea,
  scaleFactor = 1,
): Display {
  return {
    id,
    bounds: { ...workArea },
    workArea: { ...workArea },
    size: { ...size },
    workAreaSize: { width: workArea.width, height: workArea.height },
    scaleFactor,
  } as Display;
}

let directory = '';
let dataRoot = '';

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'fate-window-state-'));
  dataRoot = path.join(directory, 'fateGUI');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('window placement', () => {
  it('uses a centered 1280x720 default on a 1080p display', () => {
    const display = createDisplay(1, { x: 0, y: 0, width: 1920, height: 1040 }, { width: 1920, height: 1080 });

    expect(defaultWindowPlacement(display)).toEqual({
      bounds: { x: 320, y: 160, width: 1280, height: 720 },
      maximized: false,
    });
  });

  it('uses a centered 1920x1080 default on a scaled 4K display', () => {
    const display = createDisplay(1, { x: 0, y: 0, width: 2560, height: 1360 }, { width: 2560, height: 1440 }, 1.5);

    expect(defaultWindowPlacement(display)).toEqual({
      bounds: { x: 320, y: 140, width: 1920, height: 1080 },
      maximized: false,
    });
  });

  it('restores the exact saved position and size on the monitor where it was closed', () => {
    const primary = createDisplay(1, { x: 0, y: 0, width: 1920, height: 1040 });
    const secondary = createDisplay(2, { x: -1920, y: 0, width: 1920, height: 1040 });
    const remembered: WindowPlacement = {
      bounds: { x: -1600, y: 120, width: 1400, height: 800 },
      maximized: false,
    };

    expect(resolveWindowPlacement(remembered, [primary, secondary], primary)).toEqual(remembered);
  });

  it('keeps restored windows visible when work-area dimensions change', () => {
    const display = createDisplay(1, { x: 0, y: 0, width: 1920, height: 1040 });
    const remembered: WindowPlacement = {
      bounds: { x: -100, y: -100, width: 2500, height: 1400 },
      maximized: false,
    };

    expect(resolveWindowPlacement(remembered, [display], display)).toEqual({
      bounds: { x: 0, y: 0, width: 1920, height: 1040 },
      maximized: false,
    });
  });

  it('preserves a 600px window and clamps smaller remembered widths', () => {
    const display = createDisplay(1, { x: 0, y: 0, width: 1920, height: 1040 });
    const placement = (width: number): WindowPlacement => ({
      bounds: { x: 40, y: 30, width, height: MINIMUM_WINDOW_SIZE.height },
      maximized: false,
    });

    expect(resolveWindowPlacement(placement(600), [display], display).bounds.width).toBe(600);
    expect(resolveWindowPlacement(placement(420), [display], display).bounds.width).toBe(600);
  });

  it('recovers an off-screen window on the primary display while preserving maximized state', () => {
    const primary = createDisplay(1, { x: 0, y: 0, width: 1920, height: 1040 }, { width: 1920, height: 1080 });
    const remembered: WindowPlacement = {
      bounds: { x: 5000, y: 200, width: 1400, height: 800 },
      maximized: true,
    };

    expect(resolveWindowPlacement(remembered, [primary], primary)).toEqual({
      bounds: { x: 320, y: 160, width: 1280, height: 720 },
      maximized: true,
    });
  });
});

describe('WindowStateService', () => {
  it('persists and reloads the last normal bounds and maximized state', async () => {
    const placement: WindowPlacement = {
      bounds: { x: 80, y: 60, width: 1500, height: 850 },
      maximized: true,
    };
    const service = new WindowStateService(new AppLogService(), dataRoot);
    await service.load();
    service.save(placement);
    await service.flush();

    expect(JSON.parse(await readFile(path.join(dataRoot, 'window-state.json'), 'utf8'))).toEqual({
      version: 1,
      ...placement,
    });

    const reloaded = new WindowStateService(new AppLogService(), dataRoot);
    await reloaded.load();
    const display = createDisplay(1, { x: 0, y: 0, width: 1920, height: 1040 });
    expect(reloaded.resolve([display], display)).toEqual(placement);
  });

  it('falls back safely and logs a warning for malformed saved state', async () => {
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, 'window-state.json'), '{not-json', 'utf8');
    const logs = new AppLogService();
    const service = new WindowStateService(logs, dataRoot);
    const display = createDisplay(1, { x: 0, y: 0, width: 1920, height: 1040 }, { width: 1920, height: 1080 });

    await service.load();

    expect(service.resolve([display], display).bounds).toEqual({ x: 320, y: 160, width: 1280, height: 720 });
    expect(logs.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'warn', scope: 'window-state' }),
    ]));
  });
});
