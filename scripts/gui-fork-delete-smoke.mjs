// GUI fork-deletion smoke test — drives the REAL Fate UI (real main process,
// real Pi SDK, real session files) through the full delete + restart flow.
//
// HOW TO RUN (from a fresh terminal / new Fate UI instance — NOT from inside
// the app's embedded agent):
//
//   pnpm build          # once, if dist/ is stale
//   node scripts/gui-fork-delete-smoke.mjs
//
// What it does:
//   1. Creates an isolated environment: temp agent dir (real auth + model
//      config copied), temp Fate data dir (real settings copied), temp git
//      project, and a private Chromium profile for a clean sidebar.
//   2. Seeds a real 3-branch session with the real SDK SessionManager.
//   3. Launches the real app as a NEW INSTANCE (never touches the running app),
//      opens the project through the real openProject IPC, expands the folder.
//   4. Opens the session, deletes fork "ALTERNATE REPLY FORK TWO" through the
//      fork action menu (two-step confirm), verifies the toast, the remaining
//      fork list, and the active conversation content.
//   5. Verifies the JSONL on disk.
//   6. Closes and relaunches the app, verifies the deletion persisted.
//
// On failure the temp environment is KEPT and a screenshot + page dump are
// saved inside it for diagnosis. Prints LIVE_FORK_GUI_OK on success.
import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const exec = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..');
const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
const realAgentDir = path.join(home, '.pi', 'agent');
const realFateDir = path.join(home, '.pi', 'fateGUI');

// The Pi SDK reads PI_CODING_AGENT_DIR (NOT PI_AGENT_DIR) for its agent dir.
const AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';

const MAIN_REPLY_2 = 'SECOND REPLY MAIN';
const BRANCH_ONE_REPLY = 'THIRD REPLY BRANCH ONE';
const FORK_TWO_REPLY = 'ALTERNATE REPLY FORK TWO';
// Fork rows are named after the fork's first (user) message.
const FORK_TWO_NAME = 'Seed alternate prompt two';
const BRANCH_ONE_NAME = 'Seed prompt three branch one';
const BRANCH_THREE_REPLY = 'VARIANT REPLY FORK THREE';

function textMessage(role, text) {
  return { role, content: [{ type: 'text', text }], timestamp: Date.now() };
}

