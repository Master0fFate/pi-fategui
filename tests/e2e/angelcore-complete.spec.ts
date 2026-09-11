import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';

const exec = promisify(execFile);
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-angelcore-complete-'));
  const project = path.join(directory, 'project-with-a-deliberately-long-name');
  const profile = path.join(directory, 'profile');
  const dataRoot = path.join(directory, 'data');
  await mkdir(path.join(project, 'src'), { recursive: true }); await mkdir(dataRoot);
  await writeFile(path.join(project, 'src/example.ts'), 'export const value = 1;\n');
  await writeFile(path.join(project, 'page.html'), '<!doctype html><title>Unstyled test page</title><body style="background:rgb(245,232,200);font-family:Georgia,serif"><h1>Page content keeps its own design</h1></body>');
  await writeFile(path.join(project, 'page-two.html'), '<!doctype html><title>Second unstyled page</title><body>Second page</body>');
  await exec('git', ['init', '-b', 'main'], { cwd: project });
  await exec('git', ['add', '.'], { cwd: project });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Fixture'], { cwd: project });
  await writeFile(path.join(project, 'src/example.ts'), 'export const value = 2;\n');
  await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify(appSettingsSchema.parse({ appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true, terminalShell: null, reduceMotion: false, skinId: 'dreamcore', themeId: 'monochrome', interfaceFont: 'poppins', musicPlayerEnabled: true, memoryLearning: { enabled: true, global: true, project: true } })));
  const pages = new Map([['/page.html', await readFile(path.join(project, 'page.html'))], ['/page-two.html', await readFile(path.join(project, 'page-two.html'))]]);
  const server = createServer((request, response) => {
    const content = pages.get(request.url ?? '');
    if (!content) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end(content);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not start.');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const dispose = async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); };
  const launch = () => electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: profile, FATE_GUI_DATA_DIR: dataRoot, PI_OFFLINE: '1', FATE_NAV_DEBUG: '1' } });
  return { directory, project, dataRoot, launch, baseUrl, dispose };
}
async function settings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('tab', { name: /Skins/ }).click();
  return dialog;
}
async function singleToolbar(page: Page) {
  await expect(page.locator('.learning-indicator')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const identity = document.querySelector('.workspace-header-identity')!.getBoundingClientRect();
    const actions = document.querySelector('.session-controls')!.getBoundingClientRect();
    return identity.right <= actions.left;
  })).toBe(true);
  await expect.poll(() => page.locator('.composer-toolbar').evaluate((bar) => {
    const buttons = [...bar.querySelectorAll<HTMLElement>('button')].filter((button) => button.getBoundingClientRect().width > 0 && getComputedStyle(button).visibility !== 'hidden');
    const centers = buttons.map((button) => { const rect = button.getBoundingClientRect(); return rect.top + rect.height / 2; });
    return { wraps: Math.max(...centers) - Math.min(...centers) > 3, overflow: bar.scrollWidth - bar.clientWidth > 1 };
  })).toEqual({ wraps: false, overflow: false });
}
async function squareSurface(page: Page, selector: string) {
  await expect(page.locator(selector).first()).toBeVisible();
  await expect.poll(() => page.locator(selector).first().evaluate((element) => ({ radius: getComputedStyle(element).borderRadius, shadow: getComputedStyle(element).boxShadow, font: getComputedStyle(element).fontFamily.includes('JetBrains Mono') }))).toEqual({ radius: '0px', shadow: 'none', font: true });
}
function silentWave() {
  const bytes = Buffer.alloc(44 + 8000 * 90 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

test('Angelcore styles populated surfaces and never wraps the composer toolbar with Memory on', async () => {
  test.setTimeout(120_000);
  const data = await fixture();
  const app = await data.launch();
  const browserLogs: string[] = [];
  app.process().stderr?.on('data', (value) => { browserLogs.push(String(value)); if (browserLogs.length > 100) browserLogs.shift(); });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    await page.getByRole('button', { name: /Open project/ }).first().click();
    await page.evaluate(async () => {
      await window.piDesktop.prompt({ text: 'Inspect the fixture', behavior: 'prompt' });
      await window.piDesktop.prompt({ text: 'Queued message with a deliberately long explanation that should truncate in its preview', behavior: 'followUp' });
      await window.piDesktop.createTask({ title: 'Check every visible Angelcore surface', detail: 'A populated ordinary task, not an empty-state screenshot.' });
    });
    await expect(page.getByText('I inspected the project. Everything is ready.')).toBeVisible();
    await page.getByLabel('Message Pi').fill('Keep this draft while inspecting the UI');
    await page.getByRole('button', { name: 'Expand task list' }).click();
    await squareSurface(page, '.queued-message');
    await squareSurface(page, '.goalmax-task-strip');
    await page.screenshot({ path: 'test-results/angelcore-queue-tasks.png', animations: 'disabled' });
    for (const width of [1680, 1280, 980]) {
      await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]?.setSize(value, 900), width);
      await singleToolbar(page);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    await page.getByRole('button', { name: 'Open composer tools' }).click();
    const tools = page.getByRole('dialog', { name: 'Composer tools' });
    await expect(tools.getByText('Message saved session', { exact: true })).toBeVisible();
    await tools.getByText('Message saved session', { exact: true }).click();
    await expect(tools.getByRole('group', { name: 'Saved sessions' })).toContainText('Second session');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Model and reasoning settings' }).click();
    await squareSurface(page, '.model-popover');
    await page.getByRole('combobox', { name: 'Model', exact: true }).click();
    await squareSurface(page, '.model-select-content');
    await page.screenshot({ path: 'test-results/angelcore-model-picker.png', animations: 'disabled' });
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.locator('.workspace-command-palette').hover();
    await expect(page.getByRole('tooltip')).toContainText('Open command palette');
    await squareSurface(page, '[role="tooltip"]');
    await page.screenshot({ path: 'test-results/angelcore-tooltip.png', animations: 'disabled' });
    await page.mouse.move(400, 500);

    await page.getByRole('button', { name: 'Open music player' }).click();
    await page.locator('.music-dock input[type="file"]').setInputFiles([{ name: 'Quiet study.wav', mimeType: 'audio/wav', buffer: silentWave() }, { name: 'Second quiet study.wav', mimeType: 'audio/wav', buffer: silentWave() }]);
    await page.getByRole('button', { name: 'Show playlist' }).click();
    await expect(page.locator('.music-queue-list > li')).toHaveCount(2);
    await squareSurface(page, '.music-player-panel'); await squareSurface(page, '.music-queue-panel');
    await page.screenshot({ path: 'test-results/angelcore-playlist.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Close music player' }).click();

    await page.evaluate(async () => {
      await window.piDesktop.prompt({ text: '__FATE_AGENT_FIXTURE__', behavior: 'prompt' });
      await window.piDesktop.prompt({ text: '__FATE_V2_AGENT_FIXTURE__', behavior: 'prompt' });
      await window.piDesktop.createGoalMax({ objective: 'Verify the complete skin', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    });
    await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getRuntimeState()).streaming)).toBe(false);
    await page.getByRole('button', { name: /^Run/ }).click();
    await page.getByRole('tab', { name: 'Goal', exact: true }).click();
    await squareSurface(page, '.goalmax-flight-deck');
    await page.getByRole('tab', { name: /Criteria/ }).click();
    await expect(page.locator('.goalmax-criterion-row')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/angelcore-goal.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Edit goal', exact: true }).click();
    await squareSurface(page, '.goalmax-editor-dialog');
    await expect.poll(() => page.locator('.goalmax-editor-dialog').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: 'test-results/angelcore-goal-editor.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Close goal editor', exact: true }).click();
    await page.getByRole('tab', { name: /^Subagent sessions/ }).click();
    await squareSurface(page, '.subagent-sessions');
    await expect(page.locator('.subagent-session-row').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/angelcore-agents.png', animations: 'disabled' });
    await expect.poll(() => page.getByRole('button', { name: /^Reviewer Agent Team node/ }).evaluate((button) => {
      const controls = button.parentElement!.querySelector('.subagent-controls')!;
      return button.getBoundingClientRect().bottom <= controls.getBoundingClientRect().top;
    })).toBe(true);
    await page.getByRole('button', { name: /^Reviewer Agent Team node/ }).click();
    await squareSurface(page, '.subagent-chat-preview');
    await page.screenshot({ path: 'test-results/angelcore-agent-preview.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Close sub-agent chat preview', exact: true }).click();
    await page.getByRole('tablist', { name: 'Run views' }).getByRole('tab', { name: 'Tools', exact: true }).click();
    await squareSurface(page, '.tool-card');
    await page.getByRole('tablist', { name: 'Run views' }).getByRole('tab', { name: 'Activity', exact: true }).click();
    await squareSurface(page, '.activity-panel');
    await page.screenshot({ path: 'test-results/angelcore-activity.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'System', exact: true }).click();
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await squareSurface(page, '.context-dashboard');
    await page.screenshot({ path: 'test-results/angelcore-context.png', animations: 'disabled' });
    await page.getByRole('tablist', { name: 'System views' }).getByRole('tab', { name: 'Resources', exact: true }).click();
    await squareSurface(page, '.resources-panel');
    await expect(page.locator('.resource-list article').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/angelcore-resources.png', animations: 'disabled' });

    const dialog = await settings(page);
    await expect(dialog.getByRole('combobox', { name: 'Interface font' })).toContainText('JetBrains Mono');
    await dialog.getByRole('tab', { name: /Compaction/ }).click();
    await dialog.getByRole('checkbox', { name: /^Compact mode/ }).check();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await dialog.getByRole('button', { name: 'Close settings' }).click();
    for (const width of [1440, 1280, 980]) {
      await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]?.setSize(value, 900), width);
      await singleToolbar(page);
    }
    await page.screenshot({ path: 'test-results/angelcore-compact-memory.png', animations: 'disabled' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    for (const view of [
      { destination: 'Run', tab: 'Goal', selector: '.goalmax-flight-deck', shot: 'goal' },
      { destination: 'Run', tab: 'Subagent sessions', selector: '.subagent-sessions', shot: 'agents' },
      { destination: 'System', tab: 'Context', selector: '.context-dashboard', shot: 'context' },
      { destination: 'System', tab: 'Resources', selector: '.resources-panel', shot: 'resources' },
    ]) {
      await page.getByRole('button', { name: new RegExp(`^${view.destination}`) }).click();
      await page.getByRole('tablist', { name: `${view.destination} views` }).getByRole('tab', { name: new RegExp(`^${view.tab}`) }).click();
      await squareSurface(page, view.selector);
      await page.screenshot({ path: `test-results/angelcore-${view.shot}-compact.png`, animations: 'disabled' });
    }
    await page.evaluate(() => window.piDesktop.clearTasks());
    await page.getByRole('button', { name: 'Expand goal criteria' }).click();
    await squareSurface(page, '.goalmax-task-strip');
    await page.screenshot({ path: 'test-results/angelcore-goal-tasks-compact.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Open music player' }).click();
    await page.getByRole('button', { name: 'Show playlist' }).click();
    await squareSurface(page, '.music-player-panel');
    await squareSurface(page, '.music-queue-panel');
    await page.screenshot({ path: 'test-results/angelcore-playlist-compact.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Close music player' }).click();
    await page.getByRole('button', { name: /^Memory Learning/ }).click();
    await squareSurface(page, '.learning-dialog');
    await page.screenshot({ path: 'test-results/angelcore-learning.png', animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open command palette' }).click();
    await squareSurface(page, '.command-palette');
    await page.screenshot({ path: 'test-results/angelcore-commands.png', animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open browser', exact: true }).click();
    await page.getByRole('textbox', { name: 'Browser address' }).fill(`${data.baseUrl}/page.html`);
    await page.getByRole('textbox', { name: 'Browser address' }).press('Enter');
    const browser = page.getByRole('region', { name: 'Built-in browser', exact: true });
    await expect(browser.getByRole('tab', { name: 'Unstyled test page', exact: true })).toBeVisible();
    await squareSurface(page, '.browser-tab--active');
    await squareSurface(page, '.browser-address');
    await expect(browser.getByRole('button', { name: 'Reload page' })).toHaveText('[r]');
    await browser.getByRole('button', { name: 'New browser tab' }).click();
    await expect(browser.getByRole('tab')).toHaveCount(2);
    await browser.getByRole('tab', { name: 'Unstyled test page', exact: true }).click();
    await browser.getByRole('textbox', { name: 'Browser address' }).fill(`${data.baseUrl}/page-two.html`);
    await browser.getByRole('textbox', { name: 'Browser address' }).press('Enter');
    await expect(browser.getByRole('tab', { name: 'Second unstyled page', exact: true })).toBeVisible();
    await browser.getByRole('button', { name: 'Go back' }).click();
    await expect(browser.getByRole('tab', { name: 'Unstyled test page', exact: true })).toBeVisible();
    await browser.getByRole('button', { name: 'Go forward' }).click();
    await expect(browser.getByRole('tab', { name: 'Second unstyled page', exact: true })).toBeVisible();
    await browser.getByRole('button', { name: 'Go back' }).click();
    await expect(browser.getByRole('tab', { name: 'Unstyled test page', exact: true })).toBeVisible();
    await browser.getByRole('button', { name: 'Reload page' }).click();
    await expect(browser.getByRole('button', { name: 'Reload page' })).toBeEnabled();
    await expect(browser.getByRole('textbox', { name: 'Browser address' })).toHaveValue(`${data.baseUrl}/page.html`);
    await expect.poll(() => app.evaluate(async ({ webContents }) => {
      const content = webContents.getAllWebContents().find((candidate) => candidate.getTitle() === 'Unstyled test page');
      return content ? content.executeJavaScript('({background:getComputedStyle(document.body).backgroundColor,font:getComputedStyle(document.body).fontFamily})') : null;
    })).toEqual({ background: 'rgb(245, 232, 200)', font: 'Georgia, serif' });
    await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getBrowserState()).visible)).toBe(true);
    await page.screenshot({ path: 'test-results/angelcore-browser.png', animations: 'disabled' });
    await browser.getByRole('button', { name: 'Toggle device toolbar' }).click();
    await squareSurface(page, '.browser-device-toolbar');
    await page.screenshot({ path: 'test-results/angelcore-browser-device.png', animations: 'disabled' });
    const chrome = await browser.boundingBox();
    const device = await page.locator('.browser-device-toolbar').boundingBox();
    await page.screenshot({ path: 'test-results/angelcore-browser-chrome.png', clip: { x: chrome!.x, y: chrome!.y, width: chrome!.width, height: device!.y + device!.height - chrome!.y }, animations: 'disabled' });
    await browser.getByRole('button', { name: 'Close browser', exact: true }).click();
  } catch (error) {
    console.log(browserLogs.join('').slice(-12000));
    console.log(await app.firstWindow().then((page) => page.evaluate(() => window.piDesktop.getBrowserState())));
    throw error;
  } finally { await app.close(); await data.dispose(); }
});

test('v2 pack fonts, embedded image, density styles and user font overrides survive restart', async () => {
  test.setTimeout(120_000);
  const data = await fixture();
  const pack = path.join(data.directory, 'font-pack'); await mkdir(pack);
  await cp(path.resolve('node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2'), path.join(pack, 'mono.woff2'));
  const image = await readFile(path.resolve('examples/skins/ashen-terminal/background.png'));
  await writeFile(path.join(pack, 'skin.json'), JSON.stringify({ schemaVersion: 2, id: 'font-studio', name: 'Font Studio', description: 'An embedded-asset fixture', version: '2.0.0', base: 'dreamcore', fonts: [{ id: 'mono', name: 'Studio Mono', file: 'mono.woff2', monospace: true }], appearance: { interfaceFont: 'local:mono', codeFont: 'local:mono', compactMode: true, compactSessions: true }, styles: { normal: { music: { controlRadius: 4 }, tooltips: { surfaceRadius: 4 }, browser: { controlRadius: 6, fontSize: 14 } }, compact: { music: { controlRadius: 1 }, browser: { controlRadius: 2 } }, compactSessions: { sidebar: { controlRadius: 3, rowHeight: 28 } } }, background: { data: image.toString('base64'), opacity: 0.1 } }));
  let app = await data.launch();
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, pack);
    let dialog = await settings(page);
    await expect(dialog.getByRole('combobox', { name: 'Interface font' })).toContainText('JetBrains Mono');
    await dialog.getByRole('button', { name: 'Import skin folder' }).click();
    await dialog.getByRole('button', { name: 'Preview Font Studio' }).click();
    await expect(dialog.getByRole('combobox', { name: 'Interface font' })).toContainText('Studio Mono');
    await expect(dialog.getByRole('combobox', { name: 'Code and terminal font' })).toContainText('Studio Mono');
    await expect.poll(() => page.evaluate(() => [...document.fonts].some((font) => font.family.includes('FateSkin_skin_font_font_studio_mono') && font.status === 'loaded'))).toBe(true);
    await expect(page.locator('.workspace-backdrop')).toHaveAttribute('data-source', 'skin-pack');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.compactMode)).toBe('true');
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--skin-music-control-radius'))).toBe('1px');
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--skin-sidebar-control-radius'))).toBe('3px');
    await dialog.getByRole('combobox', { name: 'Interface font' }).click();
    await page.getByRole('option', { name: /^Poppins/ }).click();
    await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).fontFamily)).toContain('Poppins');
    await expect.poll(() => page.evaluate(() => [...document.fonts].some((font) => font.family.replaceAll('"', '') === 'Poppins' && font.status === 'loaded'))).toBe(true);
    await expect(dialog.getByRole('combobox', { name: 'Interface font' })).toContainText('Poppins');
    await expect.poll(() => page.locator('.composer textarea').evaluate((element) => getComputedStyle(element).fontFamily)).toContain('Poppins');
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--font-code'))).toContain('FateSkin_skin_font_font_studio_mono');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByRole('status')).toContainText('Settings saved');
    await dialog.screenshot({ path: 'test-results/skin-fonts-v2.png', animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('button', { name: 'Open music player' }).click();
    await expect(page.locator('.music-play')).toHaveCSS('border-radius', '1px');
    await expect.poll(() => page.locator('.music-play').evaluate((element) => getComputedStyle(element).fontFamily)).toContain('Poppins');
    await app.close(); app = await data.launch();
    const restored = await app.firstWindow();
    dialog = await settings(restored);
    await expect(dialog.getByRole('combobox', { name: 'Interface font' })).toContainText('Poppins');
    await expect(dialog.getByRole('combobox', { name: 'Code and terminal font' })).toContainText('Studio Mono');
    await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).fontFamily)).toContain('Poppins');
    await dialog.getByRole('button', { name: 'Reset to skin appearance defaults' }).click();
    await expect(dialog.getByRole('combobox', { name: 'Interface font' })).toContainText('Studio Mono');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await restored.getByRole('button', { name: 'Collapse sidebar' }).hover();
    await expect(restored.getByRole('tooltip')).toHaveCSS('border-radius', '4px');
    await restored.mouse.move(500, 400);
    await restored.getByRole('button', { name: /Open project/ }).first().click();
    await restored.evaluate(() => window.piDesktop.createTask({ title: 'Hover task detail', detail: 'Native title tooltip detail' }));
    await restored.locator('.goalmax-task-strip-copy strong').hover();
    await expect(restored.locator('.skin-native-tooltip')).toContainText('Native title tooltip detail');
    await expect(restored.locator('.skin-native-tooltip')).toHaveCSS('border-radius', '4px');
    await restored.screenshot({ path: 'test-results/angelcore-native-tooltip.png', animations: 'disabled' });
    await restored.mouse.move(400, 400);
    await restored.getByRole('button', { name: 'Open browser', exact: true }).click();
    await expect(restored.locator('.browser-address')).toHaveCSS('border-radius', '2px');
    await expect(restored.locator('.browser-tab--active')).toHaveCSS('border-radius', '2px');
    await expect(restored.getByRole('textbox', { name: 'Browser address' })).toHaveCSS('font-size', '14px');
  } finally { await app.close(); await data.dispose(); }
});
