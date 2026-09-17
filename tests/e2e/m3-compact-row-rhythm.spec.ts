import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';

test('M3 compact current session has centered title and metadata', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-row-rhythm-'));
  const project = path.join(directory, 'project');
  const userData = path.join(directory, 'profile');
  const dataRoot = path.join(userData, 'fateGUI');
  await mkdir(project); await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify(appSettingsSchema.parse({ defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true, terminalShell: null, skinId: 'm3-expressive', themeId: 'midnight', appearance: 'dark', compactSessions: true, compactMode: false, reduceMotion: true })));
  const app = await electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: dataRoot, PI_OFFLINE: '1' } });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
    await page.getByRole('button', { name: /Open project/u }).first().click();
    await page.getByRole('button', { name: 'Expand project', exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(1000, 800);
    const row = page.locator('.session-row--current');
    await expect(row).toContainText('First session');
    await expect(row.locator('small')).toHaveText('0 messages · 1y ago');
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'm3-expressive');
    await expect(page.locator('html')).toHaveAttribute('data-compact-mode', 'false');
    const geometry = await row.evaluate(row => {
      const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, center: r.top + r.height / 2, left: r.left, right: r.right }; };
      const text = (selector: string) => {
        const el = row.querySelector(selector)!;
        const range = document.createRange(); range.selectNodeContents(el);
        const style = getComputedStyle(el);
        const context = document.createElement('canvas').getContext('2d')!;
        context.font = style.font;
        const metrics = context.measureText(el.textContent!);
        const baseline = range.getBoundingClientRect().top + metrics.fontBoundingBoxAscent;
        return { ...rect(el), baseline, inkCenter: baseline + (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2, lineHeight: style.lineHeight, whiteSpace: style.whiteSpace };
      };
      return { row: rect(row), button: rect(row.querySelector('.session-preview-open')!), title: text('.session-preview-title'), metadata: text('small'), action: rect(row.querySelector('.session-menu-trigger')!) };
    });
    console.log('Compact row geometry:', geometry);
    expect(geometry.row.height).toBe(26);
    expect(geometry.button.height).toBe(18);
    expect(geometry.button.center).toBe(geometry.row.center);
    expect(geometry.title.lineHeight).toBe('16px');
    expect(geometry.metadata.lineHeight).toBe('14px');
    expect(geometry.title.center).toBe(geometry.row.center);
    expect(Math.abs(geometry.title.inkCenter - geometry.row.center)).toBeLessThanOrEqual(0.5);
    expect(geometry.title.baseline).toBe(geometry.metadata.baseline);
    for (const text of [geometry.title, geometry.metadata]) {
      expect(text.top).toBeGreaterThanOrEqual(geometry.button.top);
      expect(text.bottom).toBeLessThanOrEqual(geometry.button.bottom);
      expect(text.whiteSpace).toBe('nowrap');
    }
    expect(geometry.metadata.left - geometry.title.right).toBe(6);
    expect(geometry.action.center).toBe(geometry.row.center);
    await mkdir('screenshots/m3-expressive', { recursive: true });
    await page.locator('.sidebar').screenshot({ path: 'screenshots/m3-expressive/compact-session-row-rhythm.png', animations: 'disabled' });
    const actions = row.getByRole('button', { name: 'Actions for First session', exact: true });
    await row.hover();
    await actions.click();
    const rename = page.getByRole('menuitem', { name: 'Rename First session', exact: true });
    await expect(rename).toBeVisible();
    await rename.click();
    const input = page.getByRole('textbox', { name: 'Rename First session', exact: true });
    await expect(input).toHaveValue('First session');
    await input.press('Escape');
    // The deterministic Electron fixture does not persist renames. Stress the
    // real rendered title node after verifying the actual rename action.
    await row.locator('.session-preview-title').evaluate(el => { el.textContent = 'A deliberately long session title to verify compact truncation preserves metadata'; });
    await page.mouse.move(1000, 800);
    await expect(row.locator('.session-preview-title')).toContainText('A deliberately long');
    expect(await row.evaluate(el => {
      const title = el.querySelector<HTMLElement>('.session-preview-title')!;
      const small = el.querySelector<HTMLElement>('small')!;
      return { truncates: title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === 'ellipsis', metadataFits: small.getBoundingClientRect().right <= el.getBoundingClientRect().right, height: el.getBoundingClientRect().height };
    })).toEqual({ truncates: true, metadataFits: true, height: 26 });
    await page.getByRole('button', { name: 'Second session 1 message · 1y ago', exact: true }).click();
    await expect(page.locator('.session-row--current')).toContainText('Second session');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
