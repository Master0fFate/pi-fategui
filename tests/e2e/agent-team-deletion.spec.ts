import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('deletes idle team history without first closing the team', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-team-deletion-e2e-'));
  const project = path.join(directory, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'README.md'), '# Keep repository files\n');
  const application = await electron.launch({
    args: [path.resolve('.test-dist/main/index.js')],
    env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: path.join(directory, 'profile'), FATE_GUI_DATA_DIR: path.join(directory, 'data'), PI_OFFLINE: '1' },
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: /Open project/u }).first().click();
    await page.getByLabel('Message Pi').waitFor();
    // Reuse the settled-team fixture, then reopen its lifecycle without starting work.
    await page.evaluate(async () => {
      await window.piDesktop.createGoalMax({ objective: 'Check team deletion', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
      await window.piDesktop.prompt({ text: '__FATE_COMPOSER_RAILS__', behavior: 'prompt' });
      const team = (await window.piDesktop.getRuntimeState()).agentTeams![0]!;
      await window.piDesktop.controlAgentTeam({ action: 'resetTeam', teamId: team.id });
    });
    await page.locator('.inspector-primary-nav').getByRole('button', { name: /^Run(?:,|$)/u }).click();
    await page.getByRole('tab', { name: /^Subagent sessions/u }).click();
    const agents = page.getByRole('region', { name: 'Agent sessions', exact: true });
    await expect(agents.locator('.agent-tree-branch-state')).toHaveText('active');
    const trigger = agents.getByRole('button', { name: /^Delete team history for/u });
    await expect(trigger).toBeEnabled();
    await trigger.click();
    const confirmation = page.getByRole('alertdialog', { name: /^Delete .* history\?/u });
    await expect(confirmation).toContainText('Repository and worktree files and Git branches are kept.');
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toBeFocused();
    await expect(agents.locator('.agent-tree-branch-state')).toHaveText('active');
    await trigger.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete history', exact: true }).click();
    await expect(trigger).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(agents).toBeFocused();
    expect((await page.evaluate(() => window.piDesktop.getRuntimeState())).agentTeams).toEqual([]);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
