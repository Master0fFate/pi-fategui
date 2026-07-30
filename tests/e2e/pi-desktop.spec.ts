import { _electron as electron, expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function fixtureRepository(): Promise<{ root: string; worktree: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-desktop-e2e-'));
  const worktree = `${root}-worktree`;
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'src/example.ts'), 'export const answer = 1;\n');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(root, 'assets/icon.png'), Buffer.concat([png, Buffer.from([0])]));
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  await exec('git', ['config', 'user.email', 'e2e@example.test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Pi Desktop E2E'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: root });
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/example/pi-desktop-e2e.git'], { cwd: root });
  await exec('git', ['worktree', 'add', '-b', 'e2e-worktree', worktree, 'HEAD'], { cwd: root });
  await writeFile(path.join(root, 'src/example.ts'), 'export const answer = 42;\n');
  await writeFile(path.join(root, 'assets/icon.png'), png);
  return { root, worktree };
}

test('first launch, project, prompt, tool, diff, Git graph, worktrees, and session switching', async () => {
  const fixture = await fixtureRepository();
  const project = fixture.root;
  const userData = await mkdtemp(path.join(tmpdir(), 'pi-desktop-profile-'));
  const application = await electron.launch({
    args: [path.resolve('.test-dist/main/index.js')],
    env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: path.join(userData, 'fateGUI'), PI_OFFLINE: '1' },
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: 'What would you like Pi to do?' })).toBeVisible();
    await expect(page.locator('.brand-mark')).toHaveText('ƒ');
    await expect(page.locator('.welcome-symbol')).toHaveText('ƒ');
    await expect(page.locator('.action-card')).toHaveCount(3);
    await expect(page.getByRole('button', { name: /Inspect codebase/ })).toBeEnabled();
    await expect(page.getByRole('button', { name: /Ship a change/ })).toBeEnabled();
    await page.screenshot({ path: 'test-results/pi-desktop-welcome.png' });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.platform)).toBe(process.platform);
    expect(await page.evaluate(() => ({ process: 'process' in window, require: 'require' in window, bridge: 'piDesktop' in window }))).toEqual({ process: false, require: false, bridge: true });

    // CDP clicks can bypass the OS non-client hit test. Keep every custom button physically
    // outside Electron drag rectangles so real pointer input works on frameless windows.
    const assertWindowControlsOutsideDragRegions = async () => {
      const overlaps = await page.evaluate(() => {
        const controls = [...document.querySelectorAll<HTMLElement>('.window-control')];
        const dragRegions = [...document.querySelectorAll<HTMLElement>('.window-drag-region, .workspace-header, .inspector-heading')];
        return controls.flatMap((control) => {
          const controlRect = control.getBoundingClientRect();
          return dragRegions.flatMap((region) => {
            const regionRect = region.getBoundingClientRect();
            const overlapWidth = Math.min(controlRect.right, regionRect.right) - Math.max(controlRect.left, regionRect.left);
            const overlapHeight = Math.min(controlRect.bottom, regionRect.bottom) - Math.max(controlRect.top, regionRect.top);
            return overlapWidth > 0 && overlapHeight > 0
              ? [`${control.getAttribute('aria-label') ?? control.className} overlaps ${region.className}`]
              : [];
          });
        });
      });
      expect(overlaps).toEqual([]);
    };
    await assertWindowControlsOutsideDragRegions();
    await page.getByRole('button', { name: 'Collapse inspector' }).click();
    await expect(page.locator('.app-shell')).toHaveClass(/app-shell--inspector-collapsed/);
    await assertWindowControlsOutsideDragRegions();
    await page.getByRole('button', { name: 'Open inspector' }).click();
    await expect(page.locator('.app-shell')).toHaveClass(/app-shell--inspector-open/);
    await page.waitForTimeout(180);
    await assertWindowControlsOutsideDragRegions();

    const primaryModifier: 'meta' | 'control' = process.platform === 'darwin' ? 'meta' : 'control';
    const getZoomLevel = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomLevel());
    // CDP keyboard events bypass Electron's before-input-event; use Electron's native input path here.
    const sendZoomShortcut = (keyCode: string, shifted = false) => application.evaluate(
      ({ BrowserWindow }, shortcut) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents;
        const modifiers: Array<'meta' | 'control' | 'shift'> = shortcut.shifted
          ? [shortcut.primaryModifier, 'shift']
          : [shortcut.primaryModifier];
        contents?.sendInputEvent({ type: 'keyDown', keyCode: shortcut.keyCode, modifiers });
        contents?.sendInputEvent({ type: 'keyUp', keyCode: shortcut.keyCode, modifiers });
      },
      { keyCode, shifted, primaryModifier },
    );
    const initialZoomLevel = await getZoomLevel();
    await sendZoomShortcut('+', true);
    await expect.poll(getZoomLevel).toBe((initialZoomLevel ?? 0) + 0.5);
    await sendZoomShortcut('-');
    await expect.poll(getZoomLevel).toBe(initialZoomLevel);

    if (process.platform !== 'win32') {
      // xvfb-run has no window manager, and headless macOS runners can report
      // zoomed state differently between BrowserWindow and renderer events.
      // Renderer control wiring is covered deterministically by component tests.
      await expect(page.getByRole('button', { name: /^(Maximize|Restore) window$/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Minimize window' })).toBeVisible();
    } else {
      const isMaximized = () => application.evaluate(({ BrowserWindow }) => Boolean(BrowserWindow.getAllWindows()[0]?.isMaximized()));
      const initiallyMaximized = await isMaximized();
      await page.getByRole('button', { name: initiallyMaximized ? 'Restore window' : 'Maximize window' }).click();
      await expect.poll(isMaximized).toBe(!initiallyMaximized);
      await page.getByRole('button', { name: initiallyMaximized ? 'Maximize window' : 'Restore window' }).click();
      await expect.poll(isMaximized).toBe(initiallyMaximized);
      await page.getByRole('button', { name: 'Minimize window' }).click();
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => Boolean(BrowserWindow.getAllWindows()[0]?.isMinimized()))).toBe(true);
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => Boolean(BrowserWindow.getAllWindows()[0]?.isMinimized()))).toBe(false);
      await page.bringToFront();
    }

    await page.getByRole('button', { name: /Open project/ }).first().click();
    await expect(page.getByText(path.basename(project)).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Model and reasoning settings' })).toBeVisible();
    const contextMeter = page.getByRole('meter', { name: 'Context usage: 42% of 100k tokens' });
    const assertInsideViewport = async (locator: typeof contextMeter) => {
      const box = await locator.boundingBox();
      const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    };
    await expect(contextMeter).toBeVisible();
    await expect(contextMeter).toHaveText('');
    await page.getByRole('button', { name: 'Permission level: Full access' }).click();
    await page.getByRole('button', { name: 'Read only' }).click();
    await expect(page.getByRole('button', { name: 'Permission level: Read only' })).toBeVisible();
    await page.getByRole('button', { name: 'Permission level: Read only' }).click();
    await page.getByRole('button', { name: 'Full access' }).click();
    await expect(page.getByText('Enable Full access?')).toBeVisible();
    await page.getByRole('button', { name: 'Enable full access' }).click();
    await expect(page.getByRole('button', { name: 'Permission level: Full access' })).toBeVisible();
    await page.getByRole('button', { name: 'Permission level: Full access' }).click();
    await page.getByRole('button', { name: 'Edit files' }).click();
    await expect(page.getByRole('button', { name: 'Permission level: Edit files' })).toBeVisible();
    await expect(page.getByText('Connected')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'What would you like Pi to do?' })).toHaveCount(0);
    await expect(page.locator('.action-card')).toHaveCount(0);
    await expect(page.getByLabel('Message Pi')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Permission level: Edit files' })).toHaveText('');
    const composerLayout = await page.evaluate(() => {
      const wrap = document.querySelector<HTMLElement>('.welcome--conversation .composer-wrap');
      const conversation = document.querySelector<HTMLElement>('.conversation');
      const resizeHandle = document.querySelector<HTMLElement>('.composer-resize-handle');
      if (!wrap || !conversation || !resizeHandle) return null;
      return {
        position: getComputedStyle(wrap).position,
        composerWidth: wrap.getBoundingClientRect().width,
        conversationWidth: conversation.getBoundingClientRect().width,
        resizeMarker: getComputedStyle(resizeHandle, '::after').content,
      };
    });
    expect(composerLayout).not.toBeNull();
    expect(composerLayout!.position).toBe('absolute');
    expect(composerLayout!.composerWidth).toBeGreaterThan(composerLayout!.conversationWidth);
    expect(['none', 'normal']).toContain(composerLayout!.resizeMarker);
    const sessionList = page.getByLabel('Sessions', { exact: true });
    const firstSessionRow = page.locator('.session-row').filter({ hasText: 'First session' });
    await expect(sessionList).toBeVisible();
    const [sessionListBox, sidebarFooterBox] = await Promise.all([sessionList.boundingBox(), page.locator('.sidebar-footer').boundingBox()]);
    expect(sessionListBox!.height).toBeGreaterThan(300);
    expect(sessionListBox!.y + sessionListBox!.height).toBeLessThanOrEqual(sidebarFooterBox!.y);
    await firstSessionRow.hover();
    await expect(firstSessionRow.getByRole('button', { name: 'Create new session from latest prompt in First session' })).toBeVisible();
    await expect(firstSessionRow.getByRole('button', { name: 'Clone First session' })).toBeVisible();
    await expect(firstSessionRow.getByRole('button', { name: 'Compact First session' })).toBeVisible();
    await expect(firstSessionRow.getByRole('button', { name: 'Rename First session' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Import session/i })).toHaveCount(0);
    await expect(page.locator('.session-action-bar')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/pi-desktop-final.png' });

    const composerInput = page.getByLabel('Message Pi');
    await composerInput.fill('__FATE_AGENT_FIXTURE__');
    await page.getByRole('button', { name: 'Send message' }).click();
    const subagentTool = page.getByRole('article', { name: 'subagent_start tool running' });
    await expect(subagentTool).toBeVisible();
    await expect(subagentTool.locator('.tool-meta')).toHaveText('Running');
    await expect(page.getByText(/Child session .* settled/iu)).toHaveCount(0);
    await page.getByRole('tab', { name: 'Subagent sessions, 1 active' }).click();
    const agents = page.getByRole('region', { name: 'Agent sessions' });
    const authAgent = agents.getByRole('button', { name: 'Open Auth Reviewer (@auth-reviewer-1) child session: Running' });
    await expect(authAgent).toBeVisible();
    await expect(agents.getByRole('button', { name: 'Open Test Runner (@test-runner-1) child session: Completed' })).toBeVisible();
    await expect(agents).not.toContainText('e2e-auth-reviewer');
    await expect(page.locator('.tab-agent-count')).toHaveCount(0);
    const agentRowHeight = (await authAgent.boundingBox())?.height;
    await authAgent.hover();
    await expect(agents.getByRole('button', { name: 'Stop @auth-reviewer-1' })).toBeVisible();
    expect((await authAgent.boundingBox())?.height).toBe(agentRowHeight);
    const treeDecoration = await agents.evaluate((region) => {
      const lastRow = region.querySelector<HTMLElement>('.subagent-session-row:last-child');
      const marks = [...region.querySelectorAll<HTMLElement>('.agent-tree-root-mark, .agent-tree-branch-mark, .subagent-status-mark')];
      return {
        lastConnector: lastRow ? getComputedStyle(lastRow, '::after').content : '',
        marks: marks.map((mark) => ({
          background: getComputedStyle(mark).backgroundColor,
          backgroundImage: getComputedStyle(mark).backgroundImage,
          borderWidth: getComputedStyle(mark).borderTopWidth,
        })),
      };
    });
    expect(['none', 'normal']).toContain(treeDecoration.lastConnector);
    expect(treeDecoration.marks.every((mark) => ['rgba(0, 0, 0, 0)', 'transparent'].includes(mark.background)
      && mark.backgroundImage === 'none' && mark.borderWidth === '0px')).toBe(true);
    await page.waitForTimeout(180);
    await page.screenshot({ path: 'test-results/pi-desktop-agents.png' });

    await agents.getByRole('button', { name: 'Rename @test-runner-1' }).click();
    await agents.getByRole('textbox', { name: 'Display name for @test-runner-1' }).fill('Regression Verifier');
    await agents.getByRole('button', { name: 'Save display name' }).click();
    await expect(agents.getByRole('button', { name: 'Open Regression Verifier (@test-runner-1) child session: Completed' })).toBeVisible();
    await agents.getByRole('button', { name: 'Stop @auth-reviewer-1' }).click();
    await expect(agents.getByRole('button', { name: 'Open Auth Reviewer (@auth-reviewer-1) child session: Cancelled' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'subagent_start tool stopped' })).toBeAttached();

    await composerInput.fill('@test');
    const agentMentions = page.getByRole('listbox', { name: 'Agent mentions' });
    await expect(agentMentions.getByRole('option')).toContainText('@test-runner-1');
    await agentMentions.getByRole('option').click();
    await expect(composerInput).toHaveValue('@test-runner-1 ');
    await composerInput.fill('');
    await page.getByRole('tab', { name: 'Changes' }).click();

    await composerInput.blur();
    const idleComposerBorder = await page.locator('form.composer').evaluate((element) => getComputedStyle(element).borderTopColor);
    await composerInput.focus();
    const focusedComposerBorder = await page.locator('form.composer').evaluate((element) => getComputedStyle(element).borderTopColor);
    expect(focusedComposerBorder).toBe(idleComposerBorder);
    await composerInput.fill('/');
    const slashPicker = page.getByRole('listbox', { name: 'Skills and commands' });
    await expect(slashPicker).toBeVisible();
    await expect(slashPicker.getByRole('option')).toHaveCount(3);
    await expect(slashPicker.getByRole('option', { name: /^parallax\b/i })).toBeVisible();
    await expect(slashPicker.getByRole('option', { name: /^review\b/i })).toBeVisible();
    await expect(slashPicker.getByRole('option', { name: /^vibesecurity\b/i })).toBeVisible();
    const [slashPickerBox, composerBox] = await Promise.all([slashPicker.boundingBox(), page.locator('form.composer').boundingBox()]);
    expect(slashPickerBox!.width).toBeLessThan(composerBox!.width);
    expect(Math.abs((slashPickerBox!.x + slashPickerBox!.width / 2) - (composerBox!.x + composerBox!.width / 2))).toBeLessThan(2);
    await page.waitForTimeout(180);
    await page.screenshot({ path: 'test-results/pi-desktop-slash-skills.png' });

    await composerInput.fill('Inspect this with /vibe');
    await expect(slashPicker.getByRole('option', { name: /^vibesecurity\b/i })).toBeVisible();
    await expect(slashPicker.getByRole('option', { name: /^parallax\b/i })).toHaveCount(0);
    await slashPicker.getByRole('option', { name: /^vibesecurity\b/i }).click();
    await expect(composerInput).toHaveValue('Inspect this with /skill:vibesecurity ');
    await composerInput.fill('Inspect this with /not-found');
    await expect(slashPicker).toHaveCount(0);
    await composerInput.fill('Keep this on two lines');
    await composerInput.press('Shift+Enter');
    await expect(composerInput).toHaveValue('Keep this on two lines\n');
    await composerInput.fill('/parallax status');
    await composerInput.press('Enter');
    await expect(page.locator('.chat-message--system')).toContainText('Parallax is active.');

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 700));
    const compactToolsTrigger = page.getByRole('button', { name: 'Open composer tools' });
    await expect(compactToolsTrigger).toBeVisible();
    const compactOverflow = await page.locator('form.composer').evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(compactOverflow.scroll).toBeLessThanOrEqual(compactOverflow.client);
    await compactToolsTrigger.click();
    const compactTools = page.getByRole('dialog', { name: 'Composer tools' });
    await expect(compactTools).toBeVisible();
    await expect(compactTools.getByRole('button', { name: 'Tag project file or folder' })).toBeVisible();
    await assertInsideViewport(compactTools);
    await page.waitForTimeout(180);
    await page.screenshot({ path: 'test-results/pi-desktop-compact-composer.png' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Permission level: Edit files' }).click();
    const compactPermissions = page.getByRole('dialog', { name: 'Permission level' });
    await expect(compactPermissions).toBeVisible();
    await assertInsideViewport(compactPermissions);
    await page.waitForTimeout(180);
    await page.screenshot({ path: 'test-results/pi-desktop-compact-permissions.png' });
    await page.keyboard.press('Escape');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 720));
    await expect(compactToolsTrigger).toBeVisible();

    const resizeHandle = page.getByRole('separator', { name: 'Resize message input' });
    const composerBeforeResize = await page.locator('form.composer').boundingBox();
    const resizeHandleBox = await resizeHandle.boundingBox();
    await page.mouse.move(resizeHandleBox!.x + resizeHandleBox!.width / 2, resizeHandleBox!.y + resizeHandleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeHandleBox!.x + resizeHandleBox!.width / 2, resizeHandleBox!.y - 96, { steps: 4 });
    await page.mouse.up();
    const [composerAfterResize, workspaceBox] = await Promise.all([page.locator('form.composer').boundingBox(), page.locator('.welcome').boundingBox()]);
    expect(composerAfterResize!.height).toBeGreaterThan(composerBeforeResize!.height + 70);
    expect(composerAfterResize!.height).toBeLessThanOrEqual(workspaceBox!.height / 2 + 2);
    await resizeHandle.focus();
    await page.keyboard.press('Home');

    await page.getByRole('button', { name: 'Model and reasoning settings' }).click();
    const modelSettings = page.getByRole('dialog', { name: 'Model settings' });
    await expect(modelSettings).toBeVisible();
    await assertInsideViewport(modelSettings);
    await page.getByRole('combobox', { name: 'Reasoning level' }).click();
    const reasoningOptions = page.getByRole('listbox');
    await expect(reasoningOptions).toBeVisible();
    await assertInsideViewport(reasoningOptions);
    await page.waitForTimeout(180);
    await page.screenshot({ path: 'test-results/pi-desktop-model-popover.png' });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+K');
    await expect(page.getByLabel('Search commands')).toBeVisible();
    await page.getByLabel('Search commands').fill('settings');
    await page.getByLabel('Search commands').press('Enter');
    const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(settingsDialog).toBeVisible();
    await expect(settingsDialog.getByText('Performance mode')).toBeVisible();
    const interfaceFontSelect = settingsDialog.getByRole('combobox', { name: 'Interface font' });
    await interfaceFontSelect.click();
    await page.getByRole('option', { name: /Poppins/ }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.interfaceFont)).toBe('poppins');
    const poppinsConversationFonts = await page.evaluate(() => ({
      composer: getComputedStyle(document.querySelector<HTMLTextAreaElement>('#pi-composer')!).fontFamily,
      message: getComputedStyle(document.querySelector<HTMLElement>('.chat-message--system .markdown-content')!).fontFamily,
    }));
    expect(poppinsConversationFonts.composer).toContain('Poppins');
    expect(poppinsConversationFonts.message).toContain('Poppins');
    await interfaceFontSelect.click();
    await page.getByRole('option', { name: /JetBrains Mono/ }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.interfaceFont)).toBe('jetbrains-mono');
    await settingsDialog.getByRole('tab', { name: /Agent/ }).click();
    const monoNavMetrics = await settingsDialog.locator('.settings-nav small').evaluateAll((elements) => elements.map((element) => ({
      text: element.textContent ?? '',
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    })));
    for (const metric of monoNavMetrics) {
      expect(metric.scrollWidth, `${metric.text} should fit horizontally with JetBrains Mono`).toBeLessThanOrEqual(metric.clientWidth + 1);
      expect(metric.scrollHeight, `${metric.text} should remain on one line with JetBrains Mono`).toBeLessThanOrEqual(metric.clientHeight + 1);
    }
    await settingsDialog.getByRole('tab', { name: /General/ }).click();
    await interfaceFontSelect.click();
    await page.getByRole('option', { name: /Noto Sans/ }).first().click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.interfaceFont)).toBe('noto-sans');
    await expect(settingsDialog.getByRole('combobox', { name: 'Code and terminal font' })).toHaveText(/JetBrains Mono/);
    await expect(settingsDialog.getByLabel('Extended Unicode font preview')).toContainText('Čć Đđ Šš Žž');
    const fontCoverage = await page.evaluate(async () => {
      const samples = [
        ['Noto Sans Variable', 'Čć Đđ Šš Žž Привет नमस्ते'],
        ['Noto Sans Hebrew Variable', 'שלום'],
        ['Noto Sans SC Variable', '中文'],
        ['JetBrains Mono Variable', 'const odgovor = 42;'],
      ] as const;
      const results = await Promise.all(samples.map(async ([family, sample]) => {
        await document.fonts.load(`12px "${family}"`, sample);
        return document.fonts.check(`12px "${family}"`, sample);
      }));
      return results.every(Boolean);
    });
    expect(fontCoverage).toBe(true);
    await page.waitForTimeout(250);
    await page.screenshot({ path: 'test-results/pi-desktop-settings.png' });
    const themeSelect = settingsDialog.getByRole('combobox', { name: 'Interface theme' });
    await themeSelect.click();
    await page.getByRole('option', { name: /Daylight/ }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeTone)).toBe('light');
    await page.waitForTimeout(250);
    await page.screenshot({ path: 'test-results/pi-desktop-settings-light.png' });
    await themeSelect.click();
    await page.getByRole('option', { name: /Midnight/ }).click();
    const assertSettingsGeometryStable = async (action: () => Promise<void>) => {
      const before = await settingsDialog.boundingBox();
      await action();
      const after = await settingsDialog.boundingBox();
      expect(before).toEqual(after);
    };
    const performanceMode = settingsDialog.getByRole('checkbox', { name: /Performance mode/ });
    const holyShitMode = settingsDialog.getByRole('checkbox', { name: /Holy sh\*t/ });
    await expect(settingsDialog.getByRole('checkbox', { name: /^Reduce motion/iu })).toHaveCount(0);
    const readVisualProfile = () => page.evaluate(() => ({
      appBackgroundImage: getComputedStyle(document.querySelector<HTMLElement>('.app-shell')!).backgroundImage,
      dialogBoxShadow: getComputedStyle(document.querySelector<HTMLElement>('.settings-dialog')!).boxShadow,
      overlayBackdropFilter: getComputedStyle(document.querySelector<HTMLElement>('.dialog-overlay')!).backdropFilter,
      toggleTransitionDuration: getComputedStyle(document.querySelector<HTMLElement>('.settings-toggle > span')!).transitionDuration,
    }));
    const normalVisualProfile = await readVisualProfile();
    expect(normalVisualProfile.appBackgroundImage).not.toBe('none');

    await assertSettingsGeometryStable(async () => {
      await performanceMode.click();
      await expect.poll(() => page.evaluate(() => ({
        performance: document.documentElement.dataset.performanceMode,
        reduced: document.documentElement.dataset.reduceMotion,
      }))).toEqual({ performance: 'true', reduced: 'true' });
    });
    await assertSettingsGeometryStable(async () => {
      await performanceMode.click();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.performanceMode)).toBe('false');
    });
    await assertSettingsGeometryStable(async () => {
      await holyShitMode.click();
      await expect.poll(() => page.evaluate(() => ({
        holy: document.documentElement.dataset.holyShitMode,
        performance: document.documentElement.dataset.performanceMode,
        reduced: document.documentElement.dataset.reduceMotion,
      }))).toEqual({ holy: 'true', performance: 'true', reduced: 'true' });
    });
    expect(await readVisualProfile()).toEqual({
      appBackgroundImage: 'none',
      dialogBoxShadow: 'none',
      overlayBackdropFilter: 'none',
      toggleTransitionDuration: '0s',
    });
    const holyShitEscapes = await page.evaluate(() => {
      const escapes: string[] = [];
      const hasTime = (value: string) => value.split(',').some((part) => Number.parseFloat(part) > 0);
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
        for (const pseudo of [null, '::before', '::after'] as const) {
          const style = getComputedStyle(element, pseudo);
          const escaped = style.backgroundImage !== 'none'
            || style.borderRadius !== '0px'
            || style.boxShadow !== 'none'
            || style.textShadow !== 'none'
            || style.filter !== 'none'
            || (style.backdropFilter !== 'none' && style.backdropFilter !== '')
            || style.animationName !== 'none'
            || hasTime(style.animationDuration)
            || hasTime(style.transitionDuration)
            || style.scrollBehavior === 'smooth'
            || style.willChange !== 'auto';
          if (escaped) escapes.push(`${element.tagName.toLowerCase()}.${element.className || '(no-class)'}${pseudo ?? ''}`);
          if (escapes.length >= 20) return escapes;
        }
      }
      return escapes;
    });
    expect(holyShitEscapes).toEqual([]);
    await assertSettingsGeometryStable(async () => {
      await holyShitMode.click();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.holyShitMode)).toBe('false');
    });
    expect(await readVisualProfile()).toEqual(normalVisualProfile);

    await performanceMode.click();
    await settingsDialog.getByRole('checkbox', { name: /Music player/ }).click();
    await settingsDialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(settingsDialog.getByRole('status')).toContainText('Settings saved');
    await settingsDialog.getByRole('tab', { name: /Agent/ }).click();
    await expect(settingsDialog.getByRole('combobox', { name: 'Default provider' })).toContainText('Test');
    await page.screenshot({ path: 'test-results/pi-desktop-settings-models.png' });
    await settingsDialog.getByRole('tab', { name: /System/ }).click();
    await expect(settingsDialog.getByText('Pi diagnostics')).toBeVisible();
    await settingsDialog.getByRole('tab', { name: /Workspace/ }).click();
    await expect(settingsDialog.getByRole('checkbox', { name: /Ctrl\/⌘ Enter to send/ })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings' }).click();

    await page.getByRole('button', { name: 'Open music player' }).click();
    const musicPlayer = page.locator('section.music-player-panel');
    await expect(musicPlayer).toBeVisible();
    await expect(musicPlayer.getByPlaceholder('Paste media link here')).toBeVisible();
    await expect(musicPlayer.locator('p:not(.visually-hidden)')).toHaveCount(0);
    await expect(page.locator('.music-dock-toggle > span')).toHaveCount(0);
    const playlistToggle = page.getByRole('button', { name: 'Show playlist' });
    const previousTrack = page.getByRole('button', { name: 'Previous track' });
    const nextTrack = page.getByRole('button', { name: 'Next track' });
    const mute = page.getByRole('button', { name: 'Mute music' });
    const [playlistButtonBox, previousBox, nextBox, muteBox] = await Promise.all([
      playlistToggle.boundingBox(), previousTrack.boundingBox(), nextTrack.boundingBox(), mute.boundingBox(),
    ]);
    expect(playlistButtonBox!.x).toBeLessThan(previousBox!.x);
    expect(muteBox!.x).toBeGreaterThan(nextBox!.x);
    await page.locator('.music-volume-control').hover();
    await expect.poll(() => page.getByLabel('Volume').evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    await playlistToggle.click();
    const playlist = page.getByRole('complementary', { name: 'Playlist' });
    await expect(playlist).toBeVisible();
    await expect(playlist.getByRole('button', { name: 'Clear playlist' })).toBeDisabled();
    const [playlistBox, playerBox] = await Promise.all([playlist.boundingBox(), musicPlayer.boundingBox()]);
    expect(playlistBox!.x + playlistBox!.width).toBeLessThanOrEqual(playerBox!.x);
    const audio = page.locator('.music-dock audio');
    await audio.dispatchEvent('play');
    await expect(page.locator('.music-equalizer')).toBeVisible();
    await expect(page.locator('.music-equalizer i')).toHaveCount(4);
    await page.screenshot({ path: 'test-results/pi-desktop-music-player.png' });
    await audio.dispatchEvent('pause');
    await expect(page.locator('.music-equalizer')).toHaveCount(0);
    await page.getByRole('button', { name: 'Hide playlist' }).click();
    await page.getByRole('button', { name: 'Close music player' }).click();

    await page.getByRole('button', { name: 'Open terminal' }).click();
    await expect(page.getByRole('region', { name: 'Manual integrated terminal' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Manual integrated terminal' }).getByText('Terminal', { exact: true })).toBeVisible();
    await page.getByRole('region', { name: 'Manual integrated terminal' }).getByRole('button', { name: 'Close terminal' }).click();

    await page.getByLabel('Message Pi').fill('Inspect this project');
    await page.getByRole('button', { name: 'Send message' }).click();
    const streamingArrow = page.getByRole('button', { name: 'Queue follow-up message' });
    await expect(streamingArrow).toBeVisible();
    await expect(streamingArrow).toBeEnabled();
    await expect(streamingArrow.locator('.lucide-arrow-up')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Model and reasoning settings' })).toBeEnabled();
    await expect(page.locator('.session-open').filter({ hasText: 'Second session' })).toBeEnabled();
    await page.getByLabel('Message Pi').fill('Use the smaller API');
    await page.getByLabel('Message Pi').press('Enter');
    const queuedMessages = page.getByRole('region', { name: 'Queued messages' });
    await expect(queuedMessages).toContainText('Use the smaller API');
    await queuedMessages.getByRole('button', { name: 'Steer' }).click();
    await expect(queuedMessages.getByText('Steering')).toBeVisible();
    await queuedMessages.getByRole('button', { name: /More options for queued message/u }).click();
    await page.getByRole('button', { name: 'Edit message' }).click();
    await expect(page.getByLabel('Message Pi')).toHaveValue('Use the smaller API');
    await expect(page.getByLabel('Message Pi')).toBeFocused();
    await expect(queuedMessages).toHaveCount(0);
    await page.getByLabel('Message Pi').fill('');
    await expect(page.getByText('I inspected the project. Everything is ready.')).toBeVisible();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 620));
    await page.waitForTimeout(180);
    await expect.poll(async () => {
      await page.locator('.conversation-virtuoso').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      return page.evaluate(() => {
        const composer = document.querySelector<HTMLElement>('.composer-wrap');
        const rows = [...document.querySelectorAll<HTMLElement>('.timeline-row')];
        const lastRow = rows.at(-1);
        if (!composer || !lastRow) return Number.NEGATIVE_INFINITY;
        return composer.getBoundingClientRect().top - lastRow.getBoundingClientRect().bottom;
      });
    }, { timeout: 5_000 }).toBeGreaterThanOrEqual(12);
    const timelineScrollable = await page.locator('.conversation-virtuoso').evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    );
    expect(timelineScrollable).toBe(true);
    await page.locator('.conversation-virtuoso').evaluate((element) => {
      const scroller = element as HTMLElement;
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 120);
      scroller.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(50);
    const conversationScrollLayers = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.conversation-virtuoso');
      const scrollbar = document.querySelector<HTMLElement>('.conversation-scrollbar');
      const composer = document.querySelector<HTMLElement>('.composer-wrap');
      const lastRow = [...document.querySelectorAll<HTMLElement>('.timeline-row')].at(-1);
      if (!scroller || !scrollbar || !composer || !lastRow) return null;
      return {
        nativeScrollbar: getComputedStyle(scroller).scrollbarWidth,
        scrollbarVisible: getComputedStyle(scrollbar).visibility,
        scrollbarBottom: scrollbar.getBoundingClientRect().bottom,
        composerTop: composer.getBoundingClientRect().top,
        lastRowBottom: lastRow.getBoundingClientRect().bottom,
      };
    });
    expect(conversationScrollLayers).not.toBeNull();
    expect(conversationScrollLayers!.nativeScrollbar).toBe('none');
    expect(conversationScrollLayers!.scrollbarVisible).toBe('visible');
    expect(conversationScrollLayers!.scrollbarBottom).toBeLessThanOrEqual(conversationScrollLayers!.composerTop - 12);
    expect(conversationScrollLayers!.lastRowBottom).toBeGreaterThan(conversationScrollLayers!.composerTop);
    await expect(page.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    await page.getByRole('button', { name: 'Expand image: Project preview' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('img', { name: 'Project preview' })).toBeVisible();
    await page.getByRole('button', { name: 'Close image viewer' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('article', { name: 'read tool succeeded' })).toBeVisible();
    await page.getByRole('article', { name: 'read tool succeeded' }).getByRole('button').click();
    await expect(page.getByText('export const answer = 42;')).toBeVisible();
    const chatFontRouting = await page.evaluate(() => {
      const interfaceFont = getComputedStyle(document.documentElement).getPropertyValue('--font-interface').trim();
      return {
        interfaceFont,
        assistant: getComputedStyle(document.querySelector<HTMLElement>('.chat-message--assistant .markdown-content')!).fontFamily,
        toolSummary: getComputedStyle(document.querySelector<HTMLElement>('.tool-heading small')!).fontFamily,
        toolDetails: getComputedStyle(document.querySelector<HTMLElement>('.tool-details pre')!).fontFamily,
      };
    });
    const interfacePrimaryFont = chatFontRouting.interfaceFont.split(',')[0];
    expect(chatFontRouting.assistant.split(',')[0]).toBe(interfacePrimaryFont);
    expect(chatFontRouting.toolSummary.split(',')[0]).toBe(interfacePrimaryFont);
    expect(chatFontRouting.toolDetails.split(',')[0]).toBe(interfacePrimaryFont);

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 720));
    await page.waitForTimeout(180);
    await page.getByRole('tab', { name: /Context/ }).click();
    const objectiveRow = page.locator('.context-list > div').filter({ hasText: 'Objective' });
    const [objectiveLabelBox, objectiveTextBox] = await Promise.all([objectiveRow.locator('span').boundingBox(), objectiveRow.locator('strong').boundingBox()]);
    expect(objectiveTextBox!.x).toBeGreaterThan(objectiveLabelBox!.x + objectiveLabelBox!.width + 10);
    expect(objectiveTextBox!.height).toBeGreaterThan(objectiveLabelBox!.height * 2);
    await page.screenshot({ path: 'test-results/pi-desktop-context-wrap.png' });

    await page.getByRole('tab', { name: /Changes/ }).click();
    await expect(page.getByRole('button', { name: 'Refresh Git status' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Switch to branch history' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Fetch all remotes|Pull current branch|Push current branch/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '2 changed files. Open combined diff' })).toHaveText('2');
    await expect(page.getByRole('button', { name: '1 lines added. Open combined diff' })).toHaveText('+1');
    await expect(page.getByRole('button', { name: '1 lines removed. Open combined diff' })).toHaveText('−1');
    const changedFile = page.locator('button.change-row').filter({ hasText: 'src/example.ts' });
    await expect(changedFile).toBeVisible();
    await expect(changedFile.locator('.change-counts')).toHaveCount(0);
    await changedFile.locator('.change-path').hover();
    await expect(page.getByRole('tooltip').filter({ hasText: 'src/example.ts' })).toBeVisible();
    await page.getByRole('button', { name: '2 changed files. Open combined diff' }).click();
    await expect(page.getByText('Working tree diff', { exact: true })).toBeVisible();
    await changedFile.click();
    await expect(page.locator('.preview-heading').getByText('src/example.ts', { exact: true })).toBeVisible();
    const changedImage = page.locator('button.change-row').filter({ hasText: 'assets/icon.png' });
    await changedImage.click();
    await expect(page.getByRole('img', { name: 'Preview of assets/icon.png' })).toBeVisible();
    await page.screenshot({ path: 'test-results/pi-desktop-image-diff.png' });

    await page.getByRole('button', { name: 'Switch to branch history' }).click();
    const fixtureCommit = page.locator('.commit-row-main').filter({ hasText: 'fixture' });
    await expect(fixtureCommit).toBeVisible();
    await fixtureCommit.hover();
    const commitCard = page.getByLabel('Commit details for fixture');
    await expect(commitCard).toBeVisible();
    await expect(commitCard).toContainText('Pi Desktop E2E');
    await expect(commitCard).toContainText('2 files changed');
    await expect(commitCard.getByRole('button', { name: 'Open on GitHub' })).toBeVisible();
    await fixtureCommit.click();
    await expect(page.getByLabel('Files changed in fixture')).toContainText('src/example.ts');
    await page.screenshot({ path: 'test-results/pi-desktop-git-graph.png' });
    await page.getByRole('button', { name: 'Switch to working-tree diff' }).click();

    const worktreeSelector = page.getByRole('button', { name: 'Change worktree. Current branch: main' });
    await worktreeSelector.click();
    await page.locator('.worktree-popover button').filter({ hasText: 'e2e-worktree' }).click();
    await expect(page.getByText(path.basename(fixture.worktree)).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change worktree. Current branch: e2e-worktree' })).toBeVisible();
    await page.getByRole('button', { name: 'Change worktree. Current branch: e2e-worktree' }).click();
    await page.locator('.worktree-popover button').filter({ hasText: 'main' }).click();
    await expect(page.getByText(path.basename(project)).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change worktree. Current branch: main' })).toBeVisible();

    await page.getByRole('button', { name: 'Permission level: Edit files' }).click();
    await page.getByRole('button', { name: 'Full access' }).click();
    await page.getByRole('button', { name: 'Enable full access' }).click();
    await expect(page.getByRole('button', { name: 'Permission level: Full access' })).toBeVisible();

    await composerInput.fill('First session draft');
    await page.locator('.session-open').filter({ hasText: 'Second session' }).click();
    await expect(page.getByRole('button', { name: 'Permission level: Full access' })).toBeVisible();
    await expect(composerInput).toHaveValue('');
    await composerInput.fill('Second session draft');
    await page.locator('.session-open').filter({ hasText: 'First session' }).click();
    await expect(page.getByRole('button', { name: 'Permission level: Full access' })).toBeVisible();
    await expect(composerInput).toHaveValue('First session draft');
    await page.locator('.session-open').filter({ hasText: 'Second session' }).click();
    await expect(composerInput).toHaveValue('Second session draft');
    await expect(page.getByText('Second session').first()).toBeVisible();
    await expect(page.locator('.chat-message-row--assistant .message-footer-meta')).toContainText('Deterministic Test Model');
    await expect(page.locator('.markdown-content strong')).toHaveText('Second session');
    await expect(page.getByRole('article', { name: 'read tool succeeded' })).toBeVisible();
    await expect(page.getByText('historical output')).toHaveCount(0);
    await page.getByRole('article', { name: 'read tool succeeded' }).getByRole('button').click();
    await expect(page.getByText('historical output')).toBeVisible();

    const closed = page.waitForEvent('close');
    await page.getByRole('button', { name: 'Close window' }).click();
    await closed;
  } finally {
    await application.close();
    await rm(fixture.worktree, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
