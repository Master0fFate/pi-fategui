import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function expectDreamcoreGeometry(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const element = (selector: string) => document.querySelector<HTMLElement>(selector)!;
    const bounds = (selector: string) => element(selector).getBoundingClientRect();
    const style = (selector: string, pseudo?: string) => getComputedStyle(element(selector), pseudo);
    const header = bounds('.workspace-header');
    const rail = bounds('.extension-status-rail');
    const conversation = bounds('.conversation');
    const composer = bounds('.composer');
    const activeLine = style('.inspector-primary-trigger[aria-current="page"]', '::after');
    const dividers = [...document.querySelectorAll<HTMLElement>('.app-shell > .resize-handle')];
    return {
      headerAligned: Math.abs(header.bottom - bounds('.inspector-primary-nav').bottom) < 0.5,
      railClearOfHeader: rail.top - header.bottom >= 8,
      contentBelowRail: bounds('.browser-thread-layout').top >= rail.bottom,
      sidebarBorder: style('.sidebar').borderRightWidth,
      workspaceImage: style('.workspace').backgroundImage,
      inspectorBorder: style('.inspector').borderLeftWidth,
      inspectorShadow: style('.inspector').boxShadow,
      dividerWidths: dividers.map((divider) => getComputedStyle(divider, '::after').width),
      activeLine: [activeLine.height, activeLine.borderRadius, activeLine.transform],
      composerShadow: style('.composer').boxShadow,
      composerBorders: ['Top', 'Right', 'Bottom', 'Left'].map((side) => style('.composer').getPropertyValue(`border-${side.toLowerCase()}-width`)),
      composerCentered: Math.abs(composer.left + composer.width / 2 - (conversation.left + conversation.width / 2)) < 0.5,
      composerMatchesThread: Math.abs(composer.width - conversation.width) < 0.5,
      terminalInput: style('.composer textarea').fontFamily.includes('JetBrains Mono'),
    };
  })).toEqual({
    headerAligned: true,
    railClearOfHeader: true,
    contentBelowRail: true,
    sidebarBorder: '0px',
    workspaceImage: 'none',
    inspectorBorder: '0px',
    inspectorShadow: 'none',
    dividerWidths: ['1px', '1px'],
    activeLine: ['1px', '0px', 'none'],
    composerShadow: 'none',
    composerBorders: ['1px', '0px', '1px', '0px'],
    composerCentered: true,
    composerMatchesThread: true,
    terminalInput: true,
  });
}

