import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';

test('M3 compact conversation forks match cross-skin density without changing normal rows', async () => {
  test.setTimeout(180_000);
  // Angelcore is the displayed name of the built-in dreamcore skin, not a fourth skin ID.
  const measurements: Record<string, { height: number; indent: number; gap: number; topGap: number; openHeight: number }> = {};
  for (const [skin, compact] of [['default', true], ['dreamcore', true], ['m3-expressive', false], ['m3-expressive', true]] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), 'fate-compact-forks-'));
    const project = path.join(directory, 'project');
    const userData = path.join(directory, 'profile');
    const dataRoot = path.join(userData, 'fateGUI');
    await mkdir(project); await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify(appSettingsSchema.parse({ appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true, terminalShell: null, reduceMotion: true, skinId: skin, themeId: 'midnight', compactSessions: compact, compactMode: false })));
    const app = await electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: dataRoot, PI_OFFLINE: '1', PI_DESKTOP_E2E_NAMED_FORK: '1' } });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
      await page.getByRole('button', { name: /Open project/u }).first().click();
      await page.getByRole('button', { name: 'Expand project', exact: true }).click();
      await page.locator('.composer textarea').fill('__FATE_V2_AGENT_FIXTURE__');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const list = page.getByRole('list', { name: 'Conversation paths' });
      await expect(list).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
      const row = list.locator('.session-row--path');
      await expect(row).toHaveCount(1);
      measurements[`${skin}-${compact}`] = await row.evaluate((element) => {
        const list = element.parentElement!;
        const open = element.querySelector<HTMLElement>('.session-path-open')!;
        return { height: element.getBoundingClientRect().height, indent: element.getBoundingClientRect().left - list.parentElement!.getBoundingClientRect().left, gap: parseFloat(getComputedStyle(list).gap), topGap: element.getBoundingClientRect().top - list.previousElementSibling!.getBoundingClientRect().bottom, openHeight: open.getBoundingClientRect().height };
      });
      if (compact) {
        expect(await row.evaluate((element) => {
          const copy = element.querySelector<HTMLElement>('.session-path-copy')!;
          const name = element.querySelector<HTMLElement>('.session-path-name')!;
          const description = element.querySelector<HTMLElement>('.session-path-copy small')!;
          return { fits: element.scrollWidth <= element.clientWidth, singleLine: getComputedStyle(copy).flexDirection === 'row', truncates: name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === 'ellipsis', metadata: getComputedStyle(description).whiteSpace === 'nowrap' };
        })).toEqual({ fits: true, singleLine: true, truncates: true, metadata: true });
      }
      if (skin === 'm3-expressive' && compact) {
        await mkdir('screenshots/m3-expressive', { recursive: true });
        await page.locator('.sidebar').screenshot({ path: 'screenshots/m3-expressive/compact-session-branches.png', animations: 'disabled' });
        const open = row.locator('.session-path-open');
        await open.focus();
        await expect(row.getByRole('button', { name: /Actions for/u })).toBeVisible();
        await row.getByRole('button', { name: /Actions for/u }).click();
        await expect(page.getByRole('menuitem', { name: /Rename session for/u })).toBeVisible();
        await page.keyboard.press('Escape');
        await open.click();
        await expect(list).toContainText('Keep the verified implementation');
        await expect(page.locator('.composer textarea')).toHaveValue('Continue from the alternate implementation prompt');
      }
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
  }
  console.log('Fork geometry:', measurements);
  const compact = measurements['m3-expressive-true']!;
  expect(compact.height).toBeLessThan(measurements['m3-expressive-false']!.height);
  expect(compact.openHeight).toBeGreaterThanOrEqual(26);
  for (const skin of ['default', 'dreamcore']) {
    const reference = measurements[`${skin}-true`]!;
    expect(compact.height).toBeLessThanOrEqual(reference.height);
    expect(compact.indent).toBeLessThanOrEqual(reference.indent);
    expect(compact.gap).toBeLessThanOrEqual(reference.gap);
    expect(compact.topGap).toBeLessThanOrEqual(reference.topGap);
  }
});
