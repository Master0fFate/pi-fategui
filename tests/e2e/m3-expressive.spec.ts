import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';
import { builtInThemes, themeDefinitionSchema, type ThemeDefinition } from '../../src/shared/themes';
import { expectLoadedFontFace } from './fontAssertions';

const exec = promisify(execFile);
const midnight = builtInThemes.find((theme) => theme.id === 'midnight')!;
const customPalette = themeDefinitionSchema.parse({
  ...midnight, id: 'm3-compliance-copper', name: 'M3 compliance Copper',
  colors: { ...midnight.colors, canvas: '#100e0c', panel: '#241b18', raised: '#382823', accent: '#edb58f', onAccent: '#342014', text: '#f5eadd', textSoft: '#d8c9bc', muted: '#b3a292', accentSoft: '#4b342b', currentSession: '#593d31' },
});
const piPaletteFixture = { ...builtInThemes.find((theme) => theme.id === 'graphite')!, id: 'pi-e2e-theme-0123456789ab', name: 'Pi · E2E Theme' };

async function paletteCompliance(page: Page, theme: ThemeDefinition) {
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(', ')})`;
  await expect.poll(() => page.evaluate(() => {
    const root = document.documentElement;
    const style = (selector: string, pseudo?: string) => getComputedStyle(document.querySelector(selector)!, pseudo);
    const primary = '.inspector-primary-trigger[aria-current="page"]';
    return {
      skin: root.dataset.skin, theme: root.dataset.theme, tone: root.dataset.themeTone,
      panel: style('.sidebar').backgroundColor, canvas: style('.workspace', '::before').backgroundColor,
      primary: style(primary).backgroundColor, onPrimary: style(primary).color,
      send: style('.send-button').backgroundColor, onSend: style('.send-button').color,
      text: style('.composer textarea').color,
      font: root.dataset.interfaceFont, codeFont: root.dataset.codeFont, compact: root.dataset.compactMode, reduceMotion: root.dataset.reduceMotion,
      composerRadius: style('.composer').borderRadius,
    };
  })).toEqual({ skin: 'm3-expressive', theme: theme.id, tone: theme.tone, panel: rgb(theme.colors.panel), canvas: rgb(theme.colors.canvas), primary: rgb(theme.colors.accent), onPrimary: rgb(theme.colors.onAccent), send: rgb(theme.colors.accent), onSend: rgb(theme.colors.onAccent), text: rgb(theme.colors.text), font: 'roboto-flex', codeFont: 'jetbrains-mono', compact: 'false', reduceMotion: 'false', composerRadius: '36px' });
}
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

async function stableSidebarSearch(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const tab of ['Sessions', 'Automations', 'Resources', 'Sessions', 'Resources', 'Automations', 'Sessions']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    const input = page.getByRole('searchbox', { name: `Search ${tab.toLowerCase()}` });
    await expect(input).toBeVisible();
    const box = await input.boundingBox();
    boxes.push({ x: box!.x, y: box!.y, width: box!.width, height: box!.height });
    await input.fill('A deliberately long search query that stays within its slot');
    await expect(input).toHaveValue('A deliberately long search query that stays within its slot');
    const filled = await input.boundingBox();
    expect({ x: filled!.x, y: filled!.y, height: filled!.height }).toEqual({ x: box!.x, y: box!.y, height: box!.height });
    await input.fill('');
    if (boxes.length <= 3) await page.locator('.sidebar').screenshot({ path: `screenshots/m3-expressive/${name}-${tab.toLowerCase()}.png`, animations: 'disabled' });
  }
  for (const box of boxes) expect(box).toEqual(boxes[0]);
}

// Same deterministic PCM fixture as the existing complete music journey.
function silentWave() {
  const bytes = Buffer.alloc(44 + 8000 * 90 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

async function floatingMusic(page: Page, name: string) {
  await expect(page.locator('.music-dock')).toHaveAttribute('data-open', 'true');
  for (const selector of ['.music-dock', '.music-dock-stage']) {
    await expect(page.locator(selector)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator(selector)).toHaveCSS('background-image', 'none');
    await expect(page.locator(selector)).toHaveCSS('border-top-width', '0px');
    await expect(page.locator(selector)).toHaveCSS('box-shadow', 'none');
    await expect(page.locator(selector)).toHaveCSS('backdrop-filter', 'none');
    await expect(page.locator(selector)).toHaveCSS('overflow', 'visible');
  }
  await page.getByRole('button', { name: 'Show playlist' }).click();
  for (const selector of ['.music-player-panel', '.music-queue-panel']) {
    await expect(page.locator(selector)).toHaveCSS('border-radius', '24px');
    await expect(page.locator(selector)).not.toHaveCSS('box-shadow', 'none');
  }
  await expect(page.locator('.music-queue-list > li')).toHaveCount(2);
  await page.locator('.music-queue-list > li').nth(1).getByRole('button').click();
  await expect(page.locator('.music-track-copy strong')).toHaveText('Second quiet study');
  await expect(page.getByRole('button', { name: 'Pause music' })).toBeEnabled();
  await page.getByRole('button', { name: 'Pause music' }).click();
  await page.mouse.move(400, 100);
  const player = await page.locator('.music-player-panel').boundingBox();
  const queue = await page.locator('.music-queue-panel').boundingBox();
  expect(queue!.x).toBeGreaterThanOrEqual(0);
  expect(queue!.x + queue!.width).toBeLessThan(player!.x);
  await page.screenshot({ path: `screenshots/m3-expressive/${name}.png`, animations: 'disabled' });
  // Compare real rendered corner pixels against the same underlying conversation with
  // the player closed. No test-only DOM styles: only normal controls change visibility.
  const clip = { x: Math.ceil(player!.x), y: Math.ceil(player!.y), width: 32, height: 32 };
  const opened = await page.screenshot({ clip, animations: 'disabled', path: `screenshots/m3-expressive/${name}-corner.png` });
  await page.getByRole('button', { name: 'Close music player' }).click();
  await expect(page.locator('.music-player-panel')).toBeHidden();
  const closed = await page.screenshot({ clip, animations: 'disabled' });
  const difference = await page.evaluate(async ({ opened, closed }) => {
    const pixels = async (data: number[]) => {
      const image = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); image.close();
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const [a, b] = await Promise.all([pixels(opened), pixels(closed)]);
    const delta = (x: number, y: number) => Math.max(...[0, 1, 2].map((channel) => Math.abs(a[(y * 32 + x) * 4 + channel]! - b[(y * 32 + x) * 4 + channel]!)));
    return { corner: delta(1, 1), inside: delta(24, 24) };
  }, { opened: [...opened], closed: [...closed] });
  // A subtle rounded card shadow may tint the corner, but an opaque rectangular
  // backing would replace it with the panel color just like the inside sample.
  expect(difference.corner).toBeLessThanOrEqual(8);
  expect(difference.inside).toBeGreaterThan(8);
  expect(difference.corner).toBeLessThan(difference.inside * 0.6);
  await page.getByRole('button', { name: 'Open music player' }).click();
  await expect(page.locator('.music-player-panel')).toBeVisible();
}

async function dockGeometry(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const inspector = bounds('.inspector');
    const player = bounds('.music-player-panel');
    const toggle = bounds('.music-dock-toggle');
    const source = bounds('.music-source');
    const content = bounds('.tab-content[data-state="active"]');
    return {
      equalSides: Math.abs((player.left - inspector.left) - (inspector.right - player.right)) < 1,
      equalBottom: Math.abs((player.left - inspector.left) - (inspector.bottom - player.bottom)) < 1,
      floatingOverlay: content.bottom > player.bottom,
      noFooter: getComputedStyle(document.querySelector('.inspector-tabs')!).paddingBottom === '0px',
      toggleInside: toggle.top >= player.top && toggle.right <= player.right && source.right <= toggle.left,
      controlsFit: [...document.querySelectorAll('.music-controls button')].every((button) => button.getBoundingClientRect().right <= player.right - 8),
      sourceBorder: getComputedStyle(document.querySelector('.music-source')!).borderBottomWidth,
    };
  })).toEqual({ equalSides: true, equalBottom: true, floatingOverlay: true, noFooter: true, toggleInside: true, controlsFit: true, sourceBorder: '1px' });
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
  await writeFile(path.join(dataRoot, 'themes.json'), JSON.stringify({ themes: [customPalette] }));
  await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify(appSettingsSchema.parse({ appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true, terminalShell: null, reduceMotion: false, musicPlayerEnabled: true })));
  await mkdir('screenshots/m3-expressive', { recursive: true });
  const launch = () => electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_SECOND_PROJECT: secondProject, PI_DESKTOP_E2E_SESSION_COUNT: '8', PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: dataRoot, PI_OFFLINE: '1' } });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    const page = await app.firstWindow();
    const remoteFontRequests: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'font' && /^https?:/u.test(request.url())) remoteFontRequests.push(request.url());
    });
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
    await expectLoadedFontFace(page, 'Roboto Flex Variable');
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'default');
    await expect(page.getByLabel('Message Pi')).toHaveValue('Draft retained across appearance changes');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await skin.click();
    await page.getByRole('option', { name: /M3 Expressive/u }).click();
    await palette.click();
    await page.getByRole('option', { name: /M3 Expressive/u }).click();
    const interfaceFont = settings.getByRole('combobox', { name: 'Interface font' });
    await expect(interfaceFont).toContainText('Roboto Flex');
    await expectLoadedFontFace(page, 'Roboto Flex Variable');
    await expect(page.locator('.composer textarea')).toHaveCSS('font-optical-sizing', 'auto');
    await expectLoadedFontFace(page, 'JetBrains Mono Variable');
    await interfaceFont.click();
    await page.getByRole('option', { name: /^Inter/u }).click();
    await expectLoadedFontFace(page, 'Inter Variable');
    await expect(page.locator('html')).toHaveAttribute('data-interface-font', 'inter');
    await expect(page.locator('html')).toHaveAttribute('data-code-font', 'jetbrains-mono');
    await settings.getByRole('button', { name: 'Reset to skin appearance defaults' }).click();
    await expect(interfaceFont).toContainText('Roboto Flex');
    await expectLoadedFontFace(page, 'Roboto Flex Variable');
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await page.screenshot({ path: 'screenshots/m3-expressive/settings.png' });
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await stableSidebarSearch(page, 'search-normal');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await interfaceFont.click();
    await page.getByRole('option', { name: /^JetBrains Mono/u }).click();
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await stableSidebarSearch(page, 'search-mono');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await settings.getByRole('button', { name: 'Reset to skin appearance defaults' }).click();
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await geometry(page, chromeRadius);
    await expect(page.locator('.composer')).toHaveCSS('border-radius', '36px');
    await page.locator('.inspector-primary-trigger').filter({ hasText: 'Run' }).click();
    await page.getByRole('tab', { name: /^Subagent sessions/u }).click();
    const inspectorContentBeforeMusic = await page.locator('.tab-content[data-state="active"]').boundingBox();
    await page.getByRole('button', { name: 'Open music player' }).click();
    await page.mouse.move(700, 450);
    await expect.poll(() => page.locator('.tab-content[data-state="active"]').boundingBox()).toEqual(inspectorContentBeforeMusic);
    await dockGeometry(page);
    await page.locator('.music-dock input[type="file"]').setInputFiles([{ name: 'Quiet study.wav', mimeType: 'audio/wav', buffer: silentWave() }, { name: 'Second quiet study.wav', mimeType: 'audio/wav', buffer: silentWave() }]);
    await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
    await floatingMusic(page, 'music-floating');
    await page.getByRole('button', { name: 'Open inspector', exact: true }).click();
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
    await page.getByRole('button', { name: 'Open music player' }).click();
    await floatingMusic(page, 'music-browser-shifted');
    await page.getByRole('button', { name: 'Close music player' }).click();
    await page.screenshot({ path: 'screenshots/m3-expressive/resources-browser.png', animations: 'disabled' });
    await browser.getByRole('button', { name: 'Close browser', exact: true }).click();
    await page.getByRole('button', { name: 'Open inspector', exact: true }).click();
    await page.getByRole('button', { name: /^Run/u }).click();
    await page.getByRole('tab', { name: /^Subagent sessions/u }).click();
    await page.evaluate(() => window.piDesktop.clearTasks());
    await page.getByRole('button', { name: 'Open music player' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    for (const theme of [midnight, builtInThemes.find((entry) => entry.id === 'daylight')!, builtInThemes.find((entry) => entry.id === 'monochrome')!, customPalette, piPaletteFixture]) {
      await palette.click();
      await page.getByRole('option', { name: new RegExp(`^${theme.name}`, 'u') }).click();
      await paletteCompliance(page, theme);
      await geometry(page, chromeRadius);
      await expect(page.getByLabel('Message Pi')).toHaveValue('Draft retained across appearance changes');
      if (theme.id === 'daylight') await page.screenshot({ path: 'screenshots/m3-expressive/light-preview.png', animations: 'disabled' });
    }
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await paletteCompliance(page, builtInThemes.find((theme) => theme.id === 'm3-expressive')!);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await palette.click();
    await page.getByRole('option', { name: /M3 compliance Copper/u }).click();
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-busy', 'false');
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await paletteCompliance(page, customPalette);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await palette.click();
    await page.getByRole('option', { name: /Daylight/u }).click();
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await paletteCompliance(page, customPalette);
    await expect(page.getByLabel('Message Pi')).toHaveValue('Draft retained across appearance changes');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await palette.click();
    await page.getByRole('option', { name: /^M3 Expressive/u }).click();
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-busy', 'false');
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
    await stableSidebarSearch(page, 'search-compact');
    await page.screenshot({ path: 'screenshots/m3-expressive/compact-1100.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Collapse inspector', exact: true }).click();
    await floatingMusic(page, 'music-floating-compact');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await palette.click();
    await page.getByRole('option', { name: /^Daylight/u }).click();
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await floatingMusic(page, 'music-floating-light');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await palette.click();
    await page.getByRole('option', { name: /^M3 Expressive/u }).press('Enter');
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('button', { name: 'Open inspector', exact: true }).click();
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
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await interfaceFont.click();
    await page.getByRole('option', { name: /^JetBrains Mono/u }).click();
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await stableSidebarSearch(page, 'search-compact-mono');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: /Skins/u }).click();
    await interfaceFont.click();
    await page.getByRole('option', { name: /^Roboto Flex/u }).press('Enter');
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await settings.getByRole('button', { name: 'Close settings' }).click();
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
    await expect(restarted.locator('html')).toHaveAttribute('data-interface-font', 'roboto-flex');
    await expectLoadedFontFace(restarted, 'Roboto Flex Variable');
    expect(remoteFontRequests).toEqual([]);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
