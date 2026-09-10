import { dialog, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { emptyInputSchema, ipcChannels, skinRemovalResultSchema } from '../../shared/contracts/ipc';
import { skinCatalogSchema, skinExportResultSchema, skinImportResultSchema, skinPackRequestSchema } from '../../shared/skins';
import type { SettingsService } from './SettingsService';

type Register = (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown | Promise<unknown>) => void;

export function registerSkinIpc(handle: Register, settings: SettingsService, owner: (event: IpcMainInvokeEvent) => BrowserWindow): void {
  handle(ipcChannels.skinsGet, async (_event, input) => {
    emptyInputSchema.parse(input);
    return skinCatalogSchema.parse(await settings.skinPacks.list());
  });
  handle(ipcChannels.skinsImport, async (event, input) => {
    emptyInputSchema.parse(input);
    const result = await dialog.showOpenDialog(owner(event), { title: 'Import skin folder', buttonLabel: 'Import skin', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return skinImportResultSchema.parse(await settings.skinPacks.importFolder(result.filePaths[0]));
  });
  handle(ipcChannels.skinsRemove, async (_event, input) => {
    const { id } = skinPackRequestSchema.parse(input);
    return skinRemovalResultSchema.parse(await settings.removeSkinPack(id));
  });
  handle(ipcChannels.skinsExport, async (event, input) => {
    const { id } = skinPackRequestSchema.parse(input);
    const result = await dialog.showOpenDialog(owner(event), { title: 'Export skin into folder', buttonLabel: 'Export here', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return skinExportResultSchema.parse({ path: await settings.skinPacks.exportFolder(id, result.filePaths[0]) });
  });
  handle(ipcChannels.skinsOpenFolder, async (_event, input) => {
    emptyInputSchema.parse(input);
    const catalog = await settings.skinPacks.list();
    const error = await shell.openPath(catalog.storagePath);
    if (error) throw new Error('The skin folder could not be opened in the file manager.');
    return skinExportResultSchema.parse({ path: catalog.storagePath });
  });
}
