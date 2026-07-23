import { _electron as electron, expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-desktop-e2e-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/example.ts'), 'export const answer = 1;\n');
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  await exec('git', ['config', 'user.email', 'e2e@example.test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Pi Desktop E2E'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: root });
  await writeFile(path.join(root, 'src/example.ts'), 'export const answer = 42;\n');
  return root;
}

test('first launch, project, prompt, tool, diff, and session switching', async () => {
  const project = await fixtureRepository();
  const userData = await mkdtemp(path.join(tmpdir(), 'pi-desktop-profile-'));
  const application = await electron.launch({
    args: [path.resolve('.test-dist/main/index.js')],
    env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: userData, PI_OFFLINE: '1' },
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: 'What would you like Pi to do?' })).toBeVisible();
    expect(await page.evaluate(() => ({ process: 'process' in window, require: 'require' in window, bridge: 'piDesktop' in window }))).toEqual({ process: false, require: false, bridge: true });

    await page.getByRole('button', { name: /Open project/ }).first().click();
    await expect(page.getByText(path.basename(project)).first()).toBeVisible();
    await expect(page.getByText('Connected')).toBeVisible();
    await page.screenshot({ path: 'test-results/pi-desktop-final.png' });

    await page.keyboard.press('Control+K');
    await expect(page.getByLabel('Search commands')).toBeVisible();
    await page.getByLabel('Search commands').fill('settings');
    await page.getByRole('option', { name: /Open settings/ }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await expect(page.getByText('Pi diagnostics')).toBeVisible();
    await page.getByRole('button', { name: 'Close settings' }).click();

    await page.getByRole('button', { name: 'Open terminal' }).click();
    await expect(page.getByRole('region', { name: 'Manual integrated terminal' })).toBeVisible();
    await expect(page.getByText(/Manual terminal · test-shell/)).toBeVisible();
    await page.getByRole('region', { name: 'Manual integrated terminal' }).getByRole('button', { name: 'Close terminal' }).click();

    await page.getByLabel('Message Pi').fill('Inspect this project');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('I inspected the project. Everything is ready.')).toBeVisible();
    await expect(page.getByRole('article', { name: 'read tool succeeded' })).toBeVisible();
    await page.getByRole('article', { name: 'read tool succeeded' }).getByRole('button').click();
    await expect(page.getByText('export const answer = 42;')).toBeVisible();

    await page.getByRole('tab', { name: /Changes/ }).click();
    const changedFile = page.locator('button.change-row[title="src/example.ts"]');
    await expect(changedFile).toBeVisible();
    await changedFile.click();
    await expect(page.locator('.preview-heading span[title="src/example.ts"]')).toBeVisible();

    await page.getByRole('button', { name: /Second session/ }).click();
    await expect(page.getByText('Second session').first()).toBeVisible();
  } finally {
    await application.close();
    await rm(project, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
