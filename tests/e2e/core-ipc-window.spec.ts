import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('production core opens a second trusted window without another runtime owner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fate-core-window-e2e-'));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch({
      args: [`--user-data-dir=${path.join(root, 'chromium')}`, path.resolve('.'), '--new-instance'],
      env: { ...process.env, VITE_DEV_SERVER_URL: '', FATE_GUI_DATA_DIR: path.join(root, 'data'),
        PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_OFFLINE: '1' },
    });
    const first = await application.firstWindow();
    await expect(first.locator('[data-bridge-status="ready"]')).toBeVisible();
    const opened = application.waitForEvent('window');
    await first.evaluate(() => window.piDesktop.newWindow());
    const second = await opened;
    await expect(second.locator('[data-bridge-status="ready"]')).toBeVisible();
    const [a, b] = await Promise.all([
      first.evaluate(() => window.piDesktop.getRuntimeState()),
      second.evaluate(() => window.piDesktop.getRuntimeState()),
    ]);
    expect(a.project).toBeNull();
    expect(b.project).toBeNull();
    expect(await application.windows()).toHaveLength(2);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('production IPC captures the trusted project for files, Git, Monitor and a project switch', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(tmpdir(), 'fate-core-project-e2e-'));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const projectA = path.join(root, 'A');
    const projectB = path.join(root, 'B');
    const data = path.join(root, 'data');
    await Promise.all([mkdir(projectA), mkdir(projectB), mkdir(data)]);
    const [a, b] = await Promise.all([realpath(projectA), realpath(projectB)]);
    await Promise.all([writeFile(path.join(a, 'sentinel.txt'), 'A only'), writeFile(path.join(b, 'sentinel.txt'), 'B only'),
      writeFile(path.join(data, 'trusted-projects.json'), JSON.stringify({ version: 1, paths: [a, b] }))]);
    for (const project of [a, b]) execFileSync('git', ['init', '-q', project]);
    application = await electron.launch({
      args: [`--user-data-dir=${path.join(root, 'chromium')}`, path.resolve('.'), '--new-instance', `--project=${a}`],
      env: { ...process.env, VITE_DEV_SERVER_URL: '', FATE_GUI_DATA_DIR: data,
        PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_OFFLINE: '1' },
    });
    const first = await application.firstWindow();
    await expect(first.locator('[data-bridge-status="ready"]')).toBeVisible();
    await expect.poll(() => first.evaluate(() => window.piDesktop.getRuntimeState().then((state) => state.project?.path)),
      { timeout: 45_000 }).toBe(a);
    const snapshot = await first.evaluate(async () => ({
      listing: await window.piDesktop.listFiles(), preview: await window.piDesktop.readFile('sentinel.txt'),
      git: await window.piDesktop.getGitStatus(), monitor: await window.piDesktop.getMonitorDashboard({ section: 'tasks', offset: 2, limit: 5 }),
      goal: await window.piDesktop.getGoalMax(), tasks: await window.piDesktop.getTaskList(),
    }));
    expect(snapshot.listing.entries).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'sentinel.txt' })]));
    expect(snapshot.preview).toMatchObject({ state: 'text', content: 'A only' });
    expect(snapshot.git.repository).toBe(true);
    expect(snapshot.monitor).toMatchObject({ projectPath: a, section: 'tasks', offset: 2, limit: 5 });
    expect(snapshot.goal).toBeNull();
    expect(snapshot.tasks).toBeNull();
    const terminalId = await first.evaluate(async () => (await window.piDesktop.createTerminal(80, 24)).id);
    await first.evaluate((id) => window.piDesktop.closeTerminal(id), terminalId);
    await first.evaluate((project) => window.piDesktop.openProject(project), b);
    const next = await first.evaluate(async () => ({
      preview: await window.piDesktop.readFile('sentinel.txt'), monitor: await window.piDesktop.getMonitorDashboard(),
    }));
    expect(next.preview).toMatchObject({ content: 'B only' });
    expect(next.monitor.projectPath).toBe(b);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});
