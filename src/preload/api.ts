import { ipcRenderer } from 'electron';
import {
  appInfoSchema,
  getAppInfoInputSchema,
  ipcChannels,
  type PiDesktopApi,
} from '../shared/contracts/ipc';

export const piDesktopApi: PiDesktopApi = Object.freeze({
  async getAppInfo() {
    const input = getAppInfoInputSchema.parse({});
    const result: unknown = await ipcRenderer.invoke(ipcChannels.systemGetInfo, input);
    return appInfoSchema.parse(result);
  },
});
