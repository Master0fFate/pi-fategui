import { app, ipcMain } from 'electron';
import {
  appInfoSchema,
  getAppInfoInputSchema,
  ipcChannels,
  type AppInfo,
} from '../../shared/contracts/ipc';

export function registerIpc(): void {
  ipcMain.handle(ipcChannels.systemGetInfo, (_event, input: unknown): AppInfo => {
    getAppInfoInputSchema.parse(input);
    return appInfoSchema.parse({
      name: 'Pi Desktop',
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
    });
  });
}
