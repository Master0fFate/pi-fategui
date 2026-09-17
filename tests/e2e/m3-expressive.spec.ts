import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';

const exec = promisify(execFile);
import { tmpdir } from 'node:os';
import path from 'node:path';

async function geometry(page: Page, chromeRadius: string) {
  await expect.poll(() => page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const composer = bounds('.composer');
    const workspace = bounds('.workspace');
    const send = bounds('.send-button');
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      joinedShell: (() => {
        const shell = document.querySelector('.app-shell')!;
        const tracks = [...shell.querySelectorAll<HTMLElement>(':scope > .sidebar, :scope > .workspace, :scope > .inspector, :scope > .resize-handle')];
        const panel = getComputedStyle(shell).backgroundColor;
        return tracks.every((track, index) => {
          const style = getComputedStyle(track);
          const box = track.getBoundingClientRect();
          const previousRight = index === 0 ? 0 : tracks[index - 1]!.getBoundingClientRect().right;
          return style.margin === '0px' && style.borderRadius === '0px' && style.backgroundColor === panel
            && Math.abs(box.left - previousRight) < 0.5 && box.top === 0 && box.bottom === innerHeight;
        }) && Math.abs(tracks.at(-1)!.getBoundingClientRect().right - innerWidth) < 0.5;
      })(),
      circles: (() => {
        const buttons = [...document.querySelectorAll<HTMLElement>('.composer-toolbar .composer-icon-action, .composer-toolbar .composer-tools-toggle, .composer-toolbar .permission-toggle, .composer-toolbar .voice-button')].filter((button) => button.getBoundingClientRect().width > 0);
        const icons = buttons.map((button) => button.getBoundingClientRect());
        return buttons.every((button) => getComputedStyle(button).borderRadius === '50%') && icons.length >= 3 && icons.every((rect) => Math.abs(rect.width - rect.height) < 0.5 && Math.abs(rect.width - icons[0]!.width) < 0.5);
      })(),
      toolbarFits: (() => {
        const toolbar = document.querySelector<HTMLElement>('.composer-toolbar')!;
        const buttons = [...toolbar.querySelectorAll('button')].map((button) => button.getBoundingClientRect()).filter((rect) => rect.width > 0);
        const centers = buttons.map((rect) => rect.top + rect.height / 2);
        return toolbar.scrollWidth <= toolbar.clientWidth + 1 && Math.max(...centers) - Math.min(...centers) < 3;
      })(),
      composerFits: composer.left >= workspace.left && composer.right <= workspace.right,
      insetAligned: Math.abs(workspace.top + Number.parseFloat(getComputedStyle(document.querySelector('.workspace')!).borderTopWidth) + Number.parseFloat(getComputedStyle(document.querySelector('.workspace')!, '::before').top) - bounds('.browser-thread-layout').top) < 1,
      closedMusicClear: (() => {
        const toggle = document.querySelector('.music-dock[data-open="false"] .music-dock-toggle')?.getBoundingClientRect();
        return !toggle || toggle.top >= send.bottom || toggle.left >= send.right || toggle.right <= send.left;
      })(),
      headerFits: bounds('.workspace-header-identity').right <= bounds('.session-controls').left,
      tabsFit: [...document.querySelectorAll<HTMLElement>('.inspector-secondary-label')].every((label) => label.scrollWidth <= label.clientWidth + 1),
      searchFits: (() => {
        const input = document.querySelector<HTMLInputElement>('.sidebar-search input');
        if (!input) return true;
        const style = getComputedStyle(input, '::placeholder');
        const context = document.createElement('canvas').getContext('2d')!;
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return context.measureText(input.placeholder).width <= input.clientWidth;
      })(),
      sessionInset: (() => {
        const row = document.querySelector<HTMLElement>('.session-row--current');
        if (!row) return Boolean(document.querySelector('.sidebar--collapsed'));
        const title = row.querySelector<HTMLElement>('.session-open > span, .session-preview-title')!;
        return row.getBoundingClientRect().left - bounds('.sidebar').left >= 24
          && title.getBoundingClientRect().left - row.getBoundingClientRect().left >= 12
          && title.scrollWidth <= title.clientWidth + 1;
      })(),
      sendFits: send.right <= composer.right && send.bottom <= composer.bottom,
      radius: getComputedStyle(document.querySelector('.composer')!).borderRadius,
      chromeRadius: getComputedStyle(document.querySelector('.window-control')!).borderRadius,
    };
  })).toMatchObject({ overflow: false, joinedShell: true, circles: true, toolbarFits: true, composerFits: true, insetAligned: true, closedMusicClear: true, headerFits: true, tabsFit: true, searchFits: true, sessionInset: true, sendFits: true, chromeRadius });
}

