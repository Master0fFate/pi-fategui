import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';
import { builtInThemes, themeDefinitionSchema } from '../../src/shared/themes';

const title = 'A deliberately long website title that must truncate inside a Material browser tab';

async function chromeGeometry(page: Page) {
  await expect.poll(() => page.locator('.browser-workspace').evaluate((workspace) => {
    const style = (selector: string) => getComputedStyle(workspace.querySelector(selector)!);
    const active = style('.browser-tab--active');
    const inactive = style('.browser-tab:not(.browser-tab--active)');
    const root = getComputedStyle(document.documentElement);
    const color = (token: string) => {
      // Canvas resolves the production token without injecting any DOM styles.
      const context = document.createElement('canvas').getContext('2d')!;
      context.fillStyle = root.getPropertyValue(token).trim();
      return context.fillStyle;
    };
    const normalized = (value: string) => {
      const context = document.createElement('canvas').getContext('2d')!;
      context.fillStyle = value; return context.fillStyle;
    };
    const toolbar = workspace.querySelector<HTMLElement>('.browser-toolbar')!;
    const buttons = [...workspace.querySelectorAll<HTMLElement>('.browser-toolbar button, .browser-tab--active .browser-tab-close, .browser-new-tab')].filter((button) => button.getBoundingClientRect().width > 0);
    const longTitle = [...workspace.querySelectorAll<HTMLElement>('.browser-tab > [role="tab"] > span')].find((span) => span.textContent!.length > 50)!;
    return {
      selected: normalized(active.backgroundColor) === color('--theme-accent') && normalized(active.color) === color('--theme-on-accent'),
      inactive: normalized(inactive.backgroundColor) === color('--theme-raised'),
      distinct: active.backgroundColor !== inactive.backgroundColor,
      capsule: active.borderRadius === '18px' && active.boxShadow === 'none',
      address: style('.browser-address').borderRadius === '24px',
      toolbarFits: toolbar.scrollWidth <= toolbar.clientWidth,
      centered: buttons.every((button) => {
        const box = button.getBoundingClientRect();
        const icon = button.querySelector('svg')!.getBoundingClientRect();
        return box.width === box.height && Math.abs(icon.x + icon.width / 2 - box.x - box.width / 2) < 0.5
          && Math.abs(icon.y + icon.height / 2 - box.y - box.height / 2) < 0.5;
      }),
      titleTruncates: longTitle.scrollWidth > longTitle.clientWidth && getComputedStyle(longTitle).textOverflow === 'ellipsis' && getComputedStyle(longTitle).whiteSpace === 'nowrap',
    };
  })).toEqual({ selected: true, inactive: true, distinct: true, capsule: true, address: true, toolbarFits: true, centered: true, titleTruncates: true });
}

