import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function expectHoverTooltip(page: Page, trigger: Locator, content: string): Promise<void> {
  const tooltip = page.getByRole('tooltip').filter({ hasText: content });
  await expect(async () => {
    await page.mouse.move(1, 1);
    await trigger.hover();
    await expect(tooltip).toBeVisible({ timeout: 2_000 });
  }).toPass({ intervals: [100, 250, 500], timeout: 10_000 });
}

async function openInspectorView(page: Page, destination: 'Work' | 'Run' | 'System', view: string | RegExp): Promise<void> {
  await page.locator('.inspector-primary-nav').getByRole('button', { name: new RegExp(`^${destination}(?:,|$)`, 'u') }).click();
  await page.getByRole('tab', { name: view }).click();
}

async function sidebarSearchVisual(input: Locator): Promise<Record<string, string>> {
  return input.evaluate((node) => {
    const field = node.closest('label');
    const icon = field?.querySelector('svg');
    if (!field || !icon) throw new Error('Sidebar search field is incomplete.');
    const fieldStyle = getComputedStyle(field);
    const inputStyle = getComputedStyle(node);
    const iconStyle = getComputedStyle(icon);
    return {
      width: fieldStyle.width,
      height: fieldStyle.height,
      gap: fieldStyle.gap,
      paddingInlineStart: fieldStyle.paddingInlineStart,
      paddingInlineEnd: fieldStyle.paddingInlineEnd,
      borderWidth: fieldStyle.borderWidth,
      borderRadius: fieldStyle.borderRadius,
      backgroundColor: fieldStyle.backgroundColor,
      color: fieldStyle.color,
      inputFontSize: inputStyle.fontSize,
      iconWidth: iconStyle.width,
      iconHeight: iconStyle.height,
    };
  });
}

function sidebarSearchWidth(visual: Record<string, string>): number {
  const width = visual.width;
  if (!width) throw new Error('Sidebar search width was not measured.');
  return Number.parseFloat(width);
}

function expectSidebarSearchVisualMatch(actual: Record<string, string>, expected: Record<string, string>): void {
  const { width: _actualWidth, ...actualStyle } = actual;
  const { width: _expectedWidth, ...expectedStyle } = expected;
  expect(sidebarSearchWidth(actual)).toBeGreaterThan(0);
  expect(sidebarSearchWidth(expected)).toBeGreaterThan(0);
  expect(actualStyle).toEqual(expectedStyle);
}

