import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

for (const mode of ['normal', 'performance', 'holy']) {
  test(`${mode} preserves streamed output, prompt following, and virtual Home/End navigation`, async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'fate-mode-project-'));
    const userData = await mkdtemp(path.join(tmpdir(), 'fate-mode-profile-'));
    const application = await electron.launch({
      args: [path.resolve('.test-dist/main/index.js')],
      env: {
        ...process.env,
        PI_DESKTOP_E2E_PROJECT: project,
        PI_DESKTOP_E2E_USER_DATA: userData,
        FATE_GUI_DATA_DIR: path.join(userData, 'fateGUI'),
        PI_OFFLINE: '1',
        FATE_GUI_PROFILE_VISUAL_MODE: mode,
      },
    });
    try {
      const page = await application.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.getByRole('button', { name: /Open project/u }).first().click();
      await expect.poll(() => page.evaluate(() => ({
        performance: document.documentElement.dataset.performanceMode,
        holy: document.documentElement.dataset.holyShitMode,
      }))).toEqual({ performance: String(mode !== 'normal'), holy: String(mode === 'holy') });
      await page.getByLabel('Message Pi').fill('__FATE_LIVE_PROFILE__:600:1200');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const finalOutput = page.getByText('FATE_PROFILE_COMPLETE_1', { exact: true });
      await expect(finalOutput).toBeVisible({ timeout: 30_000 });
      await page.getByLabel('Message Pi').fill('Next draft');
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
      await page.getByLabel('Message Pi').fill('');
      await expect(page.locator('.conversation')).toHaveAttribute('data-entry-count', '603');
      expect(await page.locator('.timeline-row').count()).toBeLessThan(100);

      const scrollbar = page.getByRole('scrollbar', { name: 'Conversation scroll position' });
      await scrollbar.press('Home');
      await expect(page.getByText('Profile history row 0: completed output retained for virtualization and subscription pressure.', { exact: true })).toBeVisible();
      await scrollbar.press('End');
      await expect(finalOutput).toBeVisible();

      await page.getByLabel('Message Pi').fill('__FATE_LIVE_PROFILE__:0:6000');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.locator('.conversation')).toHaveAttribute('data-visible-entry-count', '606');
      await scrollbar.press('Home');
      await expect(page.getByText('Profile history row 0: completed output retained for virtualization and subscription pressure.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
      await expect.poll(() => page.locator('.conversation-virtuoso').evaluate((element) => element.scrollTop)).toBeLessThan(1);
      await scrollbar.press('End');
      await expect(page.getByText('FATE_PROFILE_COMPLETE_2', { exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await application.close();
      await rm(project, { recursive: true, force: true });
      await rm(userData, { recursive: true, force: true });
    }
  });
}
