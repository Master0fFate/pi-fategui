import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';
import { builtInThemes } from '../../src/shared/themes';

async function agents(page: Page) { await page.getByRole('tab', { name: 'Agents', exact: true }).click(); return page.getByRole('region', { name: 'Agents library' }); }
async function section(page: Page, name: string) { await page.getByRole('navigation', { name: 'Agents sections' }).getByRole('button', { name, exact: true }).click(); }
async function choose(page: Page, scope: Page | Locator, label: string, option: string) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function itemAction(page: Page, item: string, action: string) {
  await page.getByRole('button', { name: `Actions for ${item}`, exact: true }).click();
  const label = ['Edit', 'Disable', 'Enable', 'Delete'].includes(action) ? `${action} ${item}` : action;
  await page.getByRole('menu', { name: `Actions for ${item}`, exact: true }).getByRole('menuitem', { name: label, exact: true }).click();
}
async function appearance(page: Page, theme: RegExp, compact: boolean) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: /Skins/ }).click();
  await settings.getByRole('combobox', { name: 'Interface theme' }).click();
  await page.getByRole('option', { name: theme }).click();
  await settings.getByRole('tab', { name: /Compaction/ }).click();
  await settings.getByRole('checkbox', { name: /^Compact mode/ }).setChecked(compact);
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
}
async function contained(page: Page) {
  await expect.poll(() => page.locator('.sidebar-agent-library').evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    const newButton = panel.querySelector('.sidebar-toolbar-action--primary button');
    const newLabel = newButton?.querySelector('span:last-child');
    const labelFits = !newButton || !newLabel || (() => {
      const button = newButton.getBoundingClientRect();
      const label = newLabel.getBoundingClientRect();
      return label.top >= button.top - 1 && label.bottom <= button.bottom + 1;
    })();
    return labelFits && [...panel.querySelectorAll('button, input, select')].every((control) => {
      const bounds = control.getBoundingClientRect();
      return bounds.width === 0 || bounds.left >= rect.left - 1 && bounds.right <= rect.right + 1;
    }) && panel.scrollWidth <= panel.clientWidth + 1;
  })).toBe(true);
}
async function toolbarMatchesResources(page: Page) {
  const measure = () => page.locator('.sidebar-tab-content[data-state="active"] .sidebar-tab-toolbar').evaluate((toolbar) => {
    const metrics = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { x, y, width, height, background: style.backgroundColor, radius: style.borderRadius };
    };
    return {
      search: metrics(toolbar.querySelector('.sidebar-search')!),
      action: metrics(toolbar.querySelector('.sidebar-toolbar-action > button')!),
    };
  });
  const agentsToolbar = await measure();
  await page.getByRole('tab', { name: 'Resources', exact: true }).click();
  const resourcesToolbar = await measure();
  for (const key of ['search', 'action'] as const) {
    for (const dimension of ['x', 'y', 'height'] as const) expect(Math.abs(agentsToolbar[key][dimension] - resourcesToolbar[key][dimension])).toBeLessThanOrEqual(1);
    expect(agentsToolbar[key].background).toBe(resourcesToolbar[key].background);
    expect(agentsToolbar[key].radius).toBe(resourcesToolbar[key].radius);
  }
  expect(Math.abs(agentsToolbar.search.width - resourcesToolbar.search.width)).toBeLessThanOrEqual(1);
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
}
async function balancedNavigation(page: Page) {
  await expect.poll(() => page.locator('.agent-library-navigation button').evaluateAll((buttons) => {
    const widths = buttons.map((button) => button.getBoundingClientRect().width);
    const centers = buttons.map((button) => {
      const buttonRect = button.getBoundingClientRect();
      const iconRect = button.querySelector('.agent-library-nav-symbol')?.getBoundingClientRect();
      return iconRect ? Math.abs((buttonRect.left + buttonRect.right) / 2 - (iconRect.left + iconRect.right) / 2) : Number.POSITIVE_INFINITY;
    });
    const labels = buttons.map((button) => button.querySelector('.agent-library-nav-label') as HTMLElement | null);
    return widths.length === 5 && Math.max(...widths) - Math.min(...widths) <= 1.5 && Math.max(...centers) <= 1.5
      && labels.every((label) => label && label.getBoundingClientRect().width > 0 && label.scrollWidth <= label.clientWidth + 1);

  })).toBe(true);
}