async function sidebarToolbarLayout(input: Locator): Promise<{ rowTopSpread: number; overflow: number; searchToActionGap: number }> {
  return input.evaluate((node) => {
    const search = node.closest('label');
    const toolbar = search?.parentElement;
    if (!search || !toolbar) throw new Error('Sidebar search toolbar is incomplete.');
    const searchBox = search.getBoundingClientRect();
    const itemBoxes = [...toolbar.children]
      .map((item) => item.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    const firstActionBox = itemBoxes.at(1);
    if (!firstActionBox) throw new Error('Sidebar toolbar actions are missing.');
    const tops = itemBoxes.map((box) => box.top);
    return {
      rowTopSpread: Math.max(...tops) - Math.min(...tops),
      overflow: toolbar.scrollWidth - toolbar.clientWidth,
      searchToActionGap: firstActionBox.left - searchBox.right,
    };
  });
}

async function writeBrowserPreview(root: string): Promise<void> {
  await mkdir(path.join(root, 'preview'), { recursive: true });
  await writeFile(path.join(root, 'preview/index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Fate Local Preview</title>
  <link rel="stylesheet" href="./preview.css">
</head>
<body>
  <main>
    <p class="eyebrow">LOCAL APP</p>
    <h1 id="preview-title">Browser annotation fixture</h1>
    <p>Inspect the rendered interface, then attach exact elements to the conversation.</p>
    <div class="actions">
      <button id="save" class="primary" data-testid="save-button" type="button">Save changes</button>
      <button id="publish" type="button">Publish preview</button>
    </div>
    <output id="click-count">0</output>
  </main>
  <script>
    window.__saveClicks = 0;
    document.querySelector('#save').addEventListener('click', (event) => {
      window.__saveClicks += 1;
      event.currentTarget.textContent = 'Saved ' + window.__saveClicks;
      document.querySelector('#click-count').textContent = String(window.__saveClicks);
    });
  </script>
</body>
</html>`);
  await writeFile(path.join(root, 'preview/preview.css'), `
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background: #0b0d14; color: #f6f7fb; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: start center; }
    main { width: min(680px, calc(100% - 64px)); margin-top: 56px; padding: 36px; border: 1px solid #2d3345; border-radius: 18px; background: #141824; }
    .eyebrow { color: #9e91ff; font-size: 12px; font-weight: 700; letter-spacing: .14em; }
    h1 { margin: 8px 0; font-size: 34px; }
    p { color: #adb5c8; }
    .actions { display: flex; gap: 12px; margin-top: 28px; }
    button { padding: 12px 18px; border: 1px solid #424a61; border-radius: 10px; color: #eff1f8; background: #202637; }
    button.primary { border-color: #7c6cff; background: rgb(124, 108, 255); color: white; }
    output { display: block; margin-top: 20px; color: #727b91; }
  `);
}

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

test('left sidebar unifies real resources and persisted project automations', async () => {
  const fixture = await fixtureRepository();
  const userData = await mkdtemp(path.join(tmpdir(), 'pi-desktop-resource-profile-'));
  const application = await electron.launch({
    args: [path.resolve('.test-dist/main/index.js')],
    env: { ...process.env, PI_DESKTOP_E2E_PROJECT: fixture.root, PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: path.join(userData, 'fateGUI'), PI_OFFLINE: '1' },
  });

  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /Open project/u }).first().click();
    await expect(page.getByText(path.basename(fixture.root)).first()).toBeVisible();

    const voiceButton = page.getByRole('button', { name: 'Start voice recording' });
    const voiceBox = await voiceButton.boundingBox();
    if (!voiceBox) throw new Error('Voice input button was not rendered.');
    await page.mouse.move(voiceBox.x + voiceBox.width / 2, voiceBox.y + voiceBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(200);
    const pressedVoiceStyle = await voiceButton.evaluate((button) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--theme-accent)';
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const style = getComputedStyle(button);
      return { accent, color: style.color, backgroundColor: style.backgroundColor, boxShadow: style.boxShadow, transform: style.transform };
    });
    await page.mouse.move(1, 1);
    await page.mouse.up();
    expect(pressedVoiceStyle.color).toBe(pressedVoiceStyle.accent);
    expect(pressedVoiceStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(pressedVoiceStyle.boxShadow).toBe('none');
    expect(pressedVoiceStyle.transform).toBe('none');

    const sidebarTabs = page.getByRole('tablist', { name: 'Sidebar destinations' });
    await expect(sidebarTabs.getByRole('tab')).toHaveText(['Sessions', 'Automations', 'Resources']);
    const sessionSearch = page.getByLabel('Search sessions');
    const sessionSearchVisual = await sidebarSearchVisual(sessionSearch);
    const sessionToolbarLayout = await sidebarToolbarLayout(sessionSearch);
    expect(sessionToolbarLayout.rowTopSpread).toBeLessThanOrEqual(1);
    expect(sessionToolbarLayout.overflow).toBeLessThanOrEqual(0);
    expect(sessionToolbarLayout.searchToActionGap).toBeGreaterThanOrEqual(4);
    expect(sessionToolbarLayout.searchToActionGap).toBeLessThanOrEqual(6);
    await sidebarTabs.getByRole('tab', { name: 'Resources' }).click();
    await expect(page.getByRole('button', { name: /Files.*Browse and preview project files/u })).toBeVisible();
    await expect(page.getByRole('button', { name: /Browser.*Built-in Chromium workspace/u })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Computer/u })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Pi Library/u })).toHaveCount(1);
    await expect(page.locator('.resource-preview-group').filter({ hasText: 'Pi Library' })).toHaveCount(0);

    const resourceSearch = page.getByRole('searchbox', { name: 'Search resources' });
    const resourceSearchVisual = await sidebarSearchVisual(resourceSearch);
    expectSidebarSearchVisualMatch(resourceSearchVisual, sessionSearchVisual);
    expect(sidebarSearchWidth(resourceSearchVisual)).toBeGreaterThan(sidebarSearchWidth(sessionSearchVisual) + 20);
    const resourceToolbarLayout = await sidebarToolbarLayout(resourceSearch);
    expect(resourceToolbarLayout.rowTopSpread).toBeLessThanOrEqual(1);
    expect(resourceToolbarLayout.overflow).toBeLessThanOrEqual(0);
    await resourceSearch.fill('example');
    await page.getByRole('button', { name: /example\.ts.*src\/example\.ts/u }).click();
    await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('data-state', 'active');
    await expect(page.locator('.preview-heading')).toContainText('src/example.ts');

    await sidebarTabs.getByRole('tab', { name: 'Automations' }).click();
    const automationSearch = page.getByRole('searchbox', { name: 'Search automations' });
    const automationSearchVisual = await sidebarSearchVisual(automationSearch);
    expectSidebarSearchVisualMatch(automationSearchVisual, sessionSearchVisual);
    expect(sidebarSearchWidth(automationSearchVisual)).toBeGreaterThan(sidebarSearchWidth(sessionSearchVisual) + 20);
    const automationToolbarLayout = await sidebarToolbarLayout(automationSearch);
    expect(automationToolbarLayout.rowTopSpread).toBeLessThanOrEqual(1);
    expect(automationToolbarLayout.overflow).toBeLessThanOrEqual(0);
    const automationPanel = page.locator('.sidebar-automation-panel');
    const automationEmpty = automationPanel.locator('.sidebar-tab-empty');
    await expect(automationEmpty).toContainText('No automations yet');
    const [panelBox, emptyBox] = await Promise.all([automationPanel.boundingBox(), automationEmpty.boundingBox()]);
    expect(panelBox).not.toBeNull();
    expect(emptyBox).not.toBeNull();
    expect(emptyBox!.height).toBeGreaterThan(panelBox!.height * 0.6);
    await page.getByRole('button', { name: 'New automation' }).click();
    const editor = page.getByRole('dialog', { name: 'New automation' });
    await editor.getByLabel('Name').fill('Review fixture');
    await editor.getByLabel('Prompt').fill('Review the fixture changes and report focused test coverage.');
    await editor.getByRole('button', { name: 'Create automation' }).click();
    await expect(page.getByRole('button', { name: /^Review fixture/u })).toBeVisible();

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    const commandCenter = page.getByRole('dialog', { name: 'Command center' });
    await commandCenter.getByRole('textbox', { name: 'Search commands and resources' }).fill('Review fixture');
    await commandCenter.getByRole('option', { name: /^Review fixture/u }).click();
    const exactAutomation = page.getByRole('dialog', { name: 'Edit automation' });
    await expect(exactAutomation.getByLabel('Name')).toHaveValue('Review fixture');
    await exactAutomation.getByRole('button', { name: 'Cancel' }).click();

    const saved = await page.evaluate(() => window.piDesktop.listAutomations());
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Review fixture', permissionLevel: 'read-only' });

    await page.getByRole('button', { name: /^Review fixture/u }).click();
    await expect(page.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Message Pi')).toHaveValue('Review the fixture changes and report focused test coverage.');
    await expect.poll(async () => (await page.evaluate(() => window.piDesktop.listAutomations()))[0]?.launchCount).toBe(1);
  } finally {
    await application.close();
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.worktree, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('expanding the bottom project keeps its sessions contained, indented, and below its header', async () => {
  const fixture = await fixtureRepository();
  const userData = await mkdtemp(path.join(tmpdir(), 'pi-desktop-folder-layout-'));
  const application = await electron.launch({
    args: [path.resolve('.test-dist/main/index.js')],
    env: {
      ...process.env,
      PI_DESKTOP_E2E_PROJECT: fixture.root,
      PI_DESKTOP_E2E_SECOND_PROJECT: fixture.worktree,
      PI_DESKTOP_E2E_USER_DATA: userData,
      PI_DESKTOP_E2E_SESSION_COUNT: '120',
      FATE_GUI_DATA_DIR: path.join(userData, 'fateGUI'),
      PI_OFFLINE: '1',
    },
  });

  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /Open project/u }).first().click();
    await page.locator('.session-toolbar').getByRole('button', { name: 'Open project' }).click();
    await expect(page.locator('.folder-group')).toHaveCount(2);

    await page.evaluate(({ root, worktree }) => {
      const key = 'pi-desktop-projects-v1';
      const persisted = JSON.parse(localStorage.getItem(key) ?? '{}') as { state?: { projects?: Array<{ path: string }> } };
      const projects = persisted.state?.projects ?? [];
      projects.sort((left, right) => [root, worktree].indexOf(left.path) - [root, worktree].indexOf(right.path));
      localStorage.setItem(key, JSON.stringify({ ...persisted, state: { ...persisted.state, projects } }));
    }, { root: fixture.root.replaceAll('\\', '/'), worktree: fixture.worktree.replaceAll('\\', '/') });
    await page.reload();

    const list = page.locator('.folder-list[aria-label="Projects"]');
    const groups = list.locator(':scope > .folder-group');
    await expect(groups).toHaveCount(2);
    const top = groups.nth(0);
    const bottom = groups.nth(1);
    await expect(bottom.locator('.folder-open')).toHaveAttribute('aria-current', 'true');

    for (const group of [top, bottom]) {
      const collapse = group.getByRole('button', { name: /^Collapse /u });
      if (await collapse.count()) await collapse.click();
    }
    const before = await list.evaluate((element) => {
      const groups = [...element.querySelectorAll<HTMLElement>(':scope > .folder-group')];
      return groups.map((group) => {
        const header = group.querySelector<HTMLElement>(':scope > .folder-header')!;
        const name = group.querySelector<HTMLElement>('.folder-name')!;
        const rect = header.getBoundingClientRect();
        const groupRect = group.getBoundingClientRect();
        const rows = [...group.querySelectorAll<HTMLElement>('.folder-children .session-row')].map((row) => {
          const rowRect = row.getBoundingClientRect();
          return { top: rowRect.top, bottom: rowRect.bottom, left: rowRect.left };
        });
        return { name: name.textContent, top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom, groupBottom: groupRect.bottom, rows };
      });
    });

    await bottom.getByRole('button', { name: /^Expand /u }).click();
    const rows = bottom.locator('.folder-children .session-row');
    await expect.poll(() => rows.count()).toBeGreaterThan(1);
    const after = await list.evaluate((element) => {
      const groups = [...element.querySelectorAll<HTMLElement>(':scope > .folder-group')];
      const headers = groups.map((group) => {
        const header = group.querySelector<HTMLElement>(':scope > .folder-header')!;
        const name = group.querySelector<HTMLElement>('.folder-name')!;
        const rect = header.getBoundingClientRect();
        return { name: name.textContent, top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom };
      });
      const bottomGroup = groups[1]!;
      const groupRect = bottomGroup.getBoundingClientRect();
      const headerRect = bottomGroup.querySelector<HTMLElement>(':scope > .folder-header')!.getBoundingClientRect();
      const childRect = bottomGroup.querySelector<HTMLElement>(':scope > .folder-children')!.getBoundingClientRect();
      const chevronRect = bottomGroup.querySelector<SVGElement>(':scope > .folder-header .folder-chevron > svg')!.getBoundingClientRect();
      const rowRects = [...bottomGroup.querySelectorAll<HTMLElement>('.folder-children .session-row')].map((row) => {
        const rect = row.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
      });
      const scrollOwners = [...element.closest<HTMLElement>('.sidebar-session-panel')!.querySelectorAll<HTMLElement>('*')]
        .filter((node) => {
          const overflowY = getComputedStyle(node).overflowY;
          return (overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight;
        })
        .map((node) => node.className);
      return {
        headers,
        groupRect: { top: groupRect.top, bottom: groupRect.bottom },
        headerRect: { left: headerRect.left, bottom: headerRect.bottom },
        childLeft: childRect.left,
        connectorCenter: childRect.left + Number.parseFloat(getComputedStyle(bottomGroup.querySelector<HTMLElement>(':scope > .folder-children')!).borderInlineStartWidth) / 2,
        chevronCenter: chevronRect.left + chevronRect.width / 2,
        rowRects,
        scrollOwners,
      };
    });

    for (const collapsedGroup of before) {
      expect(collapsedGroup.rows.every((row) => row.top >= collapsedGroup.bottom && row.bottom <= collapsedGroup.groupBottom && row.left > collapsedGroup.left + 16)).toBe(true);
    }
    expect(after.headers.map((header) => header.name)).toEqual(before.map((header) => header.name));
    for (let index = 0; index < before.length; index += 1) {
      expect(after.headers[index]!.top).toBeCloseTo(before[index]!.top, 0);
      expect(after.headers[index]!.left).toBeCloseTo(before[index]!.left, 0);
      expect(after.headers[index]!.width).toBeCloseTo(before[index]!.width, 0);
      expect(after.headers[index]!.height).toBeCloseTo(before[index]!.height, 0);
    }
    expect(after.headers[0]!.bottom).toBeLessThanOrEqual(after.headers[1]!.top);
    expect(after.childLeft).toBeGreaterThan(after.headerRect.left + 8);
    expect(after.chevronCenter).toBeCloseTo(after.connectorCenter, 5);
    expect(after.rowRects[0]!.left).toBeGreaterThan(after.headerRect.left + 16);
    expect(after.rowRects[0]!.top).toBeGreaterThanOrEqual(after.headerRect.bottom);
    expect(after.rowRects[0]!.bottom).toBeLessThanOrEqual(after.rowRects[1]!.top);
    expect(after.rowRects.every((row) => row.top >= after.groupRect.top && row.bottom <= after.groupRect.bottom)).toBe(true);
    expect(after.scrollOwners).toHaveLength(1);
    expect(String(after.scrollOwners[0])).toContain('folder-list');

    await bottom.getByRole('button', { name: /^Collapse /u }).click();
    const secondHeaderTopBefore = (await bottom.locator(':scope > .folder-header').boundingBox())!.y;
    await top.getByRole('button', { name: /^Expand /u }).click();
    await expect.poll(() => top.locator('.folder-children .session-row').count()).toBeGreaterThan(1);
    const precedingExpansion = await list.evaluate((element) => {
      const groups = [...element.querySelectorAll<HTMLElement>(':scope > .folder-group')];
      const topGroup = groups[0]!.getBoundingClientRect();
      const topHeader = groups[0]!.querySelector<HTMLElement>(':scope > .folder-header')!.getBoundingClientRect();
      const secondHeader = groups[1]!.querySelector<HTMLElement>(':scope > .folder-header')!.getBoundingClientRect();
      const rows = [...groups[0]!.querySelectorAll<HTMLElement>('.folder-children .session-row')].map((row) => row.getBoundingClientRect());
      return {
        topGroupBottom: topGroup.bottom,
        topHeaderBottom: topHeader.bottom,
        secondHeaderTop: secondHeader.top,
        rowTops: rows.map((row) => row.top),
        rowBottoms: rows.map((row) => row.bottom),
      };
    });
    expect(precedingExpansion.secondHeaderTop).toBeGreaterThan(secondHeaderTopBefore);
    expect(precedingExpansion.topGroupBottom).toBeLessThanOrEqual(precedingExpansion.secondHeaderTop);
    expect(precedingExpansion.rowTops.every((top) => top >= precedingExpansion.topHeaderBottom)).toBe(true);
    expect(precedingExpansion.rowBottoms.every((bottom) => bottom <= precedingExpansion.topGroupBottom)).toBe(true);
  } finally {
    await application.close();
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.worktree, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('built-in Chromium opens local HTML and attaches DevTools-style element annotations to chat', async () => {
  const fixture = await fixtureRepository();
  await writeBrowserPreview(fixture.root);
  const userData = await mkdtemp(path.join(tmpdir(), 'pi-desktop-browser-profile-'));
  const localEntry = path.join(fixture.root, 'preview/index.html');
  const privatePreviewSockets = new Set<Socket>();
  const privatePreview = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Private proxy probe</title><script>
      const socket = new WebSocket('ws://' + location.host + '/events');
      socket.addEventListener('open', () => { document.title = 'Private proxy ready'; });
      socket.addEventListener('message', (event) => {
        if (event.data === 'hot-update') { document.title = 'Private live update ready'; socket.close(); }
      });
      socket.addEventListener('error', () => { document.title = 'Private proxy failed'; });
    </script>`);
  });
  privatePreview.on('connection', (socket) => {
    privatePreviewSockets.add(socket);
    socket.once('close', () => privatePreviewSockets.delete(socket));
  });
  privatePreview.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const update = Buffer.from('hot-update');
    setTimeout(() => socket.write(Buffer.concat([Buffer.from([0x81, update.length]), update])), 50).unref();
    setTimeout(() => socket.end(), 250).unref();
  });
  await new Promise<void>((resolve) => privatePreview.listen(0, '127.0.0.1', resolve));
  const privateAddress = privatePreview.address();
  if (!privateAddress || typeof privateAddress === 'string') throw new Error('Private browser probe did not bind.');
  const privateOrigin = `http://127.0.0.1:${privateAddress.port}`;
  const application = await electron.launch({
    args: [path.resolve('.test-dist/main/index.js')],
    env: { ...process.env, PI_DESKTOP_E2E_PROJECT: fixture.root, PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: path.join(userData, 'fateGUI'), PI_OFFLINE: '1' },
  });

  const clickNativeElement = async (selector: string) => application.evaluate(async ({ webContents }, targetSelector) => {
    const browser = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('fate-local://'));
    if (!browser?.debugger.isAttached()) throw new Error('The built-in Chromium debugger is unavailable.');
    const document = await browser.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as { root: { nodeId: number } };
    const selected = await browser.debugger.sendCommand('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: targetSelector,
    }) as { nodeId: number };
    if (!selected.nodeId) throw new Error(`Could not find ${targetSelector} in the local preview.`);
    await browser.debugger.sendCommand('DOM.scrollIntoViewIfNeeded', { nodeId: selected.nodeId });
    const box = await browser.debugger.sendCommand('DOM.getBoxModel', { nodeId: selected.nodeId }) as { model?: { border?: number[] } };
    const quad = box.model?.border;
    if (!quad || quad.length < 8) throw new Error(`Could not locate ${targetSelector} in the local preview.`);
    const x = Math.round(((quad[0] ?? 0) + (quad[2] ?? 0) + (quad[4] ?? 0) + (quad[6] ?? 0)) / 4);
    const y = Math.round(((quad[1] ?? 0) + (quad[3] ?? 0) + (quad[5] ?? 0) + (quad[7] ?? 0)) / 4);
    browser.focus();
    browser.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 });
    browser.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    browser.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return { x, y };
  }, selector);

  const readSaveClicks = () => application.evaluate(async ({ webContents }) => {
    const browser = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('fate-local://'));
    return browser ? await browser.executeJavaScript('globalThis.__saveClicks ?? -1') as number : -1;
  });

  try {
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1024, 684));
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1024, 684]);
    await page.getByRole('button', { name: /Open project/u }).first().click();
    await expect(page.getByText(path.basename(fixture.root)).first()).toBeVisible();

    await page.getByRole('button', { name: 'Open browser' }).click();
    await expect(page.getByTestId('browser-workspace')).toBeVisible();
    await expect(page.getByLabel('Message Pi')).toBeVisible();
    await expect(page.locator('.workspace-mode-switch')).toHaveCount(0);
    await expect(page.locator('.inspector-primary-nav').getByRole('button', { name: /^Browser(?:,|$)/u })).toHaveCount(0);

    const addressInput = page.getByRole('textbox', { name: 'Browser address' });
    await application.evaluate(({ webContents }) => {
      const tracker = globalThis as { __fateNavEvents?: string[] };
      tracker.__fateNavEvents ??= [];
      for (const contents of webContents.getAllWebContents()) {
        const marked = contents as unknown as { __fateInstrumented?: boolean };
        if (marked.__fateInstrumented) continue;
        marked.__fateInstrumented = true;
        contents.on('did-start-navigation', (_event, url, _isSameDocument, isMainFrame) => {
          tracker.__fateNavEvents?.push(`start id=${contents.id} main=${isMainFrame} ${url}`);
        });
        contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
          tracker.__fateNavEvents?.push(`fail id=${contents.id} main=${isMainFrame} code=${errorCode} ${errorDescription} ${validatedURL}`);
        });
        contents.on('did-navigate', (_event, url) => {
          tracker.__fateNavEvents?.push(`nav id=${contents.id} ${url}`);
        });
      }
    });
    await addressInput.fill(localEntry);
    await addressInput.press('Enter');
    try {
      await expect(page.getByRole('tab', { name: 'Fate Local Preview' })).toBeVisible({ timeout: 20_000 });
    } catch (failure) {
      const contentsDump = await application.evaluate(({ webContents }) => webContents.getAllWebContents().map((entry) => ({
        id: entry.id,
        url: entry.getURL(),
        title: entry.getTitle(),
      })));
      const eventsDump = await application.evaluate(() => (globalThis as { __fateNavEvents?: string[] }).__fateNavEvents ?? []);
      throw new Error(`Local preview never opened.\nWebContents: ${JSON.stringify(contentsDump)}\nNavigation events:\n${eventsDump.join('\n')}\n\n${(failure as Error).message}`);
    }
    await expect.poll(() => application.evaluate(({ webContents }) => (
      webContents.getAllWebContents().some((contents) => contents.getURL().startsWith('fate-local://'))
    ))).toBe(true);

    await expect.poll(async () => {
      const [reservation, nativeBounds, zoom] = await Promise.all([
        page.locator('.browser-viewport-reservation').boundingBox(),
        application.evaluate(({ BrowserWindow }) => {
          const owner = BrowserWindow.getAllWindows()[0];
          const child = owner?.contentView.children[0];
          return child?.getBounds() ?? null;
        }),
        application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 1),
      ]);
      if (!reservation || !nativeBounds) return Number.POSITIVE_INFINITY;
      return Math.max(
        Math.abs(nativeBounds.x - Math.round(reservation.x * zoom)),
        Math.abs(nativeBounds.y - Math.round(reservation.y * zoom)),
        Math.abs(nativeBounds.width - Math.round(reservation.width * zoom)),
        Math.abs(nativeBounds.height - Math.round(reservation.height * zoom)),
      );
    }).toBeLessThanOrEqual(1);
    await expect.poll(() => application.evaluate(async ({ webContents }) => {
      const browser = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('fate-local://'));
      if (!browser) return false;
      return browser.executeJavaScript(`document.readyState === 'complete' && ['#preview-title', '#save', '#publish'].every((selector) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })`);
    })).toBe(true);

    const interactiveSnapshot = await page.evaluate(async () => window.piDesktop.snapshotBrowser({ mode: 'interactive' }));
    expect(interactiveSnapshot.serialized).toContain('Browser annotation fixture');
    expect(interactiveSnapshot.url).toBe('file:///index.html');
    expect(interactiveSnapshot.serialized).not.toContain(fixture.root);

    const fullSnapshot = await page.evaluate(async () => window.piDesktop.snapshotBrowser({ mode: 'full' }));
    expect(fullSnapshot.serialized).toContain('Save changes');
    expect(fullSnapshot.serialized).toContain('Publish preview');
    expect(fullSnapshot.url).toBe('file:///index.html');
    expect(fullSnapshot.serialized).not.toContain(fixture.root);

    const primaryButtonColor = await application.evaluate(async ({ webContents }) => {
      const browser = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('fate-local://'));
      return browser ? await browser.executeJavaScript("getComputedStyle(document.querySelector('#save')).backgroundColor") as string : '';
    });
    expect(primaryButtonColor).toBe('rgb(124, 108, 255)');

    const browserProxy = await application.evaluate(async ({ webContents }) => {
      const browser = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('fate-local://'));
      return browser ? await browser.session.resolveProxy('https://example.test/') : '';
    });
    expect(browserProxy).toMatch(/^PROXY 127\.0\.0\.1:\d+/u);

    const localEgressPolicy = await application.evaluate(async ({ webContents }) => {
      const browser = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('fate-local://'));
      if (!browser) return null;
      return browser.executeJavaScript(`new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ directive: '', blocked: '' }), 1000);
        document.addEventListener('securitypolicyviolation', (event) => {
          clearTimeout(timeout);
          resolve({ directive: event.effectiveDirective, blocked: event.blockedURI });
        }, { once: true });
        fetch('https://example.invalid/collect', { method: 'POST', body: 'preview-data' }).catch(() => undefined);
      })`);
    });
    expect(localEgressPolicy).toEqual({ directive: 'connect-src', blocked: 'https://example.invalid/collect' });

    const primaryModifier: 'meta' | 'control' = process.platform === 'darwin' ? 'meta' : 'control';
    await application.evaluate(({ webContents }, input) => {
      const browser = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('fate-local://'));
      browser?.focus();
      browser?.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: [input.primaryModifier] });
      browser?.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: [input.primaryModifier] });
    }, { primaryModifier });
    await expect(addressInput).toBeFocused();

    await page.getByRole('button', { name: 'New browser tab' }).click();
    await expect(page.getByRole('tablist', { name: 'Browser tabs' }).getByRole('tab')).toHaveCount(2);
    await page.getByRole('tab', { name: 'Fate Local Preview' }).click();

    const annotate = page.getByRole('button', { name: 'Annotate' });
    await annotate.click();
    await expect(annotate).toHaveAttribute('aria-pressed', 'true');
    await clickNativeElement('#save');

    const attachments = page.getByTestId('browser-annotation-attachment');
    await expect(attachments).toHaveCount(1);
    await expect(attachments.first()).toContainText('Save changes');
    await expect(attachments.first().locator('pre code')).toContainText('<button');
    await expect(attachments.first().locator('pre code')).toContainText('data-testid="save-button"');
    expect(await readSaveClicks()).toBe(0);

    const note = page.getByRole('textbox', { name: 'Note for browser annotation 1' });
    await note.fill('Keep this as the primary action');
    await note.press('Enter');
    await clickNativeElement('#publish');
    await expect(attachments).toHaveCount(2);
    await expect(attachments.nth(1)).toContainText('Publish preview');

    await page.screenshot({ path: 'test-results/pi-desktop-browser.png' });

    // Agent control is always on; toggling annotate off returns direct clicks.
    await annotate.click();
    await expect(annotate).toHaveAttribute('aria-pressed', 'false');
    await clickNativeElement('#save');
    await expect.poll(readSaveClicks).toBe(1);

    const device = page.getByRole('button', { name: 'Toggle device toolbar' });
    await device.click();
    const stage = page.getByTestId('browser-device-stage');
    await expect(stage).toBeVisible();
    await expect(page.getByRole('toolbar', { name: 'Device toolbar' })).toBeVisible();
    await expect(device).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Annotate' })).toHaveAttribute('aria-pressed', 'false');
    await device.click();
    await expect(stage).toHaveCount(0);

    await page.getByRole('button', { name: 'Close Fate Local Preview' }).click();
    await expect(page.getByRole('tablist', { name: 'Browser tabs' }).getByRole('tab')).toHaveCount(1);
    await expect(attachments).toHaveCount(2);

    await addressInput.fill(privateOrigin);
    await addressInput.press('Enter');
    await expect(page.getByRole('tab', { name: 'Private live update ready' })).toBeVisible();
    await expect(page.getByText('Let Pi use this site?')).toHaveCount(0);

    await page.locator('.workspace-browser-toggle').click();
    await expect(page.getByTestId('browser-workspace')).toHaveCount(0);
    await expect(attachments).toHaveCount(2);

    await page.getByLabel('Message Pi').fill('Polish these exact controls');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(attachments).toHaveCount(0);

    await expect(page.getByLabel('Message Pi')).toBeVisible();

    const browserShortcut = process.platform === 'darwin' ? 'Meta+Shift+B' : 'Control+Shift+B';
    await page.keyboard.press(browserShortcut);
    await expect(page.getByTestId('browser-workspace')).toBeVisible();
    await page.keyboard.press(browserShortcut);
    await expect(page.getByTestId('browser-workspace')).toHaveCount(0);
  } finally {
    await application.close();
    for (const socket of privatePreviewSockets) socket.destroy();
    privatePreview.closeAllConnections();
    await new Promise<void>((resolve) => privatePreview.close(() => resolve()));
    await rm(fixture.worktree, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

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
    await expect(page.getByRole('heading', { name: 'Start with your AI connection' })).toBeVisible();
    await expect(page.locator('.brand-mark')).toHaveText('ƒ');
    await expect(page.locator('.welcome-symbol')).toHaveText('ƒ');
    await expect(page.locator('.action-card')).toHaveCount(4);
    await expect(page.getByRole('button', { name: /Connect your AI/ })).toBeEnabled();
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
        const dragRegions = [...document.querySelectorAll<HTMLElement>('.window-drag-region, .workspace-header-drag, .workspace-header-drag-tail, .inspector-heading')];
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
    // Windows and Linux keep min/max/close in the top-right corner. When the inspector
    // is collapsed, header and browser-pane action buttons must clear that fixed strip.
    const assertHeaderActionsClearOfWindowControls = async () => {
      const clashes = await page.evaluate(() => {
        const controlsStrip = document.querySelector<HTMLElement>('.window-controls');
        if (!controlsStrip) return [];
        const stripRect = controlsStrip.getBoundingClientRect();
        const targets = [...document.querySelectorAll<HTMLElement>('.session-controls button, .browser-tab-strip button, .browser-toolbar button')];
        return targets
          .filter((target) => {
            const rect = target.getBoundingClientRect();
            return rect.left < stripRect.right && rect.right > stripRect.left && rect.top < stripRect.bottom && rect.bottom > stripRect.top;
          })
          .map((target) => target.getAttribute('aria-label') ?? target.className);
      });
      expect(clashes).toEqual([]);
    };
    // Overlays (toast, control-error) can geometrically sit inside header drag bands;
    // they must stay no-drag so their buttons never start a window drag.
    const assertOverlaysAreNoDrag = async () => {
      const regions = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.app-toast, .window-control-error')].map((element) => ({
        className: element.className,
        region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
      })));
      expect(regions.filter((entry) => entry.region !== 'no-drag')).toEqual([]);
    };
    // The app-shell animates grid columns (150ms): assertions must wait until the
    // header reaches its resting position — the state users actually click in.
    const waitForCollapsedLayoutToSettle = () => page.waitForTimeout(300);
    await assertWindowControlsOutsideDragRegions();
    await page.getByRole('button', { name: 'Collapse inspector' }).click();
    await expect(page.locator('.app-shell')).toHaveClass(/app-shell--inspector-collapsed/);
    await waitForCollapsedLayoutToSettle();
    await assertWindowControlsOutsideDragRegions();
    await assertHeaderActionsClearOfWindowControls();
    await assertOverlaysAreNoDrag();
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
    const activityPulse = page.getByLabel(/Activity: Ready\. 42\.0% context/u);
    await expect(activityPulse).toBeVisible();
    await expect(activityPulse).toContainText('changed');
    await expect(activityPulse).not.toContainText('Completed with changes');
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
    await expect(page.getByRole('heading', { name: 'Start with your AI connection' })).toHaveCount(0);
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

    const extensionRail = page.getByRole('status', { name: 'Pi extension status' });
    const extensionDetails = page.getByRole('button', { name: 'Show 3 extension details' });
    await expect(extensionRail).toBeVisible();
    await expect(extensionRail).toContainText('PLUGIN: output ready');
    const readExtensionRailLayout = () => page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>('.extension-status-rail')!;
      const trigger = document.querySelector<HTMLElement>('.extension-status-details-trigger')!;
      const workspace = document.querySelector<HTMLElement>('.workspace')!;
      const header = document.querySelector<HTMLElement>('.workspace-header')!;
      const welcome = document.querySelector<HTMLElement>('.welcome')!;
      const composer = document.querySelector<HTMLElement>('.composer-wrap')!;
      const rect = (element: HTMLElement) => {
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, right: bounds.right, bottom: bounds.bottom, left: bounds.left, width: bounds.width, height: bounds.height };
      };
      return {
        position: getComputedStyle(rail).position,
        detailBackground: getComputedStyle(trigger).backgroundColor,
        rail: rect(rail),
        trigger: rect(trigger),
        workspace: rect(workspace),
        header: rect(header),
        welcome: rect(welcome),
        composer: rect(composer),
      };
    });
    const railBeforeHover = await readExtensionRailLayout();
    expect(railBeforeHover.position).toBe('absolute');
    expect(railBeforeHover.rail.top - railBeforeHover.header.bottom).toBeGreaterThanOrEqual(4);
    expect(railBeforeHover.rail.top - railBeforeHover.header.bottom).toBeLessThanOrEqual(6);
    expect(railBeforeHover.workspace.right - railBeforeHover.rail.right).toBeGreaterThanOrEqual(20);
    expect(railBeforeHover.workspace.right - railBeforeHover.rail.right).toBeLessThanOrEqual(24);

    await extensionDetails.hover();
    await expect.poll(async () => (await readExtensionRailLayout()).detailBackground).not.toBe(railBeforeHover.detailBackground);
    const railOnHover = await readExtensionRailLayout();
    expect(railOnHover.trigger.top).toBeGreaterThanOrEqual(railOnHover.rail.top);
    expect(railOnHover.trigger.bottom).toBeLessThanOrEqual(railOnHover.rail.bottom);
    expect(railOnHover.rail).toEqual(railBeforeHover.rail);
    expect(railOnHover.welcome).toEqual(railBeforeHover.welcome);
    expect(railOnHover.composer).toEqual(railBeforeHover.composer);
    await page.screenshot({ path: 'test-results/pi-desktop-extension-status-hover.png' });
    await page.mouse.move(1, 1);

    const sessionList = page.locator('.session-list');
    // Folders start collapsed; the active folder is expanded by toggling its
    // chevron (chevron only toggles — it never triggers a project switch or
    // runtime re-open, unlike the folder-open button).
    if (!await sessionList.isVisible().catch(() => false)) {
      const activeChevron = page.locator('.folder-group--active .folder-chevron').first();
      if (await activeChevron.count() > 0) await activeChevron.click();
    }
    const firstSessionRow = page.locator('.session-row').filter({ hasText: 'First session' });
    await expect(sessionList).toBeVisible();
    await expect(firstSessionRow).toContainText(/main.*messages.*updated (?:now|.* ago)/iu);
    await expect(firstSessionRow.locator('.session-drag-handle')).toHaveCount(0);
    const activeFolder = sessionList.locator('..');
    const [sessionListBox, folderHeaderBox, activeFolderBox, sidebarBox] = await Promise.all([
      sessionList.boundingBox(),
      activeFolder.locator(':scope > .folder-header').boundingBox(),
      activeFolder.boundingBox(),
      page.locator('.sidebar').boundingBox(),
    ]);
    expect(sessionListBox!.height).toBeGreaterThan(120);
    expect(sessionListBox!.y).toBeGreaterThanOrEqual(folderHeaderBox!.y + folderHeaderBox!.height);
    expect(sessionListBox!.y + sessionListBox!.height).toBeLessThanOrEqual(activeFolderBox!.y + activeFolderBox!.height);
    expect(activeFolderBox!.y + activeFolderBox!.height).toBeLessThanOrEqual(sidebarBox!.y + sidebarBox!.height);
    await firstSessionRow.hover();
    await expect(firstSessionRow.getByRole('button', { name: 'Create new session from latest prompt in First session' })).toBeVisible();
    await expect(firstSessionRow.getByRole('button', { name: 'Clone First session' })).toBeVisible();
    await expect(firstSessionRow.getByRole('button', { name: 'Compact First session' })).toBeVisible();
    await expect(firstSessionRow.getByRole('button', { name: 'Rename First session' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Import session/i })).toHaveCount(0);
    await expect(page.locator('.session-action-bar')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/pi-desktop-final.png' });

    const composerInput = page.getByLabel('Message Pi');
    const secondSessionRow = page.locator('.session-row').filter({ hasText: 'Second session' });
    await secondSessionRow.dragTo(page.locator('form.composer'));
    await expect(page.getByLabel('Attached session references')).toContainText('Second session');
    await page.getByRole('button', { name: 'Remove session reference: Second session' }).click();
    await expect(page.getByLabel('Attached session references')).toHaveCount(0);
    await composerInput.fill('__FATE_AGENT_FIXTURE__');
    await page.getByRole('button', { name: 'Send message' }).click();
    const subagentTool = page.getByRole('article', { name: 'subagent_start tool running' });
    await expect(subagentTool).toBeVisible();
    await expect(subagentTool.locator('.tool-meta')).toHaveText('Running');
    await expect(page.getByText(/Child session .* settled/iu)).toHaveCount(0);
    await openInspectorView(page, 'Run', 'Subagent sessions, 1 active');
    const agents = page.getByRole('region', { name: 'Agent sessions' });
    const authAgent = agents.getByRole('button', { name: 'Open Auth Reviewer (@auth-reviewer-1) child session: Running' });
    await expect(authAgent).toBeVisible();
    await expect(agents.getByRole('button', { name: 'Open Test Runner (@test-runner-1) child session: Completed' })).toBeVisible();
    await expect(agents).not.toContainText('e2e-auth-reviewer');
    await expect(page.locator('.tab-agent-count')).toHaveCount(0);
    const agentRowBox = await authAgent.boundingBox();
    expect(agentRowBox).not.toBeNull();
    await authAgent.hover();
    await expect(agents.getByRole('button', { name: 'Stop @auth-reviewer-1' })).toBeVisible();
    const hoveredAgentRowBox = await authAgent.boundingBox();
    expect(hoveredAgentRowBox).not.toBeNull();
    expect(hoveredAgentRowBox!.height).toBeCloseTo(agentRowBox!.height, 2);
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

    await composerInput.fill('__FATE_V2_AGENT_FIXTURE__');
    await page.getByRole('button', { name: 'Send message' }).click();
    const conversationPaths = page.getByRole('list', { name: 'Conversation paths' });
    // Forks only: the active branch (the main session) is not duplicated, and
    // there is no "Current path" / "Alternate path" / "Fork" label text.
    await expect(conversationPaths).toContainText('Explore the alternate implementation');
    await expect(conversationPaths).not.toContainText('Current path');
    await expect(conversationPaths).not.toContainText('Alternate path');
    await expect(conversationPaths).not.toContainText(/^Fork$/u);
    await expect(conversationPaths.locator('.session-row--path')).toHaveCount(1);
    const pathLayout = await conversationPaths.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      rowHeights: [...element.querySelectorAll<HTMLElement>('.session-row--path')].map((row) => row.getBoundingClientRect().height),
    }));
    expect(pathLayout.scrollWidth).toBeLessThanOrEqual(pathLayout.clientWidth);
    expect(pathLayout.rowHeights.every((height) => height >= 24)).toBe(true);
    const alternatePath = conversationPaths.getByRole('button', { name: /Switch to fork: Explore the alternate implementation/u });
    await alternatePath.focus();
    await expect(alternatePath).toBeFocused();
    await alternatePath.press('Enter');
    // After switching, the alternate becomes the main session; the previously
    // active branch now shows as a fork.
    await expect(conversationPaths).toContainText('Keep the verified implementation');
    await expect(conversationPaths).not.toContainText('Explore the alternate implementation');
    await expect(composerInput).toHaveValue('Continue from the alternate implementation prompt');
    await composerInput.fill('');
    const v2Team = agents.getByLabel('E2E team Agent Team e2e-agent-team');
    await expect(v2Team).toBeVisible();
    await expect(v2Team).toContainText('2/16 nodes · 1/3 active · writer leased');
    const teamToggle = v2Team.getByRole('button', { name: /^E2E team · Current/u });
    await expect(teamToggle).toHaveAttribute('aria-expanded', 'true');
    await teamToggle.click();
    await expect(teamToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(agents.getByLabel('Reviewer Agent Team node active')).toHaveCount(0);
    await teamToggle.click();
    await expect(teamToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByLabel(/Activity: Reviewer is writing/u)).toBeVisible();
    await expect(agents.getByLabel('Reviewer Agent Team node active')).toContainText('Review the Agent Teams V2 flow');
    await expect(agents.getByLabel('Verifier Agent Team node ready')).toBeVisible();
    const nestedTreeDecoration = await v2Team.evaluate((branch) => {
      const parentCard = branch.querySelector<HTMLElement>('.agent-tree-node[data-depth="1"] > .subagent-session-row');
      const nestedCard = branch.querySelector<HTMLElement>('.agent-tree-node[data-depth="2"] > .subagent-session-row');
      if (!parentCard || !nestedCard) return null;
      const decoration = (pseudo: '::before' | '::after') => {
        const style = getComputedStyle(nestedCard, pseudo);
        return {
          content: style.content,
          borderBottomWidth: style.borderBottomWidth,
          borderLeftWidth: style.borderLeftWidth,
          backgroundImage: style.backgroundImage,
        };
      };
      return {
        indentation: nestedCard.getBoundingClientRect().left - parentCard.getBoundingClientRect().left,
        before: decoration('::before'),
        after: decoration('::after'),
      };
    });
    expect(nestedTreeDecoration).not.toBeNull();
    expect(nestedTreeDecoration!.indentation).toBeGreaterThan(20);
    for (const decoration of [nestedTreeDecoration!.before, nestedTreeDecoration!.after]) {
      expect(['none', 'normal']).toContain(decoration.content);
      expect(decoration.borderBottomWidth).toBe('0px');
      expect(decoration.borderLeftWidth).toBe('0px');
      expect(decoration.backgroundImage).toBe('none');
    }
    const previewResize = agents.getByRole('separator', { name: 'Resize sub-agent chat preview' });
    await previewResize.focus();
    for (let index = 0; index < 8; index += 1) await previewResize.press('ArrowDown');
    await agents.getByLabel('Reviewer Agent Team node active').click();
    const reviewerPreview = agents.getByRole('region', { name: 'Reviewer chat preview' });
    await expect(reviewerPreview).toContainText('Review the Agent Teams V2 flow');
    await expect(reviewerPreview).toContainText('edit');
    const reviewerTranscript = reviewerPreview.locator('.subagent-transcript');
    const assertReviewerTranscriptAtBottom = async () => {
      await expect.poll(() => reviewerTranscript.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
    };
    await assertReviewerTranscriptAtBottom();
    await reviewerTranscript.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await agents.getByLabel('Verifier Agent Team node ready').click();
    await agents.getByLabel('Reviewer Agent Team node active').click();
    await assertReviewerTranscriptAtBottom();
    await reviewerPreview.getByRole('button', { name: 'Close sub-agent chat preview' }).click();
    await agents.getByLabel('Reviewer Agent Team node active').click();
    await assertReviewerTranscriptAtBottom();
    await reviewerTranscript.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    const transcriptHeightBeforeAppend = await reviewerTranscript.evaluate((element) => element.scrollHeight);
    await agents.getByRole('button', { name: 'Queue message to /root/reviewer', exact: true }).click();
    await agents.getByPlaceholder('Queue information without waking the agent…').fill('Check the integration boundary.');
    await agents.getByRole('button', { name: 'Send' }).click();
    await expect(agents.getByLabel('Reviewer Agent Team node active')).toContainText('1 unread');
    await expect.poll(() => reviewerTranscript.evaluate((element) => element.scrollHeight)).toBeGreaterThan(transcriptHeightBeforeAppend);
    await expect.poll(() => reviewerTranscript.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
    await agents.getByRole('button', { name: 'Interrupt /root/reviewer and preserve its session', exact: true }).click();
    await expect(agents.getByLabel('Reviewer Agent Team node interrupted')).toBeVisible();
    await agents.getByRole('button', { name: 'Create follow-up task for /root/reviewer', exact: true }).click();
    await agents.getByPlaceholder('Assign a new task using the retained context…').fill('Run the final verification.');
    await agents.getByRole('button', { name: 'Send' }).click();
    await expect(agents.getByRole('button', { name: 'Interrupt /root/reviewer and preserve its session', exact: true })).toBeVisible();
    await agents.getByRole('button', { name: 'Interrupt /root/reviewer and preserve its session', exact: true }).click();
    await expect(agents.getByLabel('Reviewer Agent Team node interrupted')).toBeVisible();
    await agents.getByRole('button', { name: 'Close /root/reviewer and preserve history', exact: true }).click();
    await expect(agents.getByLabel('Reviewer Agent Team node closed')).toBeVisible();
    await expect(agents.getByLabel('Verifier Agent Team node closed')).toBeVisible();
    await openInspectorView(page, 'Work', 'Changes');
    await expect(page.getByRole('tab', { name: 'Changes' })).toHaveAttribute('data-state', 'active');
    const runway = page.getByLabel('Changed files', { exact: true });
    await runway.focus();
    await runway.press('Home');
    await runway.press('End');
    await expect(page.locator('.change-row.selected')).toContainText('src/example.ts');
    await expect(page.getByLabel('Related activity', { exact: true })).toContainText('Team agent e2e-team-reviewer');
    await runway.press('o');
    await expect(page.getByRole('tab', { name: /Subagent sessions/u })).toHaveAttribute('data-state', 'active');
    const reviewerTeamRow = agents.getByLabel('Reviewer Agent Team node closed').locator('xpath=..');
    await expect(reviewerTeamRow).toHaveAttribute('tabindex', '-1');
    await expect(reviewerTeamRow).toBeFocused();
    const defaultInspectorWidth = await page.locator('.inspector').evaluate((element) => element.getBoundingClientRect().width);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 700));
    await expect.poll(() => page.locator('.inspector').evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(defaultInspectorWidth);
    await assertReviewerTranscriptAtBottom();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 720));
    await page.waitForTimeout(180);

    await composerInput.fill('@test');
    const agentMentions = page.getByRole('listbox', { name: 'Agent mentions' });
    await expect(agentMentions.getByRole('option')).toContainText('@test-runner-1');
    await agentMentions.getByRole('option').click();
    await expect(composerInput).toHaveValue('@test-runner-1 ');
    await composerInput.fill('');
    await openInspectorView(page, 'Work', 'Changes');

    await composerInput.blur();
    const idleComposerBorder = await page.locator('form.composer').evaluate((element) => getComputedStyle(element).borderTopColor);
    await composerInput.focus();
    const focusedComposerBorder = await page.locator('form.composer').evaluate((element) => getComputedStyle(element).borderTopColor);
    expect(focusedComposerBorder).toBe(idleComposerBorder);
    await composerInput.fill('/');
    const slashPicker = page.getByRole('listbox', { name: 'Skills and commands' });
    await expect(slashPicker).toBeVisible();
    await expect(slashPicker.getByRole('option')).toHaveCount(4);
    await expect(slashPicker.getByRole('option', { name: /^goalmax\b/i })).toBeVisible();
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

    await composerInput.fill('/goalmax Build and verify the persistent goal flow');
    await composerInput.press('Enter');
    const goalRail = page.getByRole('region', { name: 'Current GoalMax goal' });
    await expect(goalRail).toContainText('Build and verify the persistent goal flow');
    await goalRail.getByRole('button', { name: 'Open Goal Flight Deck' }).click();
    await expect(page.getByRole('tab', { name: /Goal/ })).toHaveAttribute('data-state', 'active');
    await expect(page.getByRole('region', { name: 'Goal Flight Deck' })).toContainText('Build and verify the persistent goal flow');
    const goalLayout = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>('.goalmax-rail')!;
      const actions = document.querySelector<HTMLElement>('.goalmax-rail-actions')!;
      const deck = document.querySelector<HTMLElement>('.goalmax-flight-deck')!;
      const header = document.querySelector<HTMLElement>('.goalmax-deck-header')!;
      const railBounds = rail.getBoundingClientRect();
      const actionBounds = actions.getBoundingClientRect();
      return {
        railOverflow: rail.scrollWidth - rail.clientWidth,
        deckOverflow: deck.scrollWidth - deck.clientWidth,
        headerOverflow: header.scrollWidth - header.clientWidth,
        actionsInsideRail: actionBounds.left >= railBounds.left && actionBounds.right <= railBounds.right,
      };
    });
    expect(goalLayout).toEqual({ railOverflow: 0, deckOverflow: 0, headerOverflow: 0, actionsInsideRail: true });
    await page.screenshot({ path: 'test-results/pi-desktop-goal-flight-deck.png' });
    await goalRail.getByRole('button', { name: 'Pause goal' }).click();
    await expect(goalRail.getByRole('button', { name: 'Resume goal' })).toBeVisible();
    await goalRail.getByRole('button', { name: 'Resume goal' }).click();
    const goalDeck = page.getByRole('region', { name: 'Goal Flight Deck' });
    await goalDeck.getByRole('tab', { name: 'Timeline' }).click();
    const goalTimelineRows = goalDeck.locator('.goalmax-timeline-row');
    await expect(goalTimelineRows).toHaveCount(3);
    await expect(goalTimelineRows.nth(0)).toHaveAttribute('data-first', 'true');
    await expect(goalTimelineRows.nth(2)).toHaveAttribute('data-last', 'true');
    expect(await goalTimelineRows.locator('strong').allTextContents()).toEqual(['Goal created.', 'Goal pause.', 'Goal resume.']);
    const goalTimelineRail = await goalTimelineRows.nth(1).evaluate((row) => {
      const line = getComputedStyle(row, '::before');
      const node = getComputedStyle(row.querySelector<HTMLElement>('.goalmax-timeline-rail > i')!);
      return { lineWidth: line.width, nodeShape: node.borderRadius, nodeBorder: node.borderTopWidth };
    });
    expect(goalTimelineRail).toEqual({ lineWidth: '1px', nodeShape: '50%', nodeBorder: '1px' });
    await goalRail.getByRole('button', { name: 'Edit goal' }).click();
    const goalEditor = page.getByRole('dialog', { name: 'Edit goal' });
    await goalEditor.getByLabel('Token limit').fill('50000');
    await goalEditor.getByRole('button', { name: 'Save' }).click();
    await expect(goalEditor).toHaveCount(0);
    await openInspectorView(page, 'System', /Context/u);
    await expect(page.getByText('Goal budget')).toBeVisible();
    await expect(page.getByText(/0 \/ 50k/u)).toBeVisible();
    await goalRail.getByRole('button', { name: 'Clear goal' }).click();
    const clearGoal = page.getByRole('dialog', { name: 'Clear this goal?' });
    await clearGoal.getByRole('button', { name: 'Cancel & clear' }).click();
    await expect(goalRail).toHaveCount(0);

    await composerInput.fill('/parallax status');
    await composerInput.press('Enter');
    await expect(page.locator('.chat-message--system')).toContainText('Parallax is active.');

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 700));
    const compactToolsTrigger = page.getByRole('button', { name: 'Open composer tools' });
    await expect(compactToolsTrigger).toBeVisible();
    await expect(activityPulse).toBeVisible();
    const compactHeader = await page.locator('.workspace-header-drag').evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(compactHeader.scroll).toBeLessThanOrEqual(compactHeader.client);
    expect(await page.locator('.activity-pulse-chip').evaluateAll((chips) => chips.every((chip) => getComputedStyle(chip).display === 'none'))).toBe(true);
    const compactOverflow = await page.locator('form.composer').evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(compactOverflow.scroll).toBeLessThanOrEqual(compactOverflow.client);
    await compactToolsTrigger.click();
    const compactTools = page.getByRole('dialog', { name: 'Composer tools' });
    await expect(compactTools).toBeVisible();
    await expect(compactTools.getByRole('button', { name: 'Tag project file or folder' })).toBeVisible();
    await assertInsideViewport(compactTools);
    await page.waitForTimeout(180);
    await page.screenshot({ path: 'test-results/pi-desktop-compact-flight-deck.png' });
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
    await page.getByRole('option', { name: /Pi · E2E Theme/ }).click();
    await expect(themeSelect).toContainText('Pi · E2E Theme');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('pi-e2e-theme-0123456789ab');
    await page.screenshot({ path: 'test-results/pi-desktop-settings-pi-theme.png' });
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
    await expect(musicPlayer.locator('p.music-status')).toHaveText('yt-dlp is unavailable in the E2E harness.');
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
    const loopOff = page.getByRole('button', { name: 'Loop mode: Off. Activate to loop queue' });
    await expect(loopOff).toHaveAttribute('aria-pressed', 'false');
    await loopOff.click();
    const loopQueue = page.getByRole('button', { name: 'Loop mode: Queue. Activate to loop current track' });
    await expect(loopQueue).toHaveAttribute('aria-pressed', 'true');
    await loopQueue.click();
    await page.getByRole('button', { name: 'Loop mode: Current track. Activate to turn looping off' }).click();
    await expect(loopOff).toHaveAttribute('aria-pressed', 'false');
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
    await queuedMessages.getByRole('switch', { name: 'Follow-up queued message: Use the smaller API' }).click();
    await expect(queuedMessages.getByRole('switch', { name: 'Steer queued message: Use the smaller API' })).toBeEnabled();
    await queuedMessages.getByRole('button', { name: 'Edit queued message: Use the smaller API' }).click();
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
    await expect.poll(() => page.locator('.conversation-virtuoso').evaluate((element) => {
      const scroller = element as HTMLElement;
      const composer = document.querySelector<HTMLElement>('.composer-wrap');
      const lastRow = [...document.querySelectorAll<HTMLElement>('.timeline-row')].at(-1);
      if (!composer || !lastRow) return Number.NEGATIVE_INFINITY;
      const overlap = lastRow.getBoundingClientRect().bottom - composer.getBoundingClientRect().top;
      if (overlap <= 0 && scroller.scrollTop > 0) {
        scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.ceil(16 - overlap));
        scroller.dispatchEvent(new Event('scroll'));
      }
      return overlap;
    }), { timeout: 5_000 }).toBeGreaterThan(0);
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
    await expect(page.getByRole('article', { name: 'read tool succeeded' }).getByText('export const answer = 42;')).toBeVisible();
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
    await openInspectorView(page, 'System', /Context/u);
    await expect(page.getByRole('img', { name: 'Stacked token traffic for the 24 most recent responses on the active branch' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Session token summary' })).toContainText('provider-reported input');
    await expect(page.getByText('included in output')).toBeVisible();
    const contextLayout = await page.locator('.context-dashboard').evaluate((panel) => ({
      scrollWidth: panel.scrollWidth,
      clientWidth: panel.clientWidth,
      chartWidth: panel.querySelector<SVGElement>('.token-chart svg')?.getBoundingClientRect().width ?? 0,
    }));
    expect(contextLayout.scrollWidth).toBeLessThanOrEqual(contextLayout.clientWidth);
    expect(contextLayout.chartWidth).toBeGreaterThan(200);
    await page.screenshot({ path: 'test-results/pi-desktop-context-wrap.png' });

    await openInspectorView(page, 'Work', /Changes/u);
    await expect(page.getByRole('button', { name: 'Refresh Git status' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Switch to branch history' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Fetch all remotes|Pull current branch|Push current branch/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '2 changed files. Open combined diff' })).toHaveText('2');
    await expect(page.getByRole('button', { name: '1 lines added. Open combined diff' })).toHaveText('+1');
    await expect(page.getByRole('button', { name: '1 lines removed. Open combined diff' })).toHaveText('−1');
    const changedFile = page.locator('button.change-row').filter({ hasText: 'src/example.ts' });
    await expect(changedFile).toBeVisible();
    await expect(changedFile.locator('.change-counts')).toHaveCount(0);
    await expectHoverTooltip(page, changedFile.locator('.change-path'), 'src/example.ts');
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

    // Switching worktrees reopens Pi at another folder; make sure the active
    // folder is expanded again before switching sessions.
    if (!await page.locator('.session-list').isVisible().catch(() => false)) {
      const activeChevron = page.locator('.folder-group--active .folder-chevron').first();
      if (await activeChevron.count() > 0) await activeChevron.click();
    }
    await expect(page.locator('.session-list')).toBeVisible();

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

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await page.getByRole('button', { name: 'Collapse inspector' }).click();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(600, 620));
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getSize())).toEqual([600, 620]);
    const narrowLayout = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>('.app-shell')!;
      const rail = document.querySelector<HTMLElement>('.sidebar .nav-list')!;
      const settingsTrigger = rail.querySelector<HTMLElement>('.sidebar-settings-tooltip')!;
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        shellOverflow: shell.scrollWidth - shell.clientWidth,
        settingsTriggerWidth: settingsTrigger.getBoundingClientRect().width,
        railWidth: rail.getBoundingClientRect().width,
      };
    });
    expect(narrowLayout.documentOverflow).toBeLessThanOrEqual(0);
    expect(narrowLayout.shellOverflow).toBeLessThanOrEqual(0);
    expect(Math.abs(narrowLayout.settingsTriggerWidth - narrowLayout.railWidth)).toBeLessThanOrEqual(1);

    const [, closeError] = await Promise.all([
      page.waitForEvent('close'),
      page.getByRole('button', { name: 'Close window' }).click().then(() => null, (error: unknown) => error),
    ]);
    if (closeError instanceof Error && !/target page, context or browser has been closed/iu.test(closeError.message)) throw closeError;
  } finally {
    await application.close();
    await rm(fixture.worktree, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