async function agentIconGeometry(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const slots = [...document.querySelectorAll<HTMLElement>('.agent-tree-root-mark, .agent-tree-branch-mark, .subagent-status-mark')];
    const headings = [...document.querySelectorAll<HTMLElement>('.agent-tree-branch-toggle, .agent-tree-branch-heading--delegation')];
    return {
      centered: slots.length >= 5 && slots.every((slot) => {
        const box = slot.getBoundingClientRect();
        const icon = slot.querySelector('svg')?.getBoundingClientRect();
        return icon && Math.abs(box.width - box.height) < 0.5
          && Math.abs(box.left + box.width / 2 - icon.left - icon.width / 2) < 0.5
          && Math.abs(box.top + box.height / 2 - icon.top - icon.height / 2) < 0.5;
      }),
      balanced: headings.length >= 2 && headings.every((heading) => {
        const box = heading.getBoundingClientRect();
        const icon = heading.querySelector('.agent-tree-branch-mark svg')!.getBoundingClientRect();
        const label = heading.querySelector('.agent-tree-branch-copy')!.getBoundingClientRect();
        return Math.abs((icon.left - box.left) - (label.left - icon.right)) < 0.5;
      }),
    };
  })).toEqual({ centered: true, balanced: true });
}

async function dockGeometry(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const inspector = bounds('.inspector');
    const player = bounds('.music-player-panel');
    const toggle = bounds('.music-dock-toggle');
    const source = bounds('.music-source');
    const content = bounds('.tab-content[data-state="active"]');
    const emptyCard = document.querySelector('.subagent-empty');
    return {
      emptyCardGap: !emptyCard || Math.abs(player.top - emptyCard.getBoundingClientRect().bottom - 12) < 2,
      equalSides: Math.abs((player.left - inspector.left) - (inspector.right - player.right)) < 1,
      equalBottom: Math.abs((player.left - inspector.left) - (inspector.bottom - player.bottom)) < 1,
      noOverlap: content.bottom <= player.top - 10,
      toggleInside: toggle.top >= player.top && toggle.right <= player.right && source.right <= toggle.left,
      controlsFit: [...document.querySelectorAll('.music-controls button')].every((button) => button.getBoundingClientRect().right <= player.right - 8),
      sourceBorder: getComputedStyle(document.querySelector('.music-source')!).borderBottomWidth,
    };
  })).toEqual({ emptyCardGap: true, equalSides: true, equalBottom: true, noOverlap: true, toggleInside: true, controlsFit: true, sourceBorder: '1px' });
}