test('Skins previews independently, preserves live work, and restores after restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-skins-e2e-'));
  const project = path.join(directory, 'project');
  const userData = path.join(directory, 'profile');
  const dataRoot = path.join(userData, 'fateGUI');
  await mkdir(project);
  await writeFile(path.join(project, 'example.ts'), 'export const value = 1;\n');
  await exec('git', ['init', '-b', 'main'], { cwd: project });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'add', '.'], { cwd: project });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Fixture'], { cwd: project });

  const launch = () => electron.launch({
    args: [path.resolve('.test-dist/main/index.js')],
    env: {
      ...process.env,
      PI_DESKTOP_E2E_PROJECT: project,
      PI_DESKTOP_E2E_USER_DATA: userData,
      FATE_GUI_DATA_DIR: dataRoot,
      PI_OFFLINE: '1',
    },
  });

  let application: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    application = await launch();
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /Open project/u }).first().click();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: /Skins/u }).click();
    const palette = settings.getByRole('combobox', { name: 'Interface theme' });
    await palette.click();
    await page.getByRole('option', { name: /^Monochrome/u }).click();
    await expect.poll(() => page.evaluate(() => ({
      skin: document.documentElement.dataset.skin,
      theme: document.documentElement.dataset.theme,
    }))).toEqual({ skin: 'default', theme: 'monochrome' });
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await settings.getByRole('button', { name: 'Close settings' }).click();

    await page.getByLabel('Message Pi').fill('Inspect this project');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('I inspected the project. Everything is ready.')).toBeVisible();
    await page.getByLabel('Message Pi').fill('Draft retained across skin changes');

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    const skin = settings.getByRole('combobox', { name: 'Interface skin' });
    await expect(palette).toContainText('Monochrome');
    await skin.click();
    await page.getByRole('option', { name: /Angelcore/u }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.skin)).toBe('dreamcore');
    const dreamcoreComposerRadius = await page.locator('.composer').evaluate((element) => getComputedStyle(element).borderRadius);
    await expectDreamcoreGeometry(page);
    expect(dreamcoreComposerRadius).toBe('0px');
    await expect(page.locator('.workspace-terminal-toggle')).toHaveText('[term]');
    await expect(page.locator('.terminal-prompt-heading')).toContainText('message / Pi');
    await expect(page.locator('.terminal-prompt-prefix')).toHaveText('>');
    await expect(page.locator('.terminal-message-heading')).toHaveCount(2);
    await expect(page.locator('.context-wheel svg')).toHaveCount(0);
    await expect(page.locator('.terminal-context')).toBeVisible();
    const messageEdges = await page.evaluate(() => {
      const assistant = document.querySelector<HTMLElement>('.chat-message:not(.chat-message--user):not(.chat-message--system)');
      const user = document.querySelector<HTMLElement>('.chat-message--user');
      if (!assistant || !user) return null;
      const assistantStyle = getComputedStyle(assistant);
      const userStyle = getComputedStyle(user);
      return {
        assistant: [assistantStyle.borderTopStyle, assistantStyle.borderLeftWidth, assistantStyle.borderRightWidth],
        user: [userStyle.borderTopStyle, userStyle.borderLeftWidth, userStyle.borderRightWidth],
      };
    });
    expect(messageEdges).toEqual({
      assistant: ['none', '1px', '0px'],
      user: ['none', '1px', '0px'],
    });

    await palette.click();
    await page.getByRole('option', { name: /Daylight/u }).click();
    await expect.poll(() => page.evaluate(() => ({
      skin: document.documentElement.dataset.skin,
      tone: document.documentElement.dataset.themeTone,
      canvas: document.documentElement.style.getPropertyValue('--theme-canvas'),
    }))).toEqual({ skin: 'dreamcore', tone: 'light', canvas: '#f5f7fb' });
    await expectDreamcoreGeometry(page);

    await palette.click();
    await page.getByRole('option', { name: /Midnight/u }).click();
    await expect.poll(() => page.evaluate(() => ({
      skin: document.documentElement.dataset.skin,
      tone: document.documentElement.dataset.themeTone,
    }))).toEqual({ skin: 'dreamcore', tone: 'dark' });

    await palette.click();
    await page.getByRole('option', { name: /^Monochrome/u }).click();
    await expect.poll(() => page.evaluate(() => ({
      skin: document.documentElement.dataset.skin,
      theme: document.documentElement.dataset.theme,
      canvas: document.documentElement.style.getPropertyValue('--theme-canvas'),
    }))).toEqual({ skin: 'dreamcore', theme: 'monochrome', canvas: '#090a0b' });

    await settings.getByRole('tab', { name: /Compaction/u }).click();
    await settings.getByRole('checkbox', { name: /^Compact mode/u }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.compactMode)).toBe('true');
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await skin.click();
    await page.getByRole('option', { name: /^Default/u }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.skin)).toBe('default');
    expect(await page.locator('.composer').evaluate((element) => getComputedStyle(element).borderRadius)).not.toBe('0px');
    await expect(page.locator('.terminal-prompt-heading')).toHaveCount(0);
    await expect(page.locator('.workspace-terminal-toggle svg')).toHaveCount(1);

    await skin.click();
    await page.getByRole('option', { name: /Angelcore/u }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.skin)).toBe('dreamcore');

    const originalPlatform = await page.evaluate(() => document.documentElement.dataset.platform);
    await page.evaluate(() => { document.documentElement.dataset.platform = 'darwin'; });
    await expectDreamcoreGeometry(page);
    await expect.poll(() => page.evaluate(() => {
      const sidebar = getComputedStyle(document.querySelector<HTMLElement>('.sidebar')!);
      const dragRegion = getComputedStyle(document.querySelector<HTMLElement>('.window-drag-region')!);
      return { sidebarPaddingTop: sidebar.paddingTop, dragRegionLeft: dragRegion.left };
    })).toEqual({ sidebarPaddingTop: '40px', dragRegionLeft: '76px' });
    await page.evaluate((platform) => {
      if (platform) document.documentElement.dataset.platform = platform;
      else delete document.documentElement.dataset.platform;
    }, originalPlatform);
    await expectDreamcoreGeometry(page);

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(640, 680));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(640);
    const narrowSettingsLayout = await settings.evaluate((dialog) => {
      const layout = dialog.querySelector<HTMLElement>('.settings-layout')!;
      const nav = dialog.querySelector<HTMLElement>('.settings-nav')!;
      return {
        dialogOverflow: dialog.scrollWidth - dialog.clientWidth,
        layoutOverflow: layout.scrollWidth - layout.clientWidth,
        layoutColumns: getComputedStyle(layout).gridTemplateColumns.split(' ').length,
        navColumns: getComputedStyle(nav).gridTemplateColumns.split(' ').length,
      };
    });
    expect(narrowSettingsLayout).toEqual({ dialogOverflow: 0, layoutOverflow: 0, layoutColumns: 1, navColumns: 4 });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 720));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280);

    await settings.getByRole('tab', { name: /General/u }).click();
    const performanceMode = settings.getByRole('checkbox', { name: /Performance mode/u });
    await performanceMode.check();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.reduceMotion)).toBe('true');
    await expect.poll(() => page.locator('.app-shell').evaluate((element) => ({
      transitionProperty: getComputedStyle(element).transitionProperty,
      transitionDuration: getComputedStyle(element).transitionDuration,
    }))).toEqual({ transitionProperty: 'none', transitionDuration: '0s' });
    await performanceMode.uncheck();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.reduceMotion)).toBe('false');
    await settings.getByRole('tab', { name: /Skins/u }).click();

    await settings.screenshot({ path: 'test-results/dreamcore-skin-settings-compact.png', animations: 'disabled' });
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await expect(settings.getByRole('status')).toContainText('Settings saved');
    await settings.getByRole('button', { name: 'Close settings' }).click();

    await expect(page.getByText('I inspected the project. Everything is ready.')).toBeVisible();
    await expect(page.getByLabel('Message Pi')).toHaveValue('Draft retained across skin changes');
    await page.getByRole('button', { name: 'Open terminal' }).click();
    const terminal = page.getByRole('region', { name: 'Manual integrated terminal' });
    await expect(terminal.getByText('Terminal', { exact: true })).toBeVisible();
    await expect(terminal).toContainText('Separate from Pi tools');
    await terminal.getByRole('button', { name: 'Close terminal' }).click();
    await page.getByLabel('Message Pi').focus();
    await expectDreamcoreGeometry(page);
    await page.screenshot({ path: 'test-results/dreamcore-skin-workspace-compact.png', animations: 'disabled' });

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Compaction/u }).click();
    await settings.getByRole('checkbox', { name: /^Compact mode/u }).uncheck();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.compactMode)).toBe('false');
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await expect(palette).toContainText('Monochrome');
    await settings.screenshot({ path: 'test-results/dreamcore-skin-settings.png', animations: 'disabled' });
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await page.getByLabel('Message Pi').focus();
    await expectDreamcoreGeometry(page);
    for (const platform of ['darwin', 'linux', 'win32']) {
      await page.evaluate((value) => { document.documentElement.dataset.platform = value; }, platform);
      await expectDreamcoreGeometry(page);
    }
    await page.evaluate((value) => { document.documentElement.dataset.platform = value; }, originalPlatform ?? 'win32');
    const sidebarResize = page.getByRole('separator', { name: 'Resize sidebar' });
    await expect(sidebarResize).toHaveCSS('width', '6px');
    const sidebarWidth = Number(await sidebarResize.getAttribute('aria-valuenow'));
    await sidebarResize.press('ArrowRight');
    await expect(sidebarResize).toHaveAttribute('aria-valuenow', String(sidebarWidth + 12));
    await expectDreamcoreGeometry(page);
    await sidebarResize.press('ArrowLeft');
    await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
    await expect.poll(() => page.locator('.extension-status-rail').evaluate((rail) => (
      rail.getBoundingClientRect().top - document.querySelector('.workspace-header')!.getBoundingClientRect().bottom
    ))).toBeGreaterThanOrEqual(8);
    await page.getByRole('button', { name: 'Open inspector', exact: true }).click();
    await page.getByLabel('Message Pi').focus();
    await expectDreamcoreGeometry(page);
    await page.screenshot({ path: 'test-results/dreamcore-skin-workspace.png', animations: 'disabled' });
    await expect.poll(() => page.evaluate(() => window.piDesktop.getSettings())).toMatchObject({
      skinId: 'dreamcore',
      themeId: 'monochrome',
      compactMode: false,
    });

    await application.close();
    application = await launch();
    const restored = await application.firstWindow();
    await expect(restored.locator('.app-shell')).toBeVisible();
    await expect.poll(() => restored.evaluate(() => ({
      skin: document.documentElement.dataset.skin,
      theme: document.documentElement.dataset.theme,
      compact: document.documentElement.dataset.compactMode,
    }))).toEqual({ skin: 'dreamcore', theme: 'monochrome', compact: 'false' });
    await restored.getByRole('button', { name: 'Settings', exact: true }).click();
    const restoredSettings = restored.getByRole('dialog', { name: 'Settings', exact: true });
    await restoredSettings.getByRole('tab', { name: /Skins/u }).click();
    await expect(restoredSettings.getByRole('combobox', { name: 'Interface skin' })).toContainText('Angelcore');
    await expect(restoredSettings.getByRole('combobox', { name: 'Interface theme' })).toContainText('Monochrome');
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