for (const skin of ['default', 'dreamcore', 'm3-expressive'] as const) {
  test(`Agents lifecycle, approvals, migration and retained homes across ${skin}`, async () => {
    test.setTimeout(180_000);
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), `fate-agents-${skin}-`)));
    const project = path.join(directory, 'project');
    const profile = path.join(directory, 'profile');
    const data = path.join(profile, 'fateGUI');
    await mkdir(project); await mkdir(data, { recursive: true });
    const packPalette = JSON.parse(await readFile(path.resolve('examples/skins/ashen-terminal/skin.json'), 'utf8')).palette;
    await writeFile(path.join(data, 'themes.json'), JSON.stringify({ themes: [{ id: 'agents-custom', name: 'Agents custom palette', ...packPalette }] }));
    await writeFile(path.join(project, 'README.md'), '# Isolated Agents fixture\n');
    await writeFile(path.join(data, 'settings.json'), JSON.stringify(appSettingsSchema.parse({ appearance: 'dark', defaultModel: 'test/deterministic', thinkingLevel: 'high', confirmRiskyCommands: true, terminalShell: null, reduceMotion: true, skinId: skin, themeId: 'midnight', agentWorkspace: { preferredMode: 'shared', strict: false } })));
    await mkdir('screenshots/agents', { recursive: true });
    const launch = () => electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: profile, FATE_GUI_DATA_DIR: data, PI_OFFLINE: '1' } });
    let app: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      app = await launch();
      let page = await app.firstWindow();
      await page.getByRole('button', { name: /Open project/ }).first().click();
      await agents(page);
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
      await expect(page.getByText(/No saved Agents/)).toBeVisible();
      await balancedNavigation(page);
      await toolbarMatchesResources(page);
      await page.screenshot({ path: `screenshots/agents/${skin}-empty.png`, animations: 'disabled' });
      await page.getByRole('button', { name: 'New Agent', exact: true }).focus();
      await page.keyboard.press('Enter');
      let dialog = page.getByRole('dialog', { name: 'New Agent', exact: true });
      await dialog.getByLabel('Agent name', { exact: true }).fill('Reviewer');
      await dialog.getByLabel('Agent description').fill('A saved identity with a retained conversation, not a running team node.');
      await dialog.getByLabel('Agent instructions').fill('Review carefully. Keep task text in the user role.');
      await choose(page, dialog, 'Agent permission', 'Edit project files');
      await dialog.screenshot({ path: `screenshots/agents/${skin}-editor.png`, animations: 'disabled' });
      await dialog.getByRole('button', { name: 'Save Agent', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.getByRole('button', { name: 'Open home conversation', exact: true }).click();
      await expect(page.getByRole('tab', { name: 'Sessions', exact: true })).toHaveAttribute('data-state', 'active');
      const home = await page.evaluate(async () => (await window.piDesktop.getAgentLibrary()).states[0]!);
      expect(home.homeSessionId).toBeTruthy();
      await agents(page);
      await itemAction(page, 'Reviewer', 'Edit');
      dialog = page.getByRole('dialog', { name: 'Edit Agent', exact: true });
      await dialog.getByLabel('Agent name', { exact: true }).fill('Reviewer v2');
      await dialog.getByLabel('Agent instructions').fill('New instructions apply only to new conversations.');
      await dialog.getByRole('button', { name: 'Save Agent', exact: true }).click();
      await expect(page.getByText(/older instructions retained/)).toBeVisible();
      await expect.poll(() => page.locator('.agent-chat-actions button').evaluateAll((buttons) => buttons.length === 3 && buttons.every((button, index) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && button.scrollWidth <= button.clientWidth + 1 && buttons.every((other, otherIndex) => index === otherIndex || !(() => {
          const next = other.getBoundingClientRect();
          return rect.left < next.right && rect.right > next.left && rect.top < next.bottom && rect.bottom > next.top;
        })());
      }))).toBe(true);
      await page.getByRole('button', { name: 'Open home conversation', exact: true }).click();
      expect((await page.evaluate(async () => (await window.piDesktop.getAgentLibrary()).states[0]!)).homeSessionId).toBe(home.homeSessionId);
      await agents(page);

      await section(page, 'TaskTemplates');
      await page.getByRole('button', { name: 'New TaskTemplate', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'New TaskTemplate', exact: true });
      await dialog.getByLabel('TaskTemplate name').fill('Approval request');
      await dialog.getByLabel('TaskTemplate prompt').fill('E2E approved file effect');
      await choose(page, dialog, 'TaskTemplate permission', 'Edit project files');
      await dialog.getByRole('button', { name: 'Save TaskTemplate', exact: true }).click();
      await page.getByRole('button', { name: 'Run task', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Confirm Agent task run' });
      await expect(dialog.getByLabel('Run task payload')).toHaveValue('E2E approved file effect');
      await dialog.getByRole('button', { name: 'Confirm run' }).click();
      await expect(page.locator('.agent-run-status[data-status="succeeded"]')).toHaveCount(1);
      await expect(page.getByText('Deterministic Agent result; no provider was called.')).toBeVisible();

      await section(page, 'Routines');
      await page.getByRole('button', { name: 'New Routine', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'New Routine', exact: true });
      await dialog.getByLabel('Routine name').fill('Hourly review');
      await choose(page, dialog, 'Routine Agent', 'Reviewer v2');
      await choose(page, dialog, 'Routine TaskTemplate', 'Approval request');
      await dialog.getByLabel('Routine interval').fill('60');
      await dialog.getByLabel('Routine timezone').fill('America/New_York');
      await choose(page, dialog, 'Routine permission', 'Edit project files');
      await dialog.getByRole('button', { name: 'Save Routine', exact: true }).click();
      await expect(page.getByText('paused · 60m')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Test run', exact: true })).toBeDisabled();
      await itemAction(page, 'Hourly review', 'Enable');
      await expect(page.getByRole('button', { name: 'Test run', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Test run', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Confirm run' }).click();
      await page.getByRole('button', { name: 'Review action', exact: true }).click();
      await expect(stat(path.join(project, 'agent-approved.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      dialog = page.getByRole('dialog', { name: 'Review exact Agent action' });
      await expect(dialog.getByLabel('Exact proposed action')).toContainText('agent-approved.txt');
      await expect(dialog.getByRole('button', { name: 'Approve action' })).toBeDisabled();
      await dialog.screenshot({ path: `screenshots/agents/${skin}-needs-attention.png`, animations: 'disabled' });
      await dialog.getByRole('checkbox', { name: 'I reviewed the exact action and project' }).check();
      await dialog.getByRole('button', { name: 'Approve action' }).click();
      await expect(page.locator('.agent-run-status[data-status="succeeded"]')).toHaveCount(2);
      expect(await readFile(path.join(project, 'agent-approved.txt'), 'utf8')).toBe('Approved through real confined SDK tool.\n');
      await page.screenshot({ path: `screenshots/agents/${skin}-history.png`, animations: 'disabled' });
      await agents(page); await section(page, 'Agents');

      await itemAction(page, 'Reviewer v2', 'Edit');
      dialog = page.getByRole('dialog', { name: 'Edit Agent', exact: true });
      await dialog.getByLabel('Agent name', { exact: true }).fill('Do not lose this draft');
      await page.evaluate(async () => {
        const library = await window.piDesktop.getAgentLibrary(); const agent = library.agents[0]!;
        const { scope, name, instructions, skillRefs, defaults, enabled } = agent;
        await window.piDesktop.saveAgentDefinition({ id: agent.id, expected: library.revisions[`agent:${agent.id}`]!, value: { scope, name, instructions, skillRefs, defaults, enabled, description: 'Updated from another window.' } });
      });
      await dialog.getByRole('button', { name: 'Save Agent', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('conflict');
      await expect(dialog.getByLabel('Agent name', { exact: true })).toHaveValue('Do not lose this draft');
      await dialog.screenshot({ path: `screenshots/agents/${skin}-conflict.png`, animations: 'disabled' });
      await dialog.getByRole('button', { name: 'Close Agent editor' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
      await expect(dialog).toHaveCount(0);
      await page.getByRole('button', { name: 'Refresh Agents' }).click();
      await contained(page);
      const definitions = await page.evaluate(async () => (await window.piDesktop.getAgentLibrary()).agents);
      await appearance(page, /^Daylight/, true);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(980, 720));
      await contained(page);
      await toolbarMatchesResources(page);
      await page.screenshot({ path: `screenshots/agents/${skin}-compact-light.png`, animations: 'disabled' });
      for (const theme of builtInThemes) {
        await appearance(page, new RegExp(`^${theme.name}`), true);
        await balancedNavigation(page);
        await contained(page);
        await toolbarMatchesResources(page);
      }
      expect(await page.evaluate(async () => (await window.piDesktop.getAgentLibrary()).agents)).toEqual(definitions);

      const packSource = path.join(directory, 'pack');
      await cp(path.resolve('examples/skins/ashen-terminal'), packSource, { recursive: true });
      const manifest = JSON.parse(await readFile(path.join(packSource, 'skin.json'), 'utf8'));
      manifest.id = `agents-${skin}`; manifest.name = 'Agents custom pack'; manifest.base = skin;
      await writeFile(path.join(packSource, 'skin.json'), JSON.stringify(manifest));
      await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [source] })) as typeof dialog.showOpenDialog; }, packSource);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.getByRole('tab', { name: /Skins/ }).click();
      await settings.getByRole('button', { name: 'Import skin folder', exact: true }).click();
      if (skin === 'm3-expressive') {
        // Existing pack schema intentionally admits only Default/Angelcore bases.
        // Preserve that rejection contract; M3 still exercises a custom palette.
        await expect(settings.getByRole('alert')).toContainText('Invalid skin.json');
        await settings.getByRole('combobox', { name: 'Interface theme' }).click();
        await page.getByRole('option', { name: /^Agents custom palette/ }).click();
      } else {
        await settings.getByRole('combobox', { name: 'Interface skin' }).click();
        await page.getByRole('option', { name: /^Agents custom pack/ }).click();
        await settings.getByRole('combobox', { name: 'Interface theme' }).click();
        await page.getByRole('option', { name: /^Agents custom pack/ }).click();
      }
      await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
      await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
      await expect(page.locator('html')).toHaveAttribute('data-skin-id', skin === 'm3-expressive' ? skin : `pack:agents-${skin}`);
      await contained(page);
      await page.screenshot({ path: `screenshots/agents/${skin}-${skin === 'm3-expressive' ? 'custom-palette' : 'custom-pack'}.png`, animations: 'disabled' });
      expect(await page.evaluate(async () => (await window.piDesktop.getAgentLibrary()).agents)).toEqual(definitions);

      await app.close(); app = await launch(); page = await app.firstWindow();
      await page.getByRole('button', { name: /Open project/ }).first().click();
      await agents(page); await section(page, 'Agents');
      await page.getByRole('button', { name: 'Open home conversation', exact: true }).click();
      expect((await page.evaluate(async () => (await window.piDesktop.getAgentLibrary()).states[0]!)).homeSessionId).toBe(home.homeSessionId);
      await agents(page); await section(page, 'Agents');
      await itemAction(page, 'Reviewer v2', 'Disable');
      await expect(page.getByRole('button', { name: 'Open home conversation', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Start Session', exact: true })).toBeDisabled();
      await itemAction(page, 'Reviewer v2', 'Delete');
      await expect(page.getByRole('alertdialog')).toContainText('Saved conversations');
      await page.getByRole('alertdialog').screenshot({ path: `screenshots/agents/${skin}-delete.png`, animations: 'disabled' });
      await page.getByRole('button', { name: 'Delete definition', exact: true }).click();
      await expect(page.getByText(/No saved Agents/)).toBeVisible();
    } finally {
      await app?.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}
