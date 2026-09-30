import { _electron as electron, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('off-by-default scoped learning supports manual approval and an actual different-session manifest', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-learning-e2e-'));
  const root = path.join(directory, 'project');
  const userData = path.join(directory, 'profile');
  await mkdir(root);
  const application = await electron.launch({ args: [path.resolve('.test-dist/main/index.js')], env: { ...process.env, PI_DESKTOP_E2E_PROJECT: root, PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: path.join(userData, 'fateGUI'), PI_OFFLINE: '1' } });
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: /Memory Learning/u }).click();
    await expect(settings.getByRole('heading', { name: 'Memory Learning' })).toBeVisible();
    await expect(settings.getByRole('checkbox', { name: 'Enable Memory Learning' })).not.toBeChecked();
    await settings.getByRole('checkbox', { name: 'Enable Memory Learning' }).check();
    await expect(settings.getByRole('checkbox', { name: 'Enable GLOBAL memory' })).toBeChecked();
    await expect(settings.getByRole('checkbox', { name: 'Enable PROJECT memory' })).toBeChecked();
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => page.evaluate(() => window.piDesktop.getSettings())).toMatchObject({ memoryLearning: { enabled: true, global: true, project: true } });
    await expect(settings.getByRole('region', { name: 'Memory storage locations' })).toContainText('settings.json');
    await expect(settings.getByRole('region', { name: 'Memory storage locations' })).toContainText('current.json');
    await settings.locator('.settings-scroll').evaluate((element) => { element.scrollTop = 0; });
    await settings.screenshot({ path: 'test-results/memory-learning-settings.png' });
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('button', { name: /Open project/u }).first().click();
    await page.getByRole('button', { name: /Memory Learning/u }).click();
    const learning = page.getByRole('dialog', { name: 'Memory Learning', exact: true });
    await learning.getByRole('button', { name: 'Add lesson' }).click();
    await learning.getByLabel('Title', { exact: true }).fill('Keep filesystem work in main');
    await learning.getByLabel('guidance', { exact: true }).fill('Filesystem work belongs in main behind named IPC, never renderer components.');
    await learning.getByRole('button', { name: 'Save draft', exact: true }).click();
    // Do not open review while the save is still clearing its busy flag. The
    // real backend draft and visible idle state, not a delay, identify the
    // exact revision whose keyboard approval this journey exercises.
    await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getLearningState()).snapshot?.drafts
      .filter((draft) => draft.state === 'pending' && draft.content.title === 'Keep filesystem work in main').length)).toBe(1);
    await expect(learning.getByRole('status').filter({ hasText: /^Working/u })).toHaveCount(0);
    await learning.getByRole('button', { name: 'Review draft' }).click();
    await expect(learning.getByRole('region', { name: 'Lesson review', exact: true })).toContainText('Review exact draft');
    // Opening review removes the focused Review draft button. Let Radix's
    // focus scope finish returning focus to the dialog before targeting approval.
    await expect(learning).toBeFocused();
    const approval = learning.getByRole('button', { name: 'Approve exact revision', exact: true });
    await expect(approval).toBeEnabled();
    await approval.scrollIntoViewIfNeeded();
    await approval.focus();
    await expect(approval).toBeFocused();
    // Locator.press focuses this exact button immediately before dispatching
    // the real keyboard event, rather than relying on a prior focus assertion.
    await approval.press('Enter');
    await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getLearningState()).snapshot?.lessons.length)).toBe(1);
    await expect(learning.getByRole('alert')).toHaveCount(0);
    await learning.getByRole('button', { name: 'Close Memory Learning' }).click();
    await page.evaluate(async () => { await window.piDesktop.switchSession('e2e-session-2'); });
    await page.getByRole('button', { name: /Memory Learning/u }).click();
    await learning.getByRole('button', { name: 'Use on next turn' }).click();
    await learning.getByRole('button', { name: 'Close Memory Learning' }).click();
    await page.getByLabel('Message Pi').fill('Implement renderer file preview with filesystem work in main.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getLearningState()).snapshot?.manifests.at(-1))).toMatchObject({ sessionId: 'e2e-session-2', state: 'handed-to-runtime', items: [expect.objectContaining({ revisionId: expect.any(String) })] });
    await page.getByRole('button', { name: /Memory Learning/u }).click();
    await learning.getByRole('button', { name: 'Recent use', exact: true }).click();
    await expect(learning.getByRole('heading', { name: 'Handed to runtime (provider receipt unproven)' })).toBeVisible();
    await page.screenshot({ path: 'test-results/memory-learning-recent-use.png' });
    await learning.getByRole('button', { name: 'Close Memory Learning' }).click();
    await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getRuntimeState()).streaming)).toBe(false);
    await page.getByRole('button', { name: /Memory Learning/u }).click();
    await learning.getByRole('button', { name: 'Profile', exact: true }).click();
    await learning.getByRole('button', { name: 'User profile', exact: true }).click();
    await learning.getByLabel('communication', { exact: true }).fill('Keep answers concise and direct.');
    await learning.getByLabel('workflow', { exact: true }).fill('Ask before adding a dependency.');
    await learning.getByRole('button', { name: 'Save draft', exact: true }).click();
    await learning.getByRole('button', { name: 'Review draft' }).click();
    await learning.getByRole('button', { name: 'Approve exact revision' }).click();
    await learning.getByLabel('Learning selection mode').selectOption('automatic');
    await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getLearningState('global')).snapshot?.mode)).toBe('automatic');
    await learning.getByRole('button', { name: 'Project', exact: true }).click();
    await learning.getByRole('button', { name: 'Project briefing', exact: true }).click();
    await learning.getByLabel('overview', { exact: true }).fill('An Electron coding workspace.');
    await learning.getByLabel('architecture', { exact: true }).fill('Filesystem access belongs in main behind IPC.');
    await learning.getByRole('button', { name: 'Save draft', exact: true }).click();
    await learning.getByRole('button', { name: 'Review draft' }).click();
    await learning.getByRole('button', { name: 'Approve exact revision' }).click();
    await learning.getByLabel('Learning selection mode').selectOption('automatic');
    await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getLearningState()).contextModes)).toEqual({ global: 'automatic', project: 'automatic' });
    await learning.getByRole('button', { name: 'Close Memory Learning' }).click();
    await page.evaluate(async () => { await window.piDesktop.switchSession('e2e-session-1'); });
    await page.getByLabel('Message Pi').fill('Continue from the saved project briefing.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.piDesktop.getLearningState()).recentUse?.at(-1)?.items.map((item) => item.scope))).toEqual(['global', 'project']);
  } finally { await application.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