function launchEnv(agentDir, dataDir) {
  const env = { ...process.env };
  // Never leak the runner's own session/model bindings into the app.
  for (const key of ['PI_SESSION_FILE', 'PI_SESSION_ID', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL', 'PI_AGENT_DIR', 'TRANSCRIBE_LIBRARY']) delete env[key];
  env[AGENT_DIR_ENV] = agentDir;
  env.FATE_GUI_DATA_DIR = dataDir;
  env.FATE_NEW_INSTANCE = '1';
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
  return env;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'fate-gui-fork-'));
  const agentDir = path.join(root, 'agent');
  const dataDir = path.join(root, 'fateGUI');
  const projectPath = path.join(root, 'project');
  await mkdir(agentDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectPath, { recursive: true });

  let authCopied = false;
  try {
    await stat(path.join(realAgentDir, 'auth.json'));
    await copyFile(path.join(realAgentDir, 'auth.json'), path.join(agentDir, 'auth.json'));
    authCopied = true;
  } catch { /* session switching works without auth */ }
  // The SDK also reads models.json / models-store.json / settings.json from the
  // agent dir when resolving the default model. Copy the full config so the
  // spawned runtime initializes exactly like the real app.
  for (const name of ['models.json', 'models-store.json', 'settings.json', 'mcp.json']) {
    try {
      await stat(path.join(realAgentDir, name));
      await copyFile(path.join(realAgentDir, name), path.join(agentDir, name));
    } catch { /* optional */ }
  }
  try {
    await stat(path.join(realFateDir, 'settings.json'));
    await copyFile(path.join(realFateDir, 'settings.json'), path.join(dataDir, 'settings.json'));
  } catch { /* defaults */ }
  // The user's real settings may have compact session rows enabled; force them
  // off in this temp profile so the standard session list (with .session-open)
  // renders and the fork flow matches the default layout.
  try {
    const settingsPath = path.join(dataDir, 'settings.json');
    const settingsValue = JSON.parse(await readFile(settingsPath, 'utf8'));
    settingsValue.compactMode = false;
    settingsValue.compactSessions = false;
    await writeFile(settingsPath, JSON.stringify(settingsValue), 'utf8');
  } catch { /* missing settings; defaults are fine */ }
  await exec('git', ['init', '-q'], { cwd: projectPath });
  await exec('git', ['config', 'user.email', 'live@test.local'], { cwd: projectPath });
  await exec('git', ['config', 'user.name', 'Live Test'], { cwd: projectPath });
  await writeFile(path.join(projectPath, 'readme.md'), 'live fork gui test\n');
  await exec('git', ['add', '.'], { cwd: projectPath });
  await exec('git', ['commit', '-qm', 'init'], { cwd: projectPath });

  // Seed the session with the REAL SDK so the file lands in the exact default
  // session directory the app will scan (same env var the app uses).
  process.env[AGENT_DIR_ENV] = agentDir;
  const manager = SessionManager.create(projectPath);
  manager.appendModelChange('zai', 'glm-5.2');
  manager.appendThinkingLevelChange('medium');
  manager.appendMessage(textMessage('user', 'Seed prompt one'));
  const a1 = manager.appendMessage(textMessage('assistant', 'FIRST REPLY MAIN'));
  manager.appendMessage(textMessage('user', 'Seed prompt two'));
  const a2 = manager.appendMessage(textMessage('assistant', MAIN_REPLY_2));
  manager.appendMessage(textMessage('user', 'Seed prompt three branch one'));
  manager.appendMessage(textMessage('assistant', BRANCH_ONE_REPLY));
  manager.branch(a1);
  manager.appendMessage(textMessage('user', 'Seed alternate prompt two'));
  manager.appendMessage(textMessage('assistant', FORK_TWO_REPLY));
  manager.branch(a2);
  manager.appendMessage(textMessage('user', 'Seed variant prompt three'));
  manager.appendMessage(textMessage('assistant', BRANCH_THREE_REPLY));
  const sessionFile = manager.getSessionFile();

  // Fail fast if the app would not list this session.
  const listed = await SessionManager.list(projectPath);
  if (!listed.some((session) => session.path === sessionFile)) {
    throw new Error(`Seeded session was not listed by the SDK. sessionFile=${sessionFile} listed=${listed.map((s) => s.path).join(', ')}`);
  }

  const windowsProjectPath = path.resolve(projectPath);
  await writeFile(path.join(dataDir, 'trusted-projects.json'), JSON.stringify({ version: 1, paths: [windowsProjectPath] }), 'utf8');
  await writeFile(path.join(dataDir, 'recent-project.json'), JSON.stringify({ path: windowsProjectPath }), 'utf8');
  return { root, agentDir, dataDir, projectPath, sessionFile, authCopied };
}

export async function launchApp(agentDir, dataDir) {
  // NOTE: do not pass --project here. Playwright's electron launcher prepends
  // its own Chromium switches, and Electron re-parses argv so a following
  // switch can be mistaken for the --project value. The app auto-opens the
  // trusted recent project from recent-project.json instead.
  return electron.launch({
    args: [`--user-data-dir=${path.join(dataDir, 'chromium')}`, repoRoot, '--new-instance'],
    cwd: repoRoot,
    env: launchEnv(agentDir, dataDir),
    timeout: 150_000,
  });
}

