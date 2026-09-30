import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema } from '../../src/shared/contracts/ipc';

for (const skin of ['default', 'dreamcore', 'm3-expressive'] as const) {
  test(`${skin} Run navigation survives an absent network scope and preserves its selected view`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fate-inspector-navigation-'));
    const project = path.join(directory, 'project');
    const profile = path.join(directory, 'profile');
    const data = path.join(profile, 'fateGUI');
    await mkdir(project);
    await mkdir(data, { recursive: true });
    await writeFile(path.join(project, 'README.md'), '# Inspector navigation fixture\n');
    await writeFile(path.join(data, 'settings.json'), JSON.stringify(appSettingsSchema.parse({
      appearance: 'dark', defaultModel: 'test/deterministic', thinkingLevel: 'medium',
      confirmRiskyCommands: true, terminalShell: null, reduceMotion: true, skinId: skin, themeId: 'midnight',
    })));
    const application = await electron.launch({
      args: [path.resolve('.test-dist/main/index.js')],
      env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: profile,
        FATE_GUI_DATA_DIR: data, PI_OFFLINE: '1' },
    });
    try {
      const page = await application.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.getByRole('button', { name: /Open project/u }).first().click();
      await expect(page.getByLabel('Message Pi')).toBeVisible();
      expect((await page.evaluate(() => window.piDesktop.getConnectionState())).kind).toBe('local');
      const inspector = page.getByRole('complementary', { name: 'Project inspector', exact: true });
      const destinations = inspector.getByRole('navigation', { name: 'Inspector destinations', exact: true });
      const run = destinations.getByRole('button', { name: /^Run(?:,|$)/u });
      const work = destinations.getByRole('button', { name: 'Work', exact: true });
      await expect(work).toHaveAttribute('aria-current', 'page');
      await expect(inspector.getByRole('tablist', { name: 'Work views', exact: true })).toBeVisible();

      // This ordinary click mounts the default Goal view. With no network
      // navigation/scope, undefined === undefined must not dereference null
      // and remove the entire inspector before a secondary tab can be clicked.
      await run.click();
      await expect(run).toHaveAttribute('aria-current', 'page');
      const views = inspector.getByRole('tablist', { name: 'Run views', exact: true });
      await expect(views).toBeVisible();
      const goal = views.getByRole('tab', { name: 'Goal', exact: true });
      const agents = views.getByRole('tab', { name: /^Subagent sessions(?:,|$)/u });
      const monitor = views.getByRole('tab', { name: 'Monitor', exact: true });
      await expect(goal).toHaveAttribute('data-state', 'active');
      expect(errors).toEqual([]);
      await agents.click();
      await expect(agents).toHaveAttribute('data-state', 'active');
      await expect(inspector.getByRole('region', { name: 'Agent sessions', exact: true })).toBeVisible();
      await monitor.click();
      await expect(monitor).toHaveAttribute('data-state', 'active');
      await expect(inspector.getByRole('region', { name: 'Monitoring dashboard', exact: true })).toBeVisible();
      await work.click();
      await expect(work).toHaveAttribute('aria-current', 'page');
      await expect(inspector.getByRole('tablist', { name: 'Work views', exact: true })).toBeVisible();
      await run.click();
      await expect(run).toHaveAttribute('aria-current', 'page');
      await expect(monitor).toHaveAttribute('data-state', 'active');
      expect(errors).toEqual([]);
    } finally {
      await application.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  });
}
