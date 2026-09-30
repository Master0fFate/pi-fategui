import { app } from 'electron';
import path from 'node:path';
import type { AppLogService } from '../logging/AppLogService';
import type { PiThemeService } from './PiThemeService';
import { SettingsService } from './SettingsService';
import { preparePackBackground } from './DesktopSkinImage';

export interface DesktopSettingsOptions {
  readonly dataRoot?: string;
  readonly piAgentDir?: string;
  readonly piThemes?: Pick<PiThemeService, 'discover'>;
}

/** Preserve desktop native image support and lazy legacy migration, outside the Node graph. */
export function createDesktopSettingsService(logs: AppLogService, options: DesktopSettingsOptions = {}): SettingsService {
  return new SettingsService(logs, options.dataRoot, options.piThemes, options.piAgentDir, {
    legacySettingsPath: () => path.join(app.getPath('userData'), 'settings.json'),
    prepareImage: preparePackBackground,
  });
}
