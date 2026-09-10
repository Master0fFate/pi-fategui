import { dialog, shell } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { builtInSkins } from '../../shared/skins';
import { ipcChannels } from '../../shared/contracts/ipc';
import { registerSkinIpc } from './registerSkinIpc';
import type { SettingsService } from './SettingsService';

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() }, shell: { openPath: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const handlers = new Map<string, (event: never, input: unknown) => unknown>();
  const catalog = { skins: [...builtInSkins], storagePath: '/user/fateGUI/skins', diagnostics: [] };
  const packs = { list: vi.fn(async () => catalog), importFolder: vi.fn(async () => ({ catalog, importedId: 'pack:test-pack' })), exportFolder: vi.fn(async () => '/export/test-pack') };
  const remove = vi.fn();
  const owner = {} as never;
  registerSkinIpc((channel, handler) => handlers.set(channel, handler), { skinPacks: packs, removeSkinPack: remove } as unknown as SettingsService, () => owner);
  return { packs, remove, owner, invoke: (channel: string, input: unknown = {}) => Promise.resolve(handlers.get(channel)!({} as never, input)) };
}
describe('skin pack IPC', () => {
  it('uses only the native picker path and treats cancellation as a no-op', async () => {
    const context = fixture();
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await context.invoke(ipcChannels.skinsImport)).toBeNull();
    expect(context.packs.importFolder).not.toHaveBeenCalled();
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/selected/folder'] });
    await context.invoke(ipcChannels.skinsImport);
    expect(context.packs.importFolder).toHaveBeenCalledWith('/selected/folder');
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(context.owner, expect.objectContaining({ properties: ['openDirectory'] }));
  });
  it('rejects renderer-supplied paths and invalid pack IDs before side effects', async () => {
    const context = fixture();
    await expect(context.invoke(ipcChannels.skinsImport, { path: '/secret' })).rejects.toThrow();
    await expect(context.invoke(ipcChannels.skinsRemove, { id: 'pack:../outside' })).rejects.toThrow();
    await expect(context.invoke(ipcChannels.skinsExport, { id: 'default' })).rejects.toThrow();
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(context.remove).not.toHaveBeenCalled();
  });
  it('opens only the configured skin storage folder and reports shell failures', async () => {
    const context = fixture();
    vi.mocked(shell.openPath).mockResolvedValueOnce('failed');
    await expect(context.invoke(ipcChannels.skinsOpenFolder)).rejects.toThrow('could not be opened');
    expect(shell.openPath).toHaveBeenCalledWith('/user/fateGUI/skins');
  });
});
