import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';

async function railMetrics(page: Page) {
  return page.evaluate(() => {
    const selectors = ['[aria-label="Queued messages"] .queued-message', '.goalmax-rail', '.goalmax-task-strip', '.goalmax-saved-instructions'];
    return selectors.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const label = element.querySelector<HTMLElement>('.queued-message-preview, .goalmax-rail-objective strong, .goalmax-task-strip-copy strong, .composer-rail-copy')!;
      const mark = element.querySelector<HTMLElement>('.composer-rail-mark .terminal-symbol, .goalmax-task-strip-mark .terminal-symbol');
      return { selector, height: element.getBoundingClientRect().height, font: getComputedStyle(label).fontSize, markFont: mark ? getComputedStyle(mark).fontSize : null, overflow: element.scrollWidth - element.clientWidth };
    });
  });
}

for (const skin of ['default', 'dreamcore'] as const) {
  test(`${skin} keeps confirmations, folder actions and composer rails coherent`, async () => {
    test.setTimeout(90_000);
    const directory = await mkdtemp(path.join(tmpdir(), 'fate-control-cohesion-'));
    const project = path.join(directory, 'project-with-a-long-folder-name');
    const data = path.join(directory, 'data');
    await mkdir(project); await mkdir(data);
    await writeFile(path.join(project, 'README.md'), '# Control cohesion fixture\n');
    await writeFile(path.join(data, 'settings.json'), JSON.stringify(appSettingsSchema.parse({
      appearance: 'dark', defaultModel: 'test/deterministic', thinkingLevel: 'medium', confirmRiskyCommands: true,
      terminalShell: null, reduceMotion: true, skinId: skin, themeId: skin === 'dreamcore' ? 'monochrome' : 'midnight',
    })));
    const app = await electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: path.join(directory, 'profile'), FATE_GUI_DATA_DIR: data, PI_OFFLINE: '1' } });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
      await page.getByRole('button', { name: /Open project/ }).first().click();
      await page.getByLabel('Message Pi').waitFor();
      await page.evaluate(() => window.piDesktop.createGoalMax({ objective: 'Keep every composer control aligned', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null }));
      await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getRuntimeState()).streaming)).toBe(false);
      await page.evaluate(() => window.piDesktop.prompt({ text: '__FATE_COMPOSER_RAILS__', behavior: 'prompt' }));
      await expect(page.getByRole('region', { name: 'Queued messages', exact: true }).locator('.queued-message')).toHaveCount(2);

      for (const compact of [false, true]) {
        if (compact) {
          await page.getByRole('button', { name: 'Settings', exact: true }).click();
          const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
          await settings.getByRole('tab', { name: /Compaction/ }).click();
          await settings.getByRole('checkbox', { name: /^Compact mode/ }).check();
          await settings.getByRole('button', { name: 'Save changes' }).click();
          await settings.getByRole('button', { name: 'Close settings' }).click();
        }
        for (const width of [1280, 900]) {
          await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, width === 900 ? 700 : 800), width);
          await expect.poll(async () => (await railMetrics(page)).map(({ height }) => height)).toEqual([compact ? 28 : 32, compact ? 28 : 32, compact ? 28 : 32, compact ? 28 : 32]);
          const metrics = await railMetrics(page);
          expect(new Set(metrics.map(({ font }) => font))).toEqual(new Set(['11px']));
          expect(metrics.every(({ overflow }) => overflow <= 1)).toBe(true);
          if (skin === 'dreamcore') {
            expect(metrics.every(({ markFont }) => markFont === '11px')).toBe(true);
            await expect(page.locator('.goalmax-task-strip')).toHaveCSS('border-radius', '0px');
          }
          await page.screenshot({ path: `test-results/controls-${skin}-${compact ? 'compact' : 'normal'}-${width}.png`, animations: 'disabled' });
        }
        await page.getByRole('button', { name: 'Expand task list' }).click();
        await expect(page.getByRole('list', { name: 'Task status' })).toContainText('The detail remains readable');
        await page.getByText('Saved goal instructions · 1').click();
        await expect(page.getByRole('region', { name: 'Saved goal instructions' })).toContainText('Keep the recovery path documented.');
        await expect(page.locator('.composer-rails')).toHaveJSProperty('scrollWidth', await page.locator('.composer-rails').evaluate((element) => element.clientWidth));
        await page.screenshot({ path: `test-results/controls-${skin}-${compact ? 'compact' : 'normal'}-expanded.png`, animations: 'disabled' });
        await page.getByRole('button', { name: 'Collapse task list' }).click();
        await page.getByText('Saved goal instructions · 1').click();
      }

      const folderTrigger = page.getByRole('button', { name: 'Actions for project-with-a-long-folder-name', exact: true });
      await folderTrigger.click();
      const menu = page.getByRole('menu', { name: 'Actions for project-with-a-long-folder-name', exact: true });
      await expect(menu).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Open this folder' })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menuitem', { name: 'Reveal in file manager' })).toBeFocused();
      if (skin === 'dreamcore') {
        await expect(menu).toHaveCSS('border-radius', '0px');
        await expect(menu).toHaveCSS('box-shadow', 'none');
        expect(await menu.evaluate((element) => getComputedStyle(element).fontFamily)).toContain('JetBrains Mono');
        await expect(folderTrigger).toHaveText('[...]');
      }
      await page.screenshot({ path: `test-results/folder-actions-${skin}.png`, animations: 'disabled' });
      await page.getByRole('menuitem', { name: 'Delete all sessions' }).click();
      const folderConfirm = page.getByRole('alertdialog', { name: 'Delete sessions from project-with-a-long-folder-name?' });
      await expect(folderConfirm).toBeVisible();
      await expect(menu).toHaveCount(0);
      await expect(folderConfirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await folderConfirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(folderTrigger).toBeFocused();

      await page.getByRole('button', { name: /^Run/ }).click();
      await page.getByRole('tab', { name: /^Subagent sessions/ }).click();
      const deleteTrigger = page.getByRole('button', { name: /^Delete team history for/ });
      const toolbar = page.locator('.agent-team-lifecycle-actions');
      const before = await toolbar.boundingBox();
      await deleteTrigger.click();
      const confirmation = page.getByRole('alertdialog', { name: /^Delete .* history\?/ });
      await expect(confirmation).toBeVisible();
      await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused();
      expect(await toolbar.boundingBox()).toEqual(before);
      expect(await toolbar.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
      await expect(toolbar.getByRole('alertdialog')).toHaveCount(0);
      const bounds = await confirmation.boundingBox();
      const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      if (skin === 'dreamcore') {
        await expect(confirmation).toHaveCSS('border-radius', '0px');
        await expect(confirmation).toHaveCSS('box-shadow', 'none');
      }
      await page.screenshot({ path: `test-results/team-delete-${skin}.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(confirmation).toHaveCount(0);
      await expect(deleteTrigger).toBeFocused();
      await deleteTrigger.click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete history' }).click();
      await expect(deleteTrigger).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Agent sessions', exact: true })).toBeFocused();
      expect(errors).toEqual([]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  });
}