async function openSeededSession(page) {
  // Project auto-opens (trusted + recent). A fresh profile starts with the
  // active folder collapsed, so expand it before the session list renders.
  const activeFolder = page.locator('.folder-group--active').first();
  await activeFolder.waitFor({ state: 'visible', timeout: 120_000 });
  const chevron = activeFolder.locator('.folder-chevron');
  const chevronLabel = (await chevron.getAttribute('aria-label')) ?? '';
  if (chevronLabel.startsWith('Expand')) {
    await chevron.click();
    console.log('[gui] expanded active project folder');
  }
  const sessionRow = page.locator('.session-row', { hasText: /Seed prompt/ }).first();
  await sessionRow.waitFor({ state: 'visible', timeout: 60_000 });
    const storeState = await page.evaluate(() => {
    const hook = window.__fateRuntime;
    if (typeof hook !== 'function') return { missing: true };
    const r = hook();
    return { status: r.status, stateError: r.stateError?.code ?? null, project: r.project?.path ?? null, sessionId: r.sessionId, sessionCount: (r.sessions ?? []).length, sessionTitles: (r.sessions ?? []).map((x) => x.title) };
  });
    const folderDom = await page.evaluate(() => {
    const g = document.querySelector('.folder-group--active');
    if (!g) return { missing: true };
    return {
      cls: g.className,
      children: [...g.children].map((c) => c.className),
      expandedChildren: [...g.querySelectorAll(':scope > .folder-children, :scope > .session-list')].map((c) => ({ cls: c.className, rows: c.querySelectorAll('.session-row').length, text: c.textContent?.replace(/s+/g, ' ').slice(0, 80) })),
    };
  });
    const openButton = sessionRow.locator('.session-open, .session-preview-open').first();
  await openButton.waitFor({ state: 'visible', timeout: 30_000 });
  await openButton.click();
  console.log('[gui] clicked session open button');
  await page.locator('.session-path-list').waitFor({ state: 'visible', timeout: 60_000 });
  console.log('[gui] conversation paths visible');
}

async function forkRowCount(page) {
  return page.locator('.session-row--path').count();
}

async function dumpDiagnostics(page, root) {
  try {
    await page.screenshot({ path: path.join(root, 'failure.png') });
    const body = await page.evaluate(() => document.body.innerText.slice(0, 6000));
    await writeFile(path.join(root, 'failure-page.txt'), body, 'utf8');
  } catch { /* best effort */ }
}

