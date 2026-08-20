import { app } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appSettingsSchema, defaultSpeechSettings, type AppSettings, type ProjectState } from '../../shared/contracts/ipc';
import { builtInThemes, customThemeFileSchema, themeCatalogSchema, type ThemeDefinition } from '../../shared/themes';
import type { AppLogService } from '../logging/AppLogService';
import { PiThemeService } from './PiThemeService';

function migrateCompactMode(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!('compactMode' in record) && record.compactSessions === true) {
    return { ...record, compactMode: true };
  }
  return value;
}

const defaults: AppSettings = {
  appearance: 'dark',
  defaultModel: null,
  thinkingLevel: 'medium',
  agentTeamMode: 'legacy',
  confirmRiskyCommands: true,
  terminalShell: null,
  reduceMotion: false,
  performanceMode: false,
  holyShitMode: false,
  musicPlayerEnabled: false,
  sendMessageWithModifier: false,
  compactMode: false,
  compactSessions: false,
  advancedPromptImprovement: false,
  crashTelemetryEnabled: false,
  themeId: 'catppuccin-mocha',
  interfaceFont: 'noto-sans',
  codeFont: 'jetbrains-mono',
  imageGeneration: { provider: 'auto', model: null, customProvider: null },
  speech: defaultSpeechSettings,
};

export class SettingsService {
  private settings: AppSettings = defaults;
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly logs: AppLogService,
    private readonly dataRoot = process.env.FATE_GUI_DATA_DIR
      ? path.resolve(process.env.FATE_GUI_DATA_DIR)
      : path.join(os.homedir(), '.pi', 'fateGUI'),
    private readonly piThemes: Pick<PiThemeService, 'discover'> = new PiThemeService(),
  ) {}

  async load(): Promise<AppSettings> {
    if (this.loaded) return this.get();
    this.loaded = true;
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.filePath(), 'utf8'));
      this.settings = appSettingsSchema.parse(migrateCompactMode(value));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.migrateLegacy();
      } else {
        this.logs.write('warn', 'settings', `Using defaults because settings could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return this.get();
  }

  get(): AppSettings {
    return { ...this.settings };
  }

  async loadThemes(project: ProjectState | null = null): Promise<ThemeDefinition[]> {
    const piDiscovery = this.piThemes.discover({
      cwd: project?.path ?? process.cwd(),
      projectTrusted: project?.trusted === true,
    }).catch((error: unknown) => {
      this.logs.write('warn', 'themes', `Pi themes were ignored: ${error instanceof Error ? error.message : String(error)}`);
      return { themes: [], diagnostics: [] };
    });
    let custom: ThemeDefinition[] = [];
    try {
      const value: unknown = JSON.parse(await fs.readFile(path.join(this.dataRoot, 'themes.json'), 'utf8'));
      custom = customThemeFileSchema.parse(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const example = { themes: [{ ...builtInThemes[0]!, id: 'my-theme', name: 'My Theme' }] };
        await fs.mkdir(this.dataRoot, { recursive: true });
        await fs.writeFile(path.join(this.dataRoot, 'themes.example.json'), `${JSON.stringify(example, null, 2)}\n`, { flag: 'wx' }).catch(() => undefined);
      } else {
        this.logs.write('warn', 'themes', `Custom themes were ignored: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const discovered = await piDiscovery;
    for (const diagnostic of discovered.diagnostics) {
      this.logs.write(diagnostic.type === 'error' ? 'error' : 'warn', 'themes', diagnostic.message);
    }
    const merged = new Map(builtInThemes.map((theme) => [theme.id, theme]));
    for (const theme of discovered.themes) merged.set(theme.id, theme);
    for (const theme of custom) merged.set(theme.id, theme);
    return themeCatalogSchema.parse([...merged.values()]);
  }

  async set(value: AppSettings): Promise<AppSettings> {
    const snapshot = appSettingsSchema.parse(value);
    const operation = this.writeQueue.then(async () => {
      await this.persist(snapshot);
      this.settings = snapshot;
      this.logs.write('info', 'settings', 'Application settings saved.');
      return { ...snapshot };
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persist(settings = this.settings): Promise<void> {
    const target = this.filePath();
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private filePath(): string {
    return path.join(this.dataRoot, 'settings.json');
  }

  private async migrateLegacy(): Promise<void> {
    const legacyPath = path.join(app.getPath('userData'), 'settings.json');
    if (path.normalize(legacyPath) === path.normalize(this.filePath())) return;
    try {
      const value: unknown = JSON.parse(await fs.readFile(legacyPath, 'utf8'));
      this.settings = appSettingsSchema.parse(migrateCompactMode(value));
      await this.persist(this.settings);
      this.logs.write('info', 'settings', 'Application settings migrated to ~/.pi/fateGUI.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logs.write('warn', 'settings', `Using defaults because legacy settings could not be migrated: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
