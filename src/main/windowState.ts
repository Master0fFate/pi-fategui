import type { Display, Rectangle } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AppLogService } from './logging/AppLogService';

export interface WindowPlacement {
  bounds: Rectangle;
  maximized: boolean;
}

const minimumWindowSize = { width: 900, height: 620 } as const;
const hdWindowSize = { width: 1280, height: 720 } as const;
const fourKWindowSize = { width: 1920, height: 1080 } as const;

const rectangleSchema = z.object({
  x: z.number().int().finite(),
  y: z.number().int().finite(),
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
}).strict();

const persistedWindowStateSchema = z.object({
  version: z.literal(1),
  bounds: rectangleSchema,
  maximized: z.boolean(),
}).strict();

type PersistedWindowState = z.infer<typeof persistedWindowStateSchema>;

function isFourKDisplay(display: Display): boolean {
  const physicalWidth = Math.round(display.size.width * display.scaleFactor);
  const physicalHeight = Math.round(display.size.height * display.scaleFactor);
  return Math.max(physicalWidth, physicalHeight) >= 3840
    && Math.min(physicalWidth, physicalHeight) >= 2160;
}

function fitSixteenByNine(
  target: Readonly<{ width: number; height: number }>,
  workArea: Rectangle,
): Readonly<{ width: number; height: number }> {
  const availableWidth = Math.max(1, workArea.width);
  const availableHeight = Math.max(1, workArea.height);
  const scale = Math.min(1, availableWidth / target.width, availableHeight / target.height);
  let width = Math.max(1, Math.floor(target.width * scale));
  let height = Math.max(1, Math.round(width * 9 / 16));

  if (height > availableHeight) {
    height = availableHeight;
    width = Math.max(1, Math.round(height * 16 / 9));
  }
  return { width, height };
}

/** Choose a centered 16:9 first-launch size appropriate for the display's physical resolution. */
export function defaultWindowPlacement(display: Display): WindowPlacement {
  const workArea = display.workArea;
  const size = fitSixteenByNine(isFourKDisplay(display) ? fourKWindowSize : hdWindowSize, workArea);
  return {
    bounds: {
      x: workArea.x + Math.round((workArea.width - size.width) / 2),
      y: workArea.y + Math.round((workArea.height - size.height) / 2),
      width: size.width,
      height: size.height,
    },
    maximized: false,
  };
}

function intersectionArea(first: Rectangle, second: Rectangle): number {
  const width = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
  const height = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
  return width * height;
}

function matchingDisplay(bounds: Rectangle, displays: readonly Display[]): Display | null {
  let match: Display | null = null;
  let largestIntersection = 0;
  for (const display of displays) {
    const area = intersectionArea(bounds, display.workArea);
    if (area > largestIntersection) {
      largestIntersection = area;
      match = display;
    }
  }
  return match;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function fitRememberedBounds(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(Math.max(bounds.width, minimumWindowSize.width), Math.max(1, workArea.width));
  const height = Math.min(Math.max(bounds.height, minimumWindowSize.height), Math.max(1, workArea.height));
  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

/** Restore remembered geometry when its monitor still exists; otherwise recover visibly on the primary display. */
export function resolveWindowPlacement(
  remembered: WindowPlacement | null,
  displays: readonly Display[],
  primaryDisplay: Display,
): WindowPlacement {
  if (!remembered) return defaultWindowPlacement(primaryDisplay);
  const display = matchingDisplay(remembered.bounds, displays);
  if (!display) {
    return { ...defaultWindowPlacement(primaryDisplay), maximized: remembered.maximized };
  }
  return {
    bounds: fitRememberedBounds(remembered.bounds, display.workArea),
    maximized: remembered.maximized,
  };
}

function placementsEqual(first: WindowPlacement | null, second: WindowPlacement): boolean {
  return first?.maximized === second.maximized
    && first.bounds.x === second.bounds.x
    && first.bounds.y === second.bounds.y
    && first.bounds.width === second.bounds.width
    && first.bounds.height === second.bounds.height;
}

export class WindowStateService {
  private placement: WindowPlacement | null = null;
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly logs: AppLogService,
    private readonly dataRoot = process.env.FATE_GUI_DATA_DIR
      ? path.resolve(process.env.FATE_GUI_DATA_DIR)
      : path.join(os.homedir(), '.pi', 'fateGUI'),
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = persistedWindowStateSchema.parse(JSON.parse(await fs.readFile(this.filePath(), 'utf8')));
      this.placement = { bounds: { ...parsed.bounds }, maximized: parsed.maximized };
    } catch (error) {
      this.placement = null;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logs.write('warn', 'window-state', `Using default window placement because saved state could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  resolve(displays: readonly Display[], primaryDisplay: Display): WindowPlacement {
    return resolveWindowPlacement(this.placement, displays, primaryDisplay);
  }

  save(placement: WindowPlacement): void {
    const snapshot: PersistedWindowState = persistedWindowStateSchema.parse({
      version: 1,
      bounds: placement.bounds,
      maximized: placement.maximized,
    });
    const next = { bounds: { ...snapshot.bounds }, maximized: snapshot.maximized };
    if (placementsEqual(this.placement, next)) return;
    this.placement = next;

    const operation = this.writeQueue.then(() => this.persist(snapshot));
    this.writeQueue = operation.catch((error: unknown) => {
      this.logs.write('warn', 'window-state', `Window placement could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  private async persist(state: PersistedWindowState): Promise<void> {
    const target = this.filePath();
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private filePath(): string {
    return path.join(this.dataRoot, 'window-state.json');
  }
}
