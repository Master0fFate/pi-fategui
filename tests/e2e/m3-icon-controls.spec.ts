import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';

const controls = ['.sidebar-toolbar-action > button', '.session-controls .icon-button', '.composer .send-button', '.composer-toolbar button:is(.composer-icon-action, .composer-tools-toggle, .permission-toggle, .voice-button)', '.music-controls button', '.music-dock-toggle', '.browser-toolbar button', '.browser-tab-close', '.browser-new-tab'];
async function checkCenters(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const buttons = page.locator(`${selector}:visible`);
    expect(await buttons.count(), selector).toBeGreaterThan(0);
    for (const button of await buttons.all()) {
      const svg = button.locator(':scope > svg');
      await expect(svg).toHaveCount(1);
      const delta = await button.evaluate(el => {
        const box = el.getBoundingClientRect();
        const icon = el.querySelector(':scope > svg')!.getBoundingClientRect();
        return { x: Math.abs(icon.x + icon.width / 2 - box.x - box.width / 2), y: Math.abs(icon.y + icon.height / 2 - box.y - box.height / 2), label: el.getAttribute('aria-label') ?? el.className };
      });
      expect(delta.x, `${delta.label} horizontal`).toBeLessThanOrEqual(0.5);
      expect(delta.y, `${delta.label} vertical`).toBeLessThanOrEqual(0.5);
    }
  }
}

for (const compact of [false, true]) {
  test(`M3 live icon controls centered (compact=${compact})`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fate-icon-centers-'));
    const project = path.join(directory, 'project');
    const userData = path.join(directory, 'profile');
    const dataRoot = path.join(userData, 'fateGUI');
    await mkdir(project); await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify(appSettingsSchema.parse({ defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true, terminalShell: null, skinId: 'm3-expressive', themeId: 'midnight', appearance: 'dark', compactMode: compact, compactSessions: compact, skinAppearanceOverrides: { 'm3-expressive': { compactMode: compact, compactSessions: compact } }, reduceMotion: true })));
    const app = await electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: dataRoot, PI_OFFLINE: '1' } });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
      await page.getByRole('button', { name: /Open project/u }).first().click();
      await expect(page.locator('html')).toHaveAttribute('data-skin', 'm3-expressive');
      await expect(page.locator('html')).toHaveAttribute('data-compact-mode', String(compact));
      await page.evaluate(() => document.fonts.ready);
      // Both visible toolbar glyphs are required, not an optional selector sweep.
      await expect(page.locator('.sidebar-toolbar-action > button:visible')).toHaveCount(2);
      await checkCenters(page, controls.slice(0, 4));
      await page.getByRole('button', { name: 'Open music player', exact: true }).click();
      await checkCenters(page, controls.slice(4, 6));
      await page.getByRole('button', { name: 'Open browser', exact: true }).click();
      await expect(page.locator('.browser-new-tab')).toBeVisible();
      await checkCenters(page, controls.slice(6));
      await page.mouse.move(1000, 800);
      if (!compact) {
        await mkdir('screenshots/m3-expressive', { recursive: true });
        await page.screenshot({ path: 'screenshots/m3-expressive/icon-controls-centered.png', animations: 'disabled' });
      }
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
