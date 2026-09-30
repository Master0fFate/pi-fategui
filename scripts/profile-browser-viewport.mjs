import { _electron as electron, expect } from '@playwright/test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
function integer(name, fallback, minimum, maximum) {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
const runs = integer('--runs', 3, 1, 20);
const idleMs = integer('--idle-ms', 1_000, 100, 30_000);
const label = args.get('--label') ?? 'browser-viewport';
const output = path.resolve(args.get('--out') ?? `.parallax/performance/${label}.json`);
const entry = path.resolve('.test-dist/main/index.js');
const title = 'Fate viewport performance fixture';
await access(entry);
const results = [];

for (let iteration = 1; iteration <= runs; iteration += 1) {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-viewport-profile-'));
  const project = path.join(directory, 'project');
  const userData = path.join(directory, 'profile');
  await mkdir(project);
  await writeFile(path.join(project, 'index.html'), `<!doctype html><title>${title}</title><h1>Native viewport alignment</h1>`);
  let app;
  try {
    app = await electron.launch({
      executablePath: createRequire(path.resolve('package.json'))('electron'),
      args: [entry],
      env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: path.join(userData, 'fateGUI'), PI_OFFLINE: '1' },
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    await page.getByRole('button', { name: /Open project/u }).first().click();
    await page.getByLabel('Message Pi').fill('__FATE_LIVE_PROFILE__:0:1');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('FATE_PROFILE_COMPLETE_1', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open browser', exact: true }).click();
    const address = page.getByRole('textbox', { name: 'Browser address' });
    await address.fill(path.join(project, 'index.html'));
    await address.press('Enter');
    await expect(page.getByRole('tab', { name: title, exact: true })).toBeVisible();

    const alignmentError = async () => {
      const rect = await page.locator('.browser-viewport-reservation').boundingBox();
      const native = await app.evaluate(({ BrowserWindow, WebContentsView }, expectedTitle) => {
        const owner = BrowserWindow.getAllWindows()[0];
        const view = owner.contentView.children.find((child) => child instanceof WebContentsView && child.webContents.getTitle() === expectedTitle);
        return { bounds: view?.getBounds(), zoom: owner.webContents.getZoomFactor() };
      }, title);
      if (!rect || !native.bounds) return Infinity;
      return Math.max(...['x', 'y', 'width', 'height'].map((key) => Math.abs(native.bounds[key] - Math.round(rect[key] * native.zoom))));
    };
    await expect.poll(alignmentError).toBeLessThanOrEqual(1);
    await page.waitForTimeout(500);
    await page.locator('.browser-viewport-reservation').evaluate((node) => {
      const original = node.getBoundingClientRect;
      globalThis.__fateViewportReads = 0;
      node.getBoundingClientRect = function () {
        globalThis.__fateViewportReads += 1;
        return original.call(this);
      };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
    const before = await metrics();
    await page.waitForTimeout(idleMs);
    const after = await metrics();
    const idleBoundsReads = await page.evaluate(() => globalThis.__fateViewportReads);

    // Exercise real layout changes after (not during) the idle measurement.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1260, 820));
    await expect.poll(alignmentError).toBeLessThanOrEqual(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    await expect.poll(alignmentError).toBeLessThanOrEqual(1);
    const split = page.getByRole('separator', { name: 'Resize chat and browser' });
    await split.focus();
    for (let index = 0; index < 6; index += 1) await split.press('ArrowLeft');
    await expect.poll(alignmentError).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Toggle device toolbar' }).click();
    await expect.poll(alignmentError).toBeLessThanOrEqual(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.15));
    await expect.poll(alignmentError).toBeLessThanOrEqual(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await expect.poll(alignmentError).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Toggle device toolbar' }).click();
    await expect.poll(alignmentError).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
    const result = {
      iteration, idleBoundsReads, idleMs,
      idleTaskDurationMs: (after.TaskDuration - before.TaskDuration) * 1_000,
      idleScriptDurationMs: (after.ScriptDuration - before.ScriptDuration) * 1_000,
      alignmentChecks: ['window resize', 'split pane resize', 'device toolbar', 'zoom in', 'zoom reset'],
      consoleErrors: errors,
    };
    results.push(result);
    console.log(`[${label}] ${iteration}/${runs}: ${idleBoundsReads} idle bounds reads; ${result.idleTaskDurationMs.toFixed(2)} ms renderer task time`);
  } finally {
    if (app) await app.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = {
  schemaVersion: 1, label, capturedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model },
  workload: { idleMs, viewport: '1440x900', page: 'local static HTML', method: 'Count reservation.getBoundingClientRect calls; CDP renderer task/script time; then verify native bounds across real layout changes.' },
  summary: {
    medianIdleBoundsReads: median(results.map((run) => run.idleBoundsReads)),
    medianIdleTaskDurationMs: median(results.map((run) => run.idleTaskDurationMs)),
    medianIdleScriptDurationMs: median(results.map((run) => run.idleScriptDurationMs)),
  },
  runs: results,
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, summary: report.summary }, null, 2));
