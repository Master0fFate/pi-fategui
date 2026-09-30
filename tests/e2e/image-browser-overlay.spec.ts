import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const previewTitle = 'Image overlay fixture';

async function nativeBrowserView(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, WebContentsView }, title) => {
    const owner = BrowserWindow.getAllWindows()[0];
    for (const child of owner?.contentView.children ?? []) {
      if (child instanceof WebContentsView && child.webContents.getTitle() === title) {
        return { id: child.webContents.id, visible: child.getVisible(), bounds: child.getBounds() };
      }
    }
    return null;
  }, previewTitle);
}

test('cinematic images hide the native browser without losing access or restoring through another modal', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-image-browser-overlay-'));
  const project = path.join(directory, 'project');
  const userData = path.join(directory, 'profile');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src', 'example.ts'), 'export const answer = 42;\n');
  const previewPath = path.join(project, 'index.html');
  await writeFile(previewPath, `<!doctype html><title>${previewTitle}</title><h1>${previewTitle}</h1><button>Page remains available</button>`);

  let application: ElectronApplication | undefined;
  try {
    const app = await electron.launch({
      args: [path.resolve('.test-dist/main/index.js')],
      env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: path.join(userData, 'fateGUI'), PI_OFFLINE: '1' },
    });
    application = app;
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
    await page.getByRole('button', { name: /Open project/u }).first().click();
    await page.getByLabel('Message Pi').fill('Inspect this project');
    await page.getByRole('button', { name: 'Send message' }).click();
    const image = page.getByRole('button', { name: 'Expand image: Project preview', exact: true });
    await expect(image).toBeVisible();

    await page.getByRole('button', { name: 'Open browser', exact: true }).click();
    const browser = page.getByRole('region', { name: 'Built-in browser', exact: true });
    const address = browser.getByRole('textbox', { name: 'Browser address' });
    await address.fill(previewPath);
    await address.press('Enter');
    await expect(browser.getByRole('tab', { name: previewTitle, exact: true })).toBeVisible();
    await expect.poll(async () => {
      const view = await nativeBrowserView(app);
      return Boolean(view?.visible && view.bounds.width > 0 && view.bounds.height > 0);
    }).toBe(true);
    const nativeView = (await nativeBrowserView(app))!;
    const initial = await page.evaluate(() => window.piDesktop.getBrowserState());
    const preservedAccess = {
      activeTabId: initial.activeTabId, mode: initial.mode, controlLevel: initial.controlLevel,
      sessionFullAccess: initial.sessionFullAccess, grants: initial.grants,
    };
    const expectBlocked = async (blocked: boolean) => {
      // Check the actual Electron child view, not just the renderer's status text.
      await expect.poll(() => nativeBrowserView(app)).toMatchObject({ id: nativeView.id, visible: !blocked });
      await expect.poll(() => page.evaluate(() => window.piDesktop.getBrowserState())).toMatchObject({
        ...preservedAccess, visible: !blocked, viewBlocked: blocked,
      });
    };

    for (const dismissal of ['escape', 'backdrop', 'close'] as const) {
      await image.click();
      const viewer = page.getByRole('dialog', { name: 'Project preview', exact: true });
      await expect(viewer).toHaveAttribute('aria-modal', 'true');
      await expect(viewer.getByRole('button', { name: 'Close image viewer' })).toBeFocused();
      await expectBlocked(true);
      // Native rendering is hidden, but the production agent/CDP path still works.
      const snapshot = await page.evaluate(() => window.piDesktop.snapshotBrowser({ mode: 'full' }));
      expect(snapshot.serialized).toContain(previewTitle);

      if (dismissal === 'escape') await page.keyboard.press('Escape');
      else if (dismissal === 'backdrop') await page.locator('.cinematic-image-overlay').click({ position: { x: 8, y: 8 } });
      else await viewer.getByRole('button', { name: 'Close image viewer' }).click();
      await expect(viewer).toBeHidden();
      await expectBlocked(false);
      await expect(browser).toBeVisible();
    }

    await image.click();
    await expectBlocked(true);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const palette = page.getByRole('dialog', { name: 'Command center', exact: true });
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    const viewer = page.getByRole('dialog', { name: 'Project preview', exact: true });
    await expect(viewer).toBeVisible();
    await expectBlocked(true);
    await viewer.getByRole('button', { name: 'Close image viewer' }).click();
    await expect(viewer).toBeHidden();
    await expectBlocked(false);

    const draft = page.getByLabel('Message Pi');
    await draft.fill('Keep this draft and attachment');
    await page.locator('.composer input[type="file"]').setInputFiles({
      name: 'attachment.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    });
    await page.getByRole('button', { name: 'Expand image: attachment.png', exact: true }).click();
    const attachmentViewer = page.getByRole('dialog', { name: 'attachment.png', exact: true });
    await expect(attachmentViewer).toHaveAttribute('aria-modal', 'true');
    await expectBlocked(true);
    await page.keyboard.press('Escape');
    await expect(attachmentViewer).toBeHidden();
    await expectBlocked(false);
    await expect(draft).toHaveValue('Keep this draft and attachment');
    await expect(page.getByRole('button', { name: 'Remove attachment.png' })).toBeVisible();

    await browser.getByRole('button', { name: 'Reload page' }).click();
    await expect(browser.getByRole('tab', { name: previewTitle, exact: true })).toBeVisible();
    await expectBlocked(false);
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
