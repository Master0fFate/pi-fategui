import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';

test('M3 compact expanded sidebar keeps a single-line Fate UI brand', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-compact-brand-'));
  const project = path.join(directory, 'a-long-project-name-that-must-not-compete-with-the-product-title');
  const userData = path.join(directory, 'profile');
  const dataRoot = path.join(userData, 'fateGUI');
  await mkdir(project);
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify(appSettingsSchema.parse({
    defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true, terminalShell: null,
    skinId: 'm3-expressive', themeId: 'midnight', appearance: 'dark', compactMode: true,
    skinAppearanceOverrides: { 'm3-expressive': { compactMode: true } }, reduceMotion: true,
  })));
  const app = await electron.launch({
    args: [path.resolve('.test-dist/main/index.js')],
    env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: dataRoot, PI_OFFLINE: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: /Open project/u }).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'm3-expressive');
    await expect(page.locator('html')).toHaveAttribute('data-compact-mode', 'true');
    await page.evaluate(() => document.fonts.ready);
    const sidebar = page.locator('.sidebar');
    const title = sidebar.locator('.brand-copy strong');
    for (const width of [1440, 1000]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 900), width);
      await expect(sidebar).toHaveClass(/sidebar--expanded-visible/u);
      await expect(sidebar).toBeVisible();
      await expect(title).toBeVisible();
      await expect(title).toHaveText('Fate UI');
      await expect(title).toHaveCSS('display', 'block');
      await expect(title).toHaveCSS('white-space', 'nowrap');
      await expect(title).toHaveCSS('text-overflow', 'ellipsis');
      await expect(sidebar.locator('.brand-copy')).toHaveCSS('opacity', '1');
      await expect(sidebar.locator('.brand-copy > span')).toHaveText(path.basename(project));
      await expect(sidebar.locator('.brand-copy > span')).toHaveCSS('display', 'none');
      await expect(sidebar.locator('.brand-mark')).toBeHidden();
      const geometry = await title.evaluate(el => {
        const box = el.getBoundingClientRect();
        const row = el.closest('.brand-row')!.getBoundingClientRect();
        const copy = el.closest('.brand-copy')!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const ink = range.getBoundingClientRect();
        return { height: box.height, lineHeight: parseFloat(getComputedStyle(el).lineHeight), rowHeight: row.height,
          lines: range.getClientRects().length, fits: el.scrollWidth <= el.clientWidth,
          inkFits: ink.left >= box.left && ink.right <= box.right,
          withinRow: box.left >= row.left && box.right <= row.right && box.top >= row.top && box.bottom <= row.bottom,
          copyHeight: copy.height, centerDelta: Math.abs(box.y + box.height / 2 - row.y - row.height / 2) };
      });
      expect(geometry.lines).toBe(1);
      expect(geometry.height).toBe(geometry.lineHeight);
      expect(geometry.copyHeight).toBe(geometry.height);
      expect(geometry.rowHeight).toBe(28);
      expect(geometry.fits).toBe(true);
      expect(geometry.inkFits).toBe(true);
      expect(geometry.withinRow).toBe(true);
      expect(geometry.centerDelta).toBeLessThanOrEqual(0.5);
      console.log(`Compact brand at ${width}px:`, geometry);
    }
    await mkdir('screenshots/m3-expressive', { recursive: true });
    await sidebar.screenshot({ path: 'screenshots/m3-expressive/compact-sidebar-brand.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await expect(sidebar).toHaveClass(/sidebar--collapsed/u);
    await expect(title).toBeHidden();
    await expect(sidebar.locator('.brand-copy')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    await expect(title).toBeVisible();
    await expect(sidebar.locator('.brand-copy > span')).toBeHidden();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
