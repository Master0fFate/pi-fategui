import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appSettingsSchema, type AppSettings } from '../../shared/contracts/ipc';
import type { AppLogService } from '../logging/AppLogService';

const defaults: AppSettings = {
  appearance: 'dark',
  defaultModel: null,
  thinkingLevel: 'medium',
  confirmRiskyCommands: true,
  terminalShell: null,
  reduceMotion: false,
};

export class SettingsService {
  private settings: AppSettings = defaults;
  private loaded = false;

  constructor(private readonly logs: AppLogService) {}

  async load(): Promise<AppSettings> {
    if (this.loaded) return this.get();
    this.loaded = true;
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.filePath(), 'utf8'));
      this.settings = appSettingsSchema.parse(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logs.write('warn', 'settings', `Using defaults because settings could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return this.get();
  }

  get(): AppSettings {
    return { ...this.settings };
  }

  async set(value: AppSettings): Promise<AppSettings> {
    this.settings = appSettingsSchema.parse(value);
    const target = this.filePath();
    const temporary = `${target}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temporary, `${JSON.stringify(this.settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, target);
    this.logs.write('info', 'settings', 'Application settings saved.');
    return this.get();
  }

  private filePath(): string {
    return path.join(app.getPath('userData'), 'settings.json');
  }
}
