import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('local image backgrounds are really dithered, palette-independent, persistent, and removable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-background-e2e-'));
  const project = path.join(directory, 'project');
  const profile = path.join(directory, 'profile');
  await mkdir(project);
  const launch = () => electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: {
    ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: profile, FATE_GUI_DATA_DIR: path.join(profile, 'fateGUI'), PI_OFFLINE: '1',
  } });
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    application = await launch();
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /Open project/ }).first().click();
    const source = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 640;
      const context = canvas.getContext('2d')!;
      const gradient = context.createLinearGradient(0, 0, 1280, 0);
      gradient.addColorStop(0, '#000000');
      gradient.addColorStop(1, '#ffffff');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 1280, 640);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: /Skins/ }).click();
    await expect(settings.getByRole('button', { name: 'Choose image', exact: true })).toBeEnabled();
    await settings.getByLabel('Background image file').setInputFiles({ name: 'test-lightmap.png', mimeType: 'image/png', buffer: Buffer.from(source, 'base64') });
    await expect(settings.getByText('test-lightmap.png', { exact: true })).toBeVisible();
    await expect(page.locator('.workspace-backdrop')).toHaveCSS('opacity', '0.1');
    await expect(page.locator('.workspace-backdrop')).toHaveCSS('pointer-events', 'none');
    const cachedMask = await page.locator('.workspace-backdrop').evaluate((element) => (element as HTMLElement).style.maskImage);
    const processed = await page.locator('.workspace-backdrop').evaluate(async (element) => {
      const url = (element as HTMLElement).style.maskImage.match(/url\(["']?(.*?)["']?\)/)![1]!;
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const values = new Set<number>();
      for (let index = 3; index < pixels.length; index += 4) values.add(pixels[index]!);
      return { width: canvas.width, height: canvas.height, alpha: [...values].sort() };
    });
    expect(processed).toEqual({ width: 960, height: 480, alpha: [0, 255] });
    await settings.getByRole('combobox', { name: 'Background strength' }).click();
    await page.getByRole('option', { name: /Visible/ }).click();
    await expect(page.locator('.workspace-backdrop')).toHaveCSS('opacity', '0.16');
    await settings.getByRole('combobox', { name: 'Interface skin' }).click();
    await page.getByRole('option', { name: /^Angelcore/ }).click();
    await settings.getByRole('combobox', { name: 'Interface theme' }).click();
    await page.getByRole('option', { name: /Daylight/ }).click();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.workspace-backdrop')!).backgroundColor)).toBe('rgb(23, 27, 38)');
    expect(await page.locator('.workspace-backdrop').evaluate((element) => (element as HTMLElement).style.maskImage)).toBe(cachedMask);
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await expect(settings.getByRole('status')).toContainText('Settings saved');
    await application.close();
    application = await launch();
    const restored = await application.firstWindow();
    await expect(restored.locator('.workspace-backdrop')).toHaveCSS('opacity', '0.16');
    await restored.getByRole('button', { name: 'Settings', exact: true }).click();
    const restoredSettings = restored.getByRole('dialog', { name: 'Settings', exact: true });
    await restoredSettings.getByRole('tab', { name: /Skins/ }).click();
    await expect(restoredSettings.getByText('test-lightmap.png', { exact: true })).toBeVisible();
    await restoredSettings.getByLabel('Background image file').setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await expect(restoredSettings.getByRole('alert')).toContainText('PNG, JPEG, or WebP');
    await expect(restored.locator('.workspace-backdrop')).toBeAttached();
    await restoredSettings.getByRole('button', { name: 'Remove background', exact: true }).click();
    await expect(restored.locator('.workspace-backdrop')).toHaveCount(0);
    await application.close();
    application = await launch();
    const cleared = await application.firstWindow();
    await cleared.getByRole('button', { name: 'Settings', exact: true }).click();
    await cleared.getByRole('tab', { name: /Skins/ }).click();
    await expect(cleared.getByRole('button', { name: 'Choose image', exact: true })).toBeEnabled();
    await expect(cleared.getByText('No image selected', { exact: true })).toBeVisible();
    await expect(cleared.locator('.workspace-backdrop')).toHaveCount(0);
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
