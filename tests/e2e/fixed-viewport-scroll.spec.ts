import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';

test('fixed viewport preserves real dialog/select scrolling, geometry and focus', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-fixed-viewport-'));
  const project = path.join(directory, 'project');
  const userData = path.join(directory, 'profile');
  const dataRoot = path.join(userData, 'fateGUI');
  const home = path.join(directory, 'home');
  await Promise.all([mkdir(project), mkdir(home), mkdir(dataRoot, { recursive: true })]);
  await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify(appSettingsSchema.parse({
    appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true,
    terminalShell: null, reduceMotion: true, skinId: 'default', themeId: 'midnight',
  })));
  let app: ElectronApplication | undefined;
  let passed = false;
  try {
    app = await electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: {
      ...process.env, HOME: home, USERPROFILE: home,
      PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: userData,
      FATE_GUI_DATA_DIR: dataRoot, PI_CODING_AGENT_DIR: path.join(directory, 'pi'), PI_OFFLINE: '1',
    } });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 720));
    const geometry = () => page.evaluate(() => ({
      gap: innerWidth - document.documentElement.clientWidth,
      bodyWidth: document.body.getBoundingClientRect().width,
      viewportWidth: innerWidth,
      bodyScroll: document.body.scrollTop,
      overflow: getComputedStyle(document.body).overflow,
      scrollbarLock: document.body.getAttribute('data-scroll-locked'),
    }));
    const before = await geometry();
    expect(before.gap).toBe(0);
    expect(before.overflow).toBe('hidden');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    const pane = dialog.locator('.settings-scroll');
    await expect(dialog).toBeVisible();
    const select = dialog.getByRole('combobox', { name: 'Interface font', exact: true });
    await select.scrollIntoViewIfNeeded();
    expect(await pane.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await select.click();
    const list = page.getByRole('listbox');
    await expect(list).toBeVisible();
    const during = await geometry();
    expect(during).toEqual(before);
    const scrollBefore = await pane.evaluate((element) => element.scrollTop);
    const box = await pane.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 3, box!.y + 3);
    const delta = scrollBefore > 0 ? -160 : 160;
    await page.mouse.wheel(0, delta);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await pane.evaluate((element) => element.scrollTop)).toBe(scrollBefore);
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(select).toBeFocused();
    await page.mouse.move(box!.x + 3, box!.y + 3);
    await page.mouse.wheel(0, delta);
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).not.toBe(scrollBefore);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
    expect(await geometry()).toEqual(before);
    expect(errors).toEqual([]);
    await page.screenshot({ path: 'test-results/fixed-viewport-scroll.png', animations: 'disabled' });
    passed = true;
  } finally {
    await app?.close();
    if (passed) await rm(directory, { recursive: true, force: true });
    else console.error('[fixed viewport fixture retained]', directory);
  }
});