async function run() {
  const fixture = await setup();
  console.log(`[gui] temp root  = ${fixture.root}`);
  console.log(`[gui] session    = ${fixture.sessionFile}`);
  console.log(`[gui] auth copied= ${fixture.authCopied}`);
  let application = null;
  let failed = false;
  try {
    application = await launchApp(fixture.agentDir, fixture.dataDir);
    const startedAt = Date.now();
    const stamp = () => `[+${Math.round((Date.now() - startedAt) / 1000)}s]`;
    let page = await application.firstWindow();
    page.on('pageerror', (error) => console.log(`${stamp()} pageerror:`, String(error).slice(0, 300)));
    page.on('close', () => console.log(`${stamp()} PAGE CLOSED`));
    const appProcess = application.process();
    appProcess.stdout?.on('data', (chunk) => console.log(`${stamp()} [app stdout]`, String(chunk).slice(0, 300)));
    appProcess.stderr?.on('data', (chunk) => console.log(`${stamp()} [app stderr]`, String(chunk).slice(0, 300)));
    appProcess.once('exit', (code, signal) => console.log(`${stamp()} APP EXITED code=${code} signal=${signal}`));

    // Drive the real project-open IPC directly and verify readiness.
    const opened = await page.evaluate(async (projectPath) => {
      const api = window.piDesktop;
      let state = null;
      let error = null;
      try {
        state = await api.openProject(projectPath);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      return {
        status: state?.status ?? null,
        stateError: state?.stateError ?? null,
        sessionCount: state?.sessions?.length ?? 0,
        sessionTitles: state?.sessions?.map((session) => session.title) ?? [],
        error,
      };
    }, fixture.projectPath);
    console.log('[gui] openProject probe:', JSON.stringify(opened));
    if (opened.status !== 'ready' || opened.sessionCount < 1) {
      throw new Error(`Project did not open ready with the seeded session: ${JSON.stringify(opened)}`);
    }

    await openSeededSession(page);
    const initialForks = await forkRowCount(page);
    console.log(`[gui] initial fork rows = ${initialForks}`);
    if (initialForks !== 2) throw new Error(`Expected 2 fork rows, found ${initialForks}`);

    await page.getByText(BRANCH_THREE_REPLY, { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
    console.log(`[gui] active branch visible: ${BRANCH_THREE_REPLY}`);

    // Delete fork two: menu trigger -> menu item -> inline confirm.
    await page.getByRole('button', { name: `Actions for ${FORK_TWO_NAME}` }).click();
    await page.getByRole('menuitem', { name: `Delete fork for ${FORK_TWO_NAME}` }).click();
    const confirmGroup = page.getByRole('group', { name: `Confirm deleting fork: ${FORK_TWO_NAME}` });
    await confirmGroup.waitFor({ state: 'visible', timeout: 15_000 });
    await confirmGroup.getByRole('button', { name: 'Delete' }).click();

    await page.locator('.app-toast--success', { hasText: 'Fork deleted' }).waitFor({ state: 'visible', timeout: 30_000 });
    console.log('[gui] "Fork deleted" toast shown');
    await page.waitForFunction(() => document.querySelectorAll('.session-row--path').length === 1, undefined, { timeout: 30_000 });
    if (await page.getByRole('button', { name: `Actions for ${FORK_TWO_NAME}` }).count() !== 0) {
      throw new Error('Deleted fork still has an action row.');
    }
    await page.getByRole('button', { name: `Actions for ${BRANCH_ONE_NAME}` }).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByText(BRANCH_THREE_REPLY, { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByText(MAIN_REPLY_2, { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 });
    if (await page.getByText(FORK_TWO_REPLY, { exact: true }).count() !== 0) {
      throw new Error('Deleted fork content still visible in the conversation.');
    }
    console.log('[gui] active path intact; fork two gone from UI');

    await new Promise((resolve) => setTimeout(resolve, 700));
    const onDisk = await readFile(fixture.sessionFile, 'utf8');
    if (onDisk.includes(FORK_TWO_REPLY) || onDisk.includes('Seed alternate prompt two')) {
      throw new Error('Deleted fork content still present in the session file.');
    }
    for (const retained of ['FIRST REPLY MAIN', MAIN_REPLY_2, BRANCH_ONE_REPLY, BRANCH_THREE_REPLY]) {
      if (!onDisk.includes(retained)) throw new Error(`Retained content missing from session file: ${retained}`);
    }
    console.log('[gui] session file on disk matches (fork two removed)');

    // Restart persistence.
    await application.close();
    application = null;
    application = await launchApp(fixture.agentDir, fixture.dataDir);
    page = await application.firstWindow();
    await openSeededSession(page);
    const afterRestart = await forkRowCount(page);
    console.log(`[gui] fork rows after restart = ${afterRestart}`);
    if (afterRestart !== 1) throw new Error(`Expected 1 fork row after restart, found ${afterRestart}`);
    if (await page.getByRole('button', { name: `Actions for ${FORK_TWO_NAME}` }).count() !== 0) {
      throw new Error('Deleted fork reappeared after restart.');
    }
    await page.getByRole('button', { name: `Actions for ${BRANCH_ONE_NAME}` }).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByText(BRANCH_THREE_REPLY, { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 });
    console.log('[gui] restart persistence verified');
    console.log('LIVE_FORK_GUI_OK');
  } catch (error) {
    failed = true;
    if (application) {
      try { await dumpDiagnostics(await application.firstWindow(), fixture.root); } catch { /* ignore */ }
    }
    console.error('LIVE_FORK_GUI_FAILED', error);
    console.error(`[gui] keep temp env for diagnosis: ${fixture.root}`);
    process.exitCode = 1;
  } finally {
    if (application) await application.close().catch(() => undefined);
    if (!failed) await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void run();
