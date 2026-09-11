import { _electron as electron, expect, test } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('a folder skin imports into user data, previews, exports, survives restart, and uninstalls safely', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-pack-e2e-'));
  const project = path.join(directory, 'project');
  const profile = path.join(directory, 'profile');
  const dataRoot = path.join(directory, 'fateGUI');
  const source = path.join(directory, 'source');
  const exported = path.join(directory, 'export');
  await mkdir(project); await mkdir(exported);
  await cp(path.resolve('examples/skins/ashen-terminal'), source, { recursive: true });
  const launch = () => electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: {
    ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: profile, FATE_GUI_DATA_DIR: dataRoot, PI_OFFLINE: '1',
  } });
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    application = await launch();
    await application.evaluate(({ dialog }, locations) => {
      dialog.showOpenDialog = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string };
        return { canceled: false, filePaths: [options.title === 'Export skin into folder' ? locations.exported : locations.source] };
      }) as typeof dialog.showOpenDialog;
    }, { source, exported });
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /Open project/ }).first().click();
    await page.getByLabel('Message Pi').fill('Keep this draft during the imported skin preview');
    const originalInput = await page.getByLabel('Message Pi').elementHandle();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: /Skins/ }).click();
    await settings.getByRole('button', { name: 'Import skin folder', exact: true }).click();
    await expect(settings.getByRole('button', { name: 'Preview Ashen Terminal', exact: true })).toBeEnabled();
    const installedPath = path.join(dataRoot, 'skins', 'ashen-terminal');
    expect(JSON.parse(await readFile(path.join(installedPath, 'skin.json'), 'utf8')).id).toBe('ashen-terminal');
    await expect(settings.getByText(path.join(dataRoot, 'skins'), { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.skinId)).toBe('default');
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('midnight');
    await settings.getByRole('button', { name: 'Import skin folder', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText('already exists');
    await settings.getByRole('button', { name: 'Preview Ashen Terminal', exact: true }).click();
    await expect.poll(() => page.evaluate(() => ({
      base: document.documentElement.dataset.skin,
      id: document.documentElement.dataset.skinId,
      width: document.documentElement.style.getPropertyValue('--skin-content-width'),
      theme: document.documentElement.dataset.theme,
    }))).toEqual({ base: 'dreamcore', id: 'pack:ashen-terminal', width: '840px', theme: 'midnight' });
    await expect(page.locator('.workspace-backdrop')).toHaveAttribute('data-source', 'skin-pack');
    expect(await page.evaluate(() => localStorage.getItem('fate:skin:last-applied'))).toBe('default');
    await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.skinId)).toBe('default');
    await expect(page.locator('.workspace-backdrop')).toHaveCount(0);
    await expect(page.getByLabel('Message Pi')).toHaveValue('Keep this draft during the imported skin preview');
    expect(await originalInput!.evaluate((element) => element.isConnected)).toBe(true);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/ }).click();
    await settings.getByRole('combobox', { name: 'Interface skin' }).click();
    await page.getByRole('option', { name: /^Ashen Terminal/ }).click();
    await settings.getByRole('combobox', { name: 'Interface theme' }).click();
    await page.getByRole('option', { name: /^Ashen Terminal/ }).click();
    await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('Settings saved');
    await settings.getByRole('button', { name: 'Export Ashen Terminal', exact: true }).click();
    await expect(settings.getByText(/Exported to/)).toBeVisible();
    expect(await readFile(path.join(exported, 'ashen-terminal', 'background.png'))).toEqual(await readFile(path.join(installedPath, 'background.png')));
    await settings.screenshot({ path: 'test-results/skin-pack-settings.png', animations: 'disabled' });
    await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.screenshot({ path: 'test-results/skin-pack-workspace.png', animations: 'disabled' });
    await application.close();

    application = await launch();
    const restored = await application.firstWindow();
    await expect.poll(() => restored.evaluate(() => ({ id: document.documentElement.dataset.skinId, theme: document.documentElement.dataset.theme }))).toEqual({ id: 'pack:ashen-terminal', theme: 'pack-ashen-terminal' });
    await expect(restored.locator('.workspace-backdrop')).toHaveAttribute('data-source', 'skin-pack');
    await restored.getByRole('button', { name: 'Settings', exact: true }).click();
    const restoredSettings = restored.getByRole('dialog', { name: 'Settings', exact: true });
    await restoredSettings.getByRole('tab', { name: /Skins/ }).click();
    await expect(restoredSettings.getByRole('combobox', { name: 'Interface skin' })).toContainText('Ashen Terminal');
    await restoredSettings.getByRole('button', { name: 'Remove Ashen Terminal', exact: true }).click();
    await restoredSettings.getByRole('alertdialog').getByRole('button', { name: 'Remove skin pack', exact: true }).click();
    await expect(restoredSettings.getByRole('combobox', { name: 'Interface skin' })).toContainText('Default');
    await restoredSettings.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect.poll(() => restored.evaluate(() => document.documentElement.dataset.skinId)).toBe('default');
    await expect(restored.locator('.workspace-backdrop')).toHaveCount(0);
    await expect(readFile(path.join(installedPath, 'skin.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(path.join(dataRoot, 'settings.json'), 'utf8'))).toMatchObject({ skinId: 'default', themeId: 'midnight' });
    expect(await restored.evaluate(() => localStorage.getItem('fate:skin:pack-snapshot'))).toBeNull();
    expect(JSON.parse(await readFile(path.join(source, 'skin.json'), 'utf8')).id).toBe('ashen-terminal');
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
