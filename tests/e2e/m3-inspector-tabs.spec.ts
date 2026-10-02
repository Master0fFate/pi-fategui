import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';

test('M3 resized Run tabs keep full labels and icons at the responsive boundary', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-m3-tabs-'));
  const project = path.join(directory, 'project');
  const userData = path.join(directory, 'profile');
  const dataRoot = path.join(userData, 'fateGUI');
  await mkdir(project);
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify(appSettingsSchema.parse({
    appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true,
    terminalShell: null, reduceMotion: false, skinId: 'm3-expressive', themeId: 'midnight',
    compactMode: true, compactSessions: false,
    skinAppearanceOverrides: { 'm3-expressive': { compactMode: true, compactSessions: false } },
  })));
  const app = await electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: {
    ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: userData,
    FATE_GUI_DATA_DIR: dataRoot, PI_OFFLINE: '1',
  } });
  let passed = false;
  try {
    const page = await app.firstWindow();
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'm3-expressive');
    await expect(page.locator('html')).toHaveAttribute('data-compact-mode', 'true');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 760));
    await page.locator('.inspector-primary-trigger').filter({ hasText: 'Run' }).click();
    const separator = page.getByRole('separator', { name: 'Resize inspector' });
    await separator.focus();
    for (let index = 0; index < 4; index += 1) await page.keyboard.press('ArrowLeft');
    await expect(separator).toHaveAttribute('aria-valuenow', '380');
    const tabs = page.getByRole('tablist', { name: 'Run views' });
    await expect(tabs.getByRole('tab')).toHaveCount(5);
    await page.evaluate(async () => {
      await document.fonts.load('500 11px "Roboto Flex Variable"', 'Monitor Goal Agents Tools Activity');
      await document.fonts.ready;
    });
    for (const width of [1600, 1100, 948]) {
      await app.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0]!.setSize(nextWidth, 760), width);
      await expect.poll(() => page.evaluate(() => {
        const inspector = document.querySelector('.inspector')!.getBoundingClientRect();
        const configured = Number(document.querySelector('[aria-label="Resize inspector"]')!.getAttribute('aria-valuenow'));
        return Math.abs(inspector.width - Math.min(configured, innerWidth * .31)) < .5;
      })).toBe(true);
      await expect.poll(() => page.evaluate(() => {
        const labels = [...document.querySelectorAll<HTMLElement>('.inspector-secondary-label')];
        return labels.length === 5 && labels.every(label => getComputedStyle(label).display !== 'none'
          && label.scrollWidth <= label.clientWidth + 1);
      })).toBe(true);
      if (width === 1100) {
        // This is the failing 341px inspector, just above the existing icon breakpoint.
        const geometry = await tabs.evaluate(list => ({
          inspectorWidth: list.closest('.inspector')!.getBoundingClientRect().width,
          iconsVisible: [...list.querySelectorAll('button > svg')].every(icon => getComputedStyle(icon).display !== 'none'),
          labels: [...list.querySelectorAll<HTMLElement>('.inspector-secondary-label')].map(label => ({
            label: label.textContent, scrollWidth: label.scrollWidth, clientWidth: label.clientWidth,
          })),
        }));
        console.log('[M3 tab boundary]', JSON.stringify(geometry));
        expect(geometry.inspectorWidth).toBeCloseTo(341, 0);
        expect(geometry.iconsVisible).toBe(true);
      }
    }
    // At the application's minimum width the inspector is only 186 CSS pixels.
    // Label hiding must reveal icons, and all five targets must still fit.
    for (const width of [835, 800, 600]) {
      await app.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0]!.setSize(nextWidth, 760), width);
      await expect.poll(() => tabs.evaluate(list => {
        const boundary = list.getBoundingClientRect();
        const inspector = list.closest('.inspector')!.getBoundingClientRect();
        const buttons = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
        return inspector.width <= 259 && buttons.length === 5 && buttons.every(button => {
          const label = button.querySelector<HTMLElement>('.inspector-secondary-label');
          const icon = button.querySelector('svg');
          if (!label || !icon || !button.getAttribute('aria-label')) return false;
          const box = button.getBoundingClientRect(), ink = icon.getBoundingClientRect();
          return getComputedStyle(label).display === 'none' && getComputedStyle(icon).display !== 'none'
            && ink.width > 0 && ink.height > 0 && box.width >= 24
            && ink.left >= box.left && ink.right <= box.right && ink.top >= box.top && ink.bottom <= box.bottom
            && box.left >= boundary.left && box.right <= boundary.right;
        });
      })).toBe(true);
    }
    passed = true;
  } finally {
    await app.close();
    if (passed) await rm(directory, { recursive: true, force: true });
    else console.error('[M3 tab failure fixture retained]', directory);
  }
});