test('M3 Expressive independent preview, save, compact layout and restart', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-m3-'));
  const project = path.join(directory, 'workspace-ui');
  const secondProject = path.join(directory, 'component-library');
  const userData = path.join(directory, 'profile');
  const dataRoot = path.join(userData, 'fateGUI');
  await mkdir(secondProject);
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src/example.ts'), 'export const value = 1;\n');
  await exec('git', ['init', '-b', 'main'], { cwd: project });
  await exec('git', ['add', '.'], { cwd: project });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Fixture'], { cwd: project });
  await writeFile(path.join(project, 'src/example.ts'), 'export const value = 2;\n');
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify(appSettingsSchema.parse({ appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true, terminalShell: null, reduceMotion: false, musicPlayerEnabled: true })));
  await mkdir('screenshots/m3-expressive', { recursive: true });
  const launch = () => electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_SECOND_PROJECT: secondProject, PI_DESKTOP_E2E_SESSION_COUNT: '8', PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: dataRoot, PI_OFFLINE: '1' } });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    const page = await app.firstWindow();
    await expect(page.getByLabel('Window controls')).toHaveAttribute('data-bridge-status', 'ready');
    const chromeRadius = await page.locator('.window-control').first().evaluate((element) => getComputedStyle(element).borderRadius);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 900));
    await page.getByRole('button', { name: /Open project/u }).first().click();
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    await page.locator('.folder-open').filter({ hasText: 'workspace-ui' }).click();
    await page.getByRole('separator', { name: 'Resize sidebar' }).focus();
    for (let index = 0; index < 7; index += 1) await page.keyboard.press('ArrowRight');
    await page.getByRole('separator', { name: 'Resize inspector' }).focus();
    for (let index = 0; index < 4; index += 1) await page.keyboard.press('ArrowLeft');
    const expand = page.getByRole('button', { name: 'Expand workspace-ui', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.getByLabel('Message Pi').fill('Inspect this project');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('I inspected the project. Everything is ready.')).toBeVisible();
    await page.getByLabel('Message Pi').fill('Draft retained across appearance changes');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: /Skins/u }).click();
    const skin = settings.getByRole('combobox', { name: 'Interface skin' });
    const palette = settings.getByRole('combobox', { name: 'Interface theme' });
    const originalTheme = await palette.innerText();
    await skin.click();
    await page.getByRole('option', { name: /M3 Expressive/u }).click();
    await expect(palette).toHaveText(originalTheme);
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'm3-expressive');
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'default');
    await expect(page.getByLabel('Message Pi')).toHaveValue('Draft retained across appearance changes');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await skin.click();
    await page.getByRole('option', { name: /M3 Expressive/u }).click();
    await palette.click();
    await page.getByRole('option', { name: /M3 Expressive/u }).click();
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await page.screenshot({ path: 'screenshots/m3-expressive/settings.png' });
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await geometry(page, chromeRadius);
    await expect(page.locator('.composer')).toHaveCSS('border-radius', '36px');
    await page.locator('.inspector-primary-trigger').filter({ hasText: 'Run' }).click();
    await page.getByRole('tab', { name: /^Subagent sessions/u }).click();
    await page.getByRole('button', { name: 'Open music player' }).click();
    await page.mouse.move(700, 450);
    await dockGeometry(page);
    await page.screenshot({ path: 'screenshots/m3-expressive/workspace-1600.png', animations: 'disabled' });
    await page.evaluate(async () => {
      await window.piDesktop.prompt({ text: '__FATE_AGENT_FIXTURE__', behavior: 'prompt' });
      await window.piDesktop.prompt({ text: '__FATE_V2_AGENT_FIXTURE__', behavior: 'prompt' });
    });
    await expect(page.locator('.subagent-session-row').first()).toBeVisible();
    await agentIconGeometry(page);
    await page.screenshot({ path: 'screenshots/m3-expressive/populated-run.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Close music player' }).click();
    await page.evaluate(() => window.piDesktop.createTask({ title: 'Review the workspace layout', detail: 'An ordinary task rendered through the real workbench.' }));
    await page.getByRole('button', { name: 'Expand task list' }).click();
    await expect(page.locator('.goalmax-task-strip')).toBeVisible();
    await page.getByRole('button', { name: 'Model and reasoning settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Model settings' })).toHaveCSS('border-radius', '24px');
    await page.screenshot({ path: 'screenshots/m3-expressive/tasks-model-picker.png', animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.getByRole('tablist', { name: 'Run views' }).getByRole('tab', { name: 'Tools', exact: true }).click();
    await expect(page.locator('.tool-card').first()).toBeVisible();
    await page.screenshot({ path: 'screenshots/m3-expressive/tools.png', animations: 'disabled' });
    await page.getByRole('button', { name: /^System/u }).click();
    await page.getByRole('tablist', { name: 'System views' }).getByRole('tab', { name: 'Context', exact: true }).click();
    await expect(page.locator('.context-dashboard')).toBeVisible();
    await page.screenshot({ path: 'screenshots/m3-expressive/context.png', animations: 'disabled' });
    await page.getByRole('tablist', { name: 'System views' }).getByRole('tab', { name: 'Resources', exact: true }).click();
    await expect(page.locator('.resources-panel')).toBeVisible();
    await page.getByRole('button', { name: 'Open browser', exact: true }).click();
    const browser = page.getByRole('region', { name: 'Built-in browser', exact: true });
    await browser.getByRole('button', { name: 'New browser tab' }).click();
    await expect(browser.getByRole('tab')).toHaveCount(2);
    await page.screenshot({ path: 'screenshots/m3-expressive/resources-browser.png', animations: 'disabled' });
    await browser.getByRole('button', { name: 'Close browser', exact: true }).click();
    await page.getByRole('button', { name: 'Open inspector', exact: true }).click();
    await page.getByRole('button', { name: /^Run/u }).click();
    await page.getByRole('tab', { name: /^Subagent sessions/u }).click();
    await page.evaluate(() => window.piDesktop.clearTasks());
    await page.getByRole('button', { name: 'Open music player' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await palette.click();
    await page.getByRole('option', { name: /Daylight/u }).click();
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'm3-expressive');
    await expect(page.locator('.composer')).toHaveCSS('border-radius', '36px');
    await page.screenshot({ path: 'screenshots/m3-expressive/light-preview.png', animations: 'disabled' });
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'm3-expressive');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Compaction/u }).click();
    await settings.getByRole('checkbox', { name: /^Compact mode/u }).check();
    await expect(page.locator('html')).toHaveAttribute('data-compact-mode', 'true');
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-busy', 'false');
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1100, 760));
    await expect(page.locator('html')).toHaveAttribute('data-compact-mode', 'true');
    await geometry(page, chromeRadius);
    await expect(page.locator('.composer')).toHaveCSS('border-radius', '28px');
    await dockGeometry(page);
    await agentIconGeometry(page);
    await page.screenshot({ path: 'screenshots/m3-expressive/compact-1100.png', animations: 'disabled' });
    const beforeBackground = await page.locator('.browser-thread-layout').screenshot({ animations: 'disabled' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await settings.getByLabel('Background image file').setInputFiles({ name: 'synthetic-light-study.png', mimeType: 'image/png', buffer: await readFile('examples/skins/ashen-terminal/background.png') });
    await expect(page.locator('.workspace-backdrop')).toHaveCSS('opacity', '0.1');
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.locator('.browser-thread-layout')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('.workspace-backdrop')).toHaveCSS('z-index', '-1');
    expect(await page.locator('.workspace').evaluate((element) => getComputedStyle(element, '::before').zIndex)).toBe('-2');
    const afterBackground = await page.locator('.browser-thread-layout').screenshot({ animations: 'disabled' });
    expect(afterBackground.equals(beforeBackground)).toBe(false);
    await page.screenshot({ path: 'screenshots/m3-expressive/background-study.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await settings.getByRole('button', { name: 'Remove background', exact: true }).click();
    await expect(page.locator('.workspace-backdrop')).toHaveCount(0);
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(980, 760));
    await geometry(page, chromeRadius);
    await dockGeometry(page);
    await agentIconGeometry(page);
    await page.screenshot({ path: 'screenshots/m3-expressive/compact-980.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Close music player' }).click();
    await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(640, 680));
    await geometry(page, chromeRadius);
    await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible();
    await page.screenshot({ path: 'screenshots/m3-expressive/compact-640-collapsed.png', animations: 'disabled' });
    await app.close();
    app = await launch();
    const restarted = await app.firstWindow();
    await expect(restarted.locator('html')).toHaveAttribute('data-skin', 'm3-expressive');
    await expect(restarted.locator('html')).toHaveAttribute('data-theme', 'm3-expressive');
    await expect(restarted.locator('html')).toHaveAttribute('data-compact-mode', 'true');
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
