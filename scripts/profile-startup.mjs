import { _electron as electron, expect } from '@playwright/test';
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const runs = Number(args.get('--runs') ?? 3);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) throw new Error('--runs must be an integer from 1 to 20.');
const label = args.get('--label') ?? 'startup';
const output = path.resolve(args.get('--out') ?? `.parallax/performance/${label}.json`);
const entry = path.resolve('.test-dist/main/index.js');
await access(entry);
const results = [];
for (let iteration = 1; iteration <= runs; iteration += 1) {
  const directory = await mkdtemp(path.join(tmpdir(), 'fate-startup-profile-'));
  const project = path.join(directory, 'project');
  const userData = path.join(directory, 'profile');
  await mkdir(project);
  let app;
  try {
    const started = performance.now();
    app = await electron.launch({
      executablePath: createRequire(path.resolve('package.json'))('electron'), args: [entry],
      env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: userData, FATE_GUI_DATA_DIR: path.join(userData, 'fateGUI'), PI_OFFLINE: '1' },
    });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Start with your AI connection' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const launchToReadyMs = performance.now() - started;
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    const cdp = await page.context().newCDPSession(page);
    const requestedUrls = new Set();
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', ({ request }) => requestedUrls.add(request.url));
    // file: resources are absent from Chromium Resource Timing. Capture actual
    // requests through CDP before reload instead of accepting an empty result.
    // Launch-to-ready above remains a separate fresh-process diagnostic.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Start with your AI connection' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const observed = await page.evaluate(() => ({
      navigation: performance.getEntriesByType('navigation').map((entry) => ({ durationMs: entry.duration, domContentLoadedMs: entry.domContentLoadedEventEnd })),
    }));
    const resources = [];
    for (const url of [...requestedUrls].filter((url) => url.startsWith('file:'))) {
      const file = fileURLToPath(url);
      resources.push({ file: path.basename(file), bytes: (await stat(file)).size });
    }
    resources.sort((a, b) => a.file.localeCompare(b.file));
    expect(resources.some(({ file }) => file.endsWith('.js')), 'Startup resource capture must include JavaScript').toBe(true);
    expect(resources.some(({ file }) => file.endsWith('.woff2')), 'Startup resource capture must include fonts').toBe(true);
    const heavy = resources.filter(({ file }) => /^(Monaco|editor\.api|ts\.worker|editor\.worker|TerminalPanel|SettingsDialog|mermaid)/iu.test(file));
    expect(heavy, 'Closed optional features must not load their heavy code at startup').toEqual([]);
    expect(errors).toEqual([]);
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const result = {
      iteration, launchToReadyMs, retainedHeapBytes: heap.usedSize, navigation: observed.navigation,
      loadedLocalBytes: resources.reduce((sum, resource) => sum + resource.bytes, 0),
      loadedFontBytes: resources.filter(({ file }) => /\.(woff2?|ttf|otf)$/u.test(file)).reduce((sum, resource) => sum + resource.bytes, 0),
      resources, consoleErrors: errors,
    };
    results.push(result);
    console.log(`[${label}] ${iteration}/${runs}: ${launchToReadyMs.toFixed(2)} ms launch-to-ready; ${result.loadedLocalBytes} loaded local bytes`);
  } finally {
    if (app) await app.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = {
  schemaVersion: 1, label, capturedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model },
  workload: 'Fresh Electron E2E fixture process/profile, first-launch shell and fonts ready; then reload to capture resources/errors. No optional feature opened. File sizes are uncompressed local bytes, not network traffic. OS caches are not cleared.',
  summary: {
    medianLaunchToReadyMs: median(results.map((run) => run.launchToReadyMs)),
    medianRetainedHeapBytes: median(results.map((run) => run.retainedHeapBytes)),
    medianLoadedLocalBytes: median(results.map((run) => run.loadedLocalBytes)),
    medianLoadedFontBytes: median(results.map((run) => run.loadedFontBytes)),
  },
  runs: results,
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, summary: report.summary }, null, 2));
