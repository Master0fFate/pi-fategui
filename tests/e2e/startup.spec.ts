import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('real application restarts with the Resources inspector saved before discovery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fate-startup-e2e-'));
  const launch = () => electron.launch({
    args: [`--user-data-dir=${path.join(root, 'chromium')}`, path.resolve('.'), '--new-instance'],
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: '',
      FATE_GUI_DATA_DIR: path.join(root, 'data'),
      PI_CODING_AGENT_DIR: path.join(root, 'agent'),
      PI_OFFLINE: '1',
    },
  });
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    application = await launch();
    const page = await application.firstWindow();
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.evaluate(() => {
      localStorage.setItem('pi-desktop-ui-v1', JSON.stringify({
        version: 1,
        state: {
          inspectorCollapsed: false,
          inspectorTab: 'resources',
          inspectorLastViews: { work: 'files', run: 'sessions', system: 'resources' },
        },
      }));
    });
    await application.close();
    application = await launch();
    const restored = await application.firstWindow();
    const errors: string[] = [];
    restored.on('pageerror', (error) => errors.push(error.message));
    await expect(restored.getByText('No Pi resources loaded')).toBeVisible();
    // Reload exercises the same saved layout with error capture already attached.
    await restored.reload();
    await expect(restored.getByText('No Pi resources loaded')).toBeVisible();
    await expect(restored.locator('[data-bridge-status="ready"]')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});