test('M3 browser capsules preserve real tabs, navigation and website styling in both densities and palettes', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-m3-browser-'));
  const project = path.join(directory, 'project');
  const userData = path.join(directory, 'profile');
  const dataRoot = path.join(userData, 'fateGUI');
  await mkdir(project); await mkdir(dataRoot, { recursive: true });
  const copper = themeDefinitionSchema.parse({ ...builtInThemes.find((theme) => theme.id === 'midnight')!, id: 'm3-browser-copper', name: 'M3 browser Copper', colors: { ...builtInThemes.find((theme) => theme.id === 'midnight')!.colors, accent: '#edb58f', onAccent: '#342014', raised: '#382823' } });
  await writeFile(path.join(dataRoot, 'themes.json'), JSON.stringify({ themes: [copper] }));
  const firstPage = path.join(project, 'page.html');
  const secondPage = path.join(project, 'second.html');
  await writeFile(firstPage, `<!doctype html><title>${title}</title><body style="background:rgb(245,232,200);font-family:Georgia,serif"><h1>Website styles stay independent</h1><p>This is real local browser content, not application chrome.</p></body>`);
  await writeFile(secondPage, '<!doctype html><title>Second local page</title><body>Second page</body>');
  await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify(appSettingsSchema.parse({ appearance: 'dark', defaultModel: null, thinkingLevel: 'medium', confirmRiskyCommands: true, terminalShell: null, reduceMotion: false, skinId: 'm3-expressive', themeId: 'm3-expressive' })));
  const pages = new Map([['/page.html', await readFile(firstPage)], ['/second.html', await readFile(secondPage)]]);
  const server = createServer((request, response) => {
    const content = pages.get(request.url ?? '');
    if (!content) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'text/html'); response.end(content);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('Browser fixture did not bind');
  const baseUrl = `http://127.0.0.1:${bound.port}`;
  const app = await electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: dataRoot, PI_OFFLINE: '1' } });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
    await page.getByRole('button', { name: /Open project/u }).first().click();
    await page.getByRole('button', { name: 'Open browser', exact: true }).click();
    const browser = page.getByRole('region', { name: 'Built-in browser', exact: true });
    const address = browser.getByRole('textbox', { name: 'Browser address' });
    await address.fill(`${baseUrl}/page.html`); await address.press('Enter');
    await expect(browser.getByRole('tab', { name: title, exact: true })).toBeVisible();
    await browser.getByRole('button', { name: 'New browser tab' }).click();
    await expect(browser.getByRole('tab')).toHaveCount(2);
    await browser.getByRole('tab', { name: title, exact: true }).click();
    await address.fill(`${baseUrl}/second.html`); await address.press('Enter');
    await expect(browser.getByRole('tab', { name: 'Second local page', exact: true })).toBeVisible();
    await browser.getByRole('button', { name: 'Go back' }).click();
    await expect(browser.getByRole('tab', { name: title, exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('separator', { name: 'Resize chat and browser' }).focus();
    for (let index = 0; index < 5; index += 1) await page.keyboard.press('ArrowLeft');
    await browser.getByRole('button', { name: 'Go forward' }).click();
    await expect(browser.getByRole('tab', { name: 'Second local page', exact: true })).toBeVisible();
    await browser.getByRole('button', { name: 'Go back' }).click();
    await expect(browser.getByRole('tab', { name: title, exact: true })).toHaveAttribute('aria-selected', 'true');
    await browser.getByRole('button', { name: 'Reload page' }).click();
    await expect(browser.getByRole('button', { name: 'Reload page' })).toBeEnabled();
    await page.getByRole('separator', { name: 'Resize chat and browser' }).focus();
    for (let index = 0; index < 5; index += 1) await page.keyboard.press('ArrowRight');
    for (const compact of [false, true]) {
      if (compact) {
        await page.getByRole('separator', { name: 'Resize chat and browser' }).focus();
        for (let index = 0; index < 12; index += 1) await page.keyboard.press('ArrowRight');
      }
      for (const palette of ['M3 Expressive', 'Daylight', copper.name]) {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
        await settings.getByRole('tab', { name: /Skins/u }).click();
        await settings.getByRole('combobox', { name: 'Interface theme' }).click();
        await page.getByRole('option', { name: new RegExp(`^${palette}`, 'u') }).press('Enter');
        await settings.getByRole('tab', { name: /Compaction/u }).click();
        await settings.getByRole('checkbox', { name: /^Compact mode/u }).setChecked(compact);
        await settings.getByRole('button', { name: 'Save changes' }).click();
        await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-busy', 'false');
        await settings.getByRole('button', { name: 'Close settings' }).click();
        await chromeGeometry(page);
        await expect.poll(() => app.evaluate(async ({ webContents }, expectedTitle) => {
          const content = webContents.getAllWebContents().find((candidate) => candidate.getTitle() === expectedTitle);
          return content ? content.executeJavaScript('({background:getComputedStyle(document.body).backgroundColor,font:getComputedStyle(document.body).fontFamily})') : null;
        }, title)).toEqual({ background: 'rgb(245, 232, 200)', font: 'Georgia, serif' });
        await page.mouse.move(300, 100);
        const name = `browser-m3-${palette === 'Daylight' ? 'light' : palette === copper.name ? 'custom' : 'dark'}${compact ? '-compact' : ''}`;
        const capture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString('base64'));
        await writeFile(`screenshots/m3-expressive/${name}.png`, Buffer.from(capture, 'base64'));
        const strip = await page.locator('.browser-tab-strip').boundingBox();
        const toolbar = await page.locator('.browser-toolbar').boundingBox();
        await page.screenshot({ path: `screenshots/m3-expressive/${name}-chrome.png`, animations: 'disabled', clip: { x: strip!.x, y: strip!.y, width: strip!.width, height: toolbar!.y + toolbar!.height - strip!.y } });
      }
    }
    const websiteCapture = await app.evaluate(async ({ webContents }, expectedTitle) => (await webContents.getAllWebContents().find((content) => content.getTitle() === expectedTitle)!.capturePage()).toPNG().toString('base64'), title);
    await writeFile('screenshots/m3-expressive/browser-website-unchanged.png', Buffer.from(websiteCapture, 'base64'));
    const viewport = await page.locator('.browser-viewport-reservation').boundingBox();
    await expect.poll(() => app.evaluate(({ BrowserWindow, WebContentsView }, expectedTitle) => {
      const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find((child) => child instanceof WebContentsView && child.webContents.getTitle() === expectedTitle);
      return view?.getBounds();
    }, title)).toEqual({ x: Math.round(viewport!.x), y: Math.round(viewport!.y), width: Math.round(viewport!.width), height: Math.round(viewport!.height) });
    await browser.getByRole('button', { name: 'Annotate', exact: true }).click();
    await expect(browser.getByRole('button', { name: 'Annotate', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await browser.getByRole('button', { name: 'Annotate', exact: true }).click();
    await expect(browser.getByRole('button', { name: 'Annotate', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await browser.getByRole('button', { name: 'Toggle device toolbar' }).click();
    await expect(page.locator('.browser-device-toolbar')).toBeVisible();
    await browser.getByRole('button', { name: 'Toggle device toolbar' }).click();
    await expect(page.locator('.browser-device-toolbar')).toBeHidden();
    for (let index = 0; index < 4; index += 1) await browser.getByRole('button', { name: 'New browser tab' }).click();
    await expect(browser.getByRole('tab')).toHaveCount(6);
    await expect.poll(() => page.locator('.browser-tab-strip').evaluate((strip) => strip.scrollWidth > strip.clientWidth)).toBe(true);
    await browser.getByRole('tab', { name: title, exact: true }).click();
    await expect(browser.getByRole('tab', { name: title, exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.locator('.browser-tab--active .browser-tab-close').click();
    await expect(browser.getByRole('tab')).toHaveCount(5);
    await browser.getByRole('button', { name: 'Close browser', exact: true }).click();
    await expect(browser).toBeHidden();
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
