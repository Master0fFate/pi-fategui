import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureOutput, closeOrExplain } from './closeOrExplain';

async function assertNativeDatabase(data: string): Promise<void> {
  const handle = await open(path.join(data, 'durable', 'v1', 'state.sqlite'), 'r');
  try {
    const header = Buffer.alloc(16);
    expect((await handle.read(header, 0, header.length, 0)).bytesRead).toBe(16);
    expect(header.toString('utf8')).toBe('SQLite format 3\0');
  } finally { await handle.close(); }
}

// A cold production launch on a hosted runner can need more than the 10 s
// default before the bridge reports ready. The readiness check is unchanged.
const READY = { timeout: 45_000 };

for (const backend of ['legacy-json', 'native-durable'] as const) {
test(`[${backend}] production core opens a second trusted window without another runtime owner and restarts`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fate-core-window-e2e-'));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let output = (): string => '';
  const data = path.join(root, 'data');
  const launch = (selectBackend: boolean) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    Object.assign(env, { VITE_DEV_SERVER_URL: '', FATE_GUI_DATA_DIR: data,
      PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_OFFLINE: '1' });
    if (selectBackend) env.FATE_STATE_PERSISTENCE = backend;
    else delete env.FATE_STATE_PERSISTENCE;
    return electron.launch({ args: [`--user-data-dir=${path.join(root, 'chromium')}`, path.resolve('.'), '--new-instance'], env });
  };
  try {
    application = await launch(true);
    output = captureOutput(application);
    const first = await application.firstWindow();
    await expect(first.locator('[data-bridge-status="ready"]')).toBeVisible(READY);
    const opened = application.waitForEvent('window');
    await first.evaluate(() => window.piDesktop.newWindow());
    const second = await opened;
    await expect(second.locator('[data-bridge-status="ready"]')).toBeVisible(READY);
    const [a, b] = await Promise.all([
      first.evaluate(() => window.piDesktop.getRuntimeState()),
      second.evaluate(() => window.piDesktop.getRuntimeState()),
    ]);
    expect(a.project).toBeNull();
    expect(b.project).toBeNull();
    expect(await application.windows()).toHaveLength(2);
    if (backend === 'native-durable') await assertNativeDatabase(data);
    await closeOrExplain(application, output); application = undefined;
    // No selector on ordinary restart. Retained native evidence must not be
    // silently ignored or replaced by an empty legacy owner.
    application = await launch(false);
    output = captureOutput(application);
    const restarted = await application.firstWindow();
    await expect(restarted.locator('[data-bridge-status="ready"]')).toBeVisible(READY);
    expect((await restarted.evaluate(() => window.piDesktop.getRuntimeState())).project).toBeNull();
    if (backend === 'native-durable') await assertNativeDatabase(data);
  } finally {
    try { await closeOrExplain(application, output); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});

test(`[${backend}] production IPC captures the trusted project for files, Git, Monitor and a project switch`, async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(tmpdir(), 'fate-core-project-e2e-'));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let output = (): string => '';
  try {
    const projectA = path.join(root, 'A');
    const projectB = path.join(root, 'B');
    const data = path.join(root, 'data');
    await Promise.all([mkdir(projectA), mkdir(projectB), mkdir(data, { mode: 0o700 })]);
    const [a, b] = await Promise.all([realpath(projectA), realpath(projectB)]);
    await Promise.all([writeFile(path.join(a, 'sentinel.txt'), 'A only'), writeFile(path.join(b, 'sentinel.txt'), 'B only'),
      writeFile(path.join(data, 'trusted-projects.json'), JSON.stringify({ version: 1, paths: [a, b] }))]);
    for (const project of [a, b]) execFileSync('git', ['init', '-q', project]);
    application = await electron.launch({
      args: [`--user-data-dir=${path.join(root, 'chromium')}`, path.resolve('.'), '--new-instance', `--project=${a}`],
      env: { ...process.env, VITE_DEV_SERVER_URL: '', FATE_GUI_DATA_DIR: data,
        PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_OFFLINE: '1', FATE_STATE_PERSISTENCE: backend },
    });
    output = captureOutput(application);
    const first = await application.firstWindow();
    await expect(first.locator('[data-bridge-status="ready"]')).toBeVisible(READY);
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
    if (backend === 'native-durable') await assertNativeDatabase(data);
  } finally {
    try { await closeOrExplain(application, output); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
}

test('a read that arrives while a project is still opening is answered for that project', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(tmpdir(), 'fate-core-switch-e2e-'));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let output = (): string => '';
  try {
    const data = path.join(root, 'data');
    await Promise.all([mkdir(path.join(root, 'A')), mkdir(path.join(root, 'B')), mkdir(data, { mode: 0o700 })]);
    const [a, b] = await Promise.all([realpath(path.join(root, 'A')), realpath(path.join(root, 'B'))]);
    // Both folders were trusted earlier, as after an update from an older version.
    await writeFile(path.join(data, 'trusted-projects.json'), JSON.stringify({ version: 1, paths: [a, b] }));
    for (const project of [a, b]) execFileSync('git', ['init', '-q', project]);
    application = await electron.launch({
      args: [`--user-data-dir=${path.join(root, 'chromium')}`, path.resolve('.'), '--new-instance', `--project=${a}`],
      env: { ...process.env, VITE_DEV_SERVER_URL: '', FATE_GUI_DATA_DIR: data,
        PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_OFFLINE: '1' },
    });
    output = captureOutput(application);
    const first = await application.firstWindow();
    await expect(first.locator('[data-bridge-status="ready"]')).toBeVisible(READY);
    await expect.poll(() => first.evaluate(() => window.piDesktop.getRuntimeState().then((state) => state.project?.path)),
      { timeout: 45_000 }).toBe(a);
    // The Changes panel asks for Git status at the first moment the runtime
    // shows a project. The runtime shows it before the project is fully open.
    const statusAtFirstSight = (project: string) => first.evaluate(async (expected) => {
      const deadline = Date.now() + 45_000;
      for (;;) {
        const state = await window.piDesktop.getRuntimeState();
        if (state.project?.trusted && state.project.path === expected) break;
        if (Date.now() > deadline) throw new Error('The project did not appear.');
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return window.piDesktop.getGitStatus().then((git) => ({ repository: git.repository }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    }, project);
    for (const project of [b, a]) {
      const [, status] = await Promise.all([
        first.evaluate((next) => window.piDesktop.openProject(next), project), statusAtFirstSight(project)]);
      expect(status, `Git status of ${path.basename(project)}`).toEqual({ repository: true });
    }
  } finally {
    try { await closeOrExplain(application, output); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
