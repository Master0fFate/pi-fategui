import { _electron as electron } from '@playwright/test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const argumentsMap = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  argumentsMap.set(process.argv[index], process.argv[index + 1]);
}
function integerArgument(name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = argumentsMap.get(name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/u.test(raw)) throw new Error(`${name} must be an integer.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is outside the supported integer range.`);
  return Math.max(minimum, Math.min(maximum, parsed));
}

const runCount = integerArgument('--runs', 3, 1);
const historyCount = integerArgument('--history', 600, 0, 20_000);
const deltaCount = integerArgument('--deltas', 6_000, 1, 100_000);
const settleMs = integerArgument('--settle-ms', 500, 0, 10_000);
const idleMs = integerArgument('--idle-ms', 750, 100, 10_000);
const label = argumentsMap.get('--label') ?? 'profile';
const visualMode = argumentsMap.get('--mode') ?? 'normal';
if (!['normal', 'performance', 'holy'].includes(visualMode)) throw new Error(`Unsupported --mode ${visualMode}. Use normal, performance, or holy.`);
const outputPath = path.resolve(argumentsMap.get('--out') ?? `.parallax/performance/${label}.json`);
const e2eMain = path.resolve('.test-dist/main/index.js');
const rendererMarker = `__FATE_LIVE_PROFILE__:${historyCount}:${deltaCount}`;
const expectedTimelineEntries = Math.min(5_000, historyCount + 3);

const percentile = (values, fraction) => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))] ?? 0;
};
const median = (values) => percentile(values, 0.5);
const round = (value) => Math.round(value * 100) / 100;

function cpuSummary(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const samples = new Map();
  for (const id of profile.samples ?? []) samples.set(id, (samples.get(id) ?? 0) + 1);
  const functions = new Map();
  for (const [id, count] of samples) {
    const frame = nodes.get(id)?.callFrame;
    if (!frame) continue;
    const key = `${frame.functionName || '(anonymous)'} @ ${frame.url || '(native)'}`;
    functions.set(key, (functions.get(key) ?? 0) + count);
  }
  return [...functions.entries()]
    .map(([name, sampleCount]) => ({ name, sampleCount }))
    .sort((left, right) => right.sampleCount - left.sampleCount)
    .slice(0, 25);
}

async function runProfile(iteration) {
  const project = await mkdtemp(path.join(tmpdir(), 'fate-live-profile-project-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'fate-live-profile-user-'));
  await writeFile(path.join(project, 'profile.txt'), 'Fate UI live renderer performance fixture.\n');
  const application = await electron.launch({
    args: [e2eMain],
    env: {
      ...process.env,
      PI_DESKTOP_E2E_PROJECT: project,
      PI_DESKTOP_E2E_USER_DATA: userData,
      FATE_GUI_DATA_DIR: path.join(userData, 'fateGUI'),
      PI_OFFLINE: '1',
      FATE_GUI_PROFILE_VISUAL_MODE: visualMode,
    },
  });
  const consoleErrors = [];
  try {
    const page = await application.firstWindow();
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const location = message.location();
      const source = location.url ? ` (${location.url}:${location.lineNumber ?? 0})` : '';
      consoleErrors.push(`console: ${message.text().slice(0, 1_000)}${source}`);
    });
    await page.getByRole('heading', { name: 'Start with your AI connection' }).waitFor();
    await page.getByRole('button', { name: /Open project/u }).first().click();
    const composer = page.getByLabel('Message Pi');
    await composer.waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#pi-composer')?.hasAttribute('disabled'));

    await page.evaluate(() => {
      const state = {
        stopped: false,
        frameGaps: [],
        timerLags: [],
        longTasks: [],
        observer: null,
        timer: 0,
      };
      globalThis.__fateLiveProfile = state;
      let previousFrame = performance.now();
      const frame = (now) => {
        if (state.stopped) return;
        state.frameGaps.push(now - previousFrame);
        previousFrame = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      let previousTimer = performance.now();
      state.timer = setInterval(() => {
        const now = performance.now();
        state.timerLags.push(Math.max(0, now - previousTimer - 16));
        previousTimer = now;
      }, 16);
      if ('PerformanceObserver' in globalThis && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        state.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
        });
        state.observer.observe({ entryTypes: ['longtask'] });
      }
    });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Performance.enable');
    const heapBefore = await cdp.send('Runtime.getHeapUsage');
    const metricsBefore = await cdp.send('Performance.getMetrics');
    await cdp.send('Profiler.start');
    // Prime Electron's interval-based CPU counters before the measured burst.
    await application.evaluate(({ app }) => { app.getAppMetrics(); });

    const startedAt = performance.now();
    await composer.fill(rendererMarker);
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByRole('button', { name: 'Queue follow-up message' }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Send message' }).waitFor({ timeout: 120_000 });
    await page.waitForFunction(
      (expected) => Number(document.querySelector('.conversation')?.getAttribute('data-entry-count') ?? 0) >= expected,
      expectedTimelineEntries,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(settleMs);
    const wallMs = performance.now() - startedAt;

    const { profile } = await cdp.send('Profiler.stop');
    const metricsAfter = await cdp.send('Performance.getMetrics');
    const heapAfter = await cdp.send('Runtime.getHeapUsage');
    const browserSignals = await page.evaluate(() => {
      const state = globalThis.__fateLiveProfile;
      state.stopped = true;
      clearInterval(state.timer);
      state.observer?.disconnect();
      const memory = performance.memory;
      return {
        frameGaps: state.frameGaps,
        timerLags: state.timerLags,
        longTasks: state.longTasks,
        usedJsHeapSize: memory?.usedJSHeapSize ?? null,
        totalJsHeapSize: memory?.totalJSHeapSize ?? null,
        timelineEntries: Number(document.querySelector('.conversation')?.getAttribute('data-entry-count') ?? 0),
        visibleTimelineEntries: Number(document.querySelector('.conversation')?.getAttribute('data-visible-entry-count') ?? 0),
        mountedTimelineRows: document.querySelectorAll('.timeline-row').length,
        visualMode: {
          performance: document.documentElement.dataset.performanceMode === 'true',
          reducedMotion: document.documentElement.dataset.reduceMotion === 'true',
          holy: document.documentElement.dataset.holyShitMode === 'true',
        },
      };
    });
    const readAppMetrics = ({ app }) => app.getAppMetrics().map((metric) => ({
      type: metric.type,
      cpuPercent: metric.cpu.percentCPUUsage,
      workingSetKiB: metric.memory.workingSetSize,
      peakWorkingSetKiB: metric.memory.peakWorkingSetSize,
    }));
    const appMetrics = await application.evaluate(readAppMetrics);
    await page.waitForTimeout(idleMs);
    const idleAppMetrics = await application.evaluate(readAppMetrics);
    const metricObject = (metrics) => Object.fromEntries(metrics.metrics.map((metric) => [metric.name, metric.value]));
    const before = metricObject(metricsBefore);
    const after = metricObject(metricsAfter);
    const cpuPath = outputPath.replace(/\.json$/u, `.run-${iteration}.cpuprofile`);
    await mkdir(path.dirname(cpuPath), { recursive: true });
    await writeFile(cpuPath, JSON.stringify(profile));

    return {
      iteration,
      wallMs: round(wallMs),
      heapBeforeBytes: heapBefore.usedSize,
      heapAfterBytes: heapAfter.usedSize,
      heapGrowthBytes: heapAfter.usedSize - heapBefore.usedSize,
      taskDurationMs: round((after.TaskDuration ?? 0) * 1_000 - (before.TaskDuration ?? 0) * 1_000),
      scriptDurationMs: round((after.ScriptDuration ?? 0) * 1_000 - (before.ScriptDuration ?? 0) * 1_000),
      layoutDurationMs: round((after.LayoutDuration ?? 0) * 1_000 - (before.LayoutDuration ?? 0) * 1_000),
      recalcStyleDurationMs: round((after.RecalcStyleDuration ?? 0) * 1_000 - (before.RecalcStyleDuration ?? 0) * 1_000),
      frameGapP95Ms: round(percentile(browserSignals.frameGaps, 0.95)),
      frameGapMaxMs: round(Math.max(0, ...browserSignals.frameGaps)),
      timerLagP95Ms: round(percentile(browserSignals.timerLags, 0.95)),
      timerLagMaxMs: round(Math.max(0, ...browserSignals.timerLags)),
      longTaskCount: browserSignals.longTasks.length,
      longTaskTotalMs: round(browserSignals.longTasks.reduce((total, value) => total + value, 0)),
      longTaskMaxMs: round(Math.max(0, ...browserSignals.longTasks)),
      usedJsHeapSize: browserSignals.usedJsHeapSize,
      totalJsHeapSize: browserSignals.totalJsHeapSize,
      timelineEntries: browserSignals.timelineEntries,
      visibleTimelineEntries: browserSignals.visibleTimelineEntries,
      mountedTimelineRows: browserSignals.mountedTimelineRows,
      visualMode: browserSignals.visualMode,
      appMetrics,
      idleAppMetrics,
      cpuProfile: path.relative(process.cwd(), cpuPath),
      topCpuFunctions: cpuSummary(profile),
      consoleErrors,
    };
  } finally {
    await application.close().catch(() => undefined);
    await rm(project, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
}

await access(e2eMain).catch(() => {
  throw new Error('Missing .test-dist/main/index.js. Run pnpm build:e2e before profiling.');
});
await mkdir(path.dirname(outputPath), { recursive: true });
const runs = [];
for (let iteration = 1; iteration <= runCount; iteration += 1) {
  process.stdout.write(`[${label}] live profile ${iteration}/${runCount}... `);
  const result = await runProfile(iteration);
  runs.push(result);
  process.stdout.write(`${result.wallMs} ms, task ${result.taskDurationMs} ms, heap +${result.heapGrowthBytes} bytes\n`);
}
const report = {
  schemaVersion: 1,
  label,
  capturedAt: new Date().toISOString(),
  workload: { historyMessages: historyCount, assistantDeltas: deltaCount, toolUpdates: Math.ceil(deltaCount / 10), settleMs, idleMs, visualMode, transport: 'Electron main → validated IPC → preload → Zustand → React/Virtuoso' },
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
  },
  summary: {
    medianWallMs: round(median(runs.map((run) => run.wallMs))),
    medianTaskDurationMs: round(median(runs.map((run) => run.taskDurationMs))),
    medianScriptDurationMs: round(median(runs.map((run) => run.scriptDurationMs))),
    medianLayoutDurationMs: round(median(runs.map((run) => run.layoutDurationMs))),
    medianRecalcStyleDurationMs: round(median(runs.map((run) => run.recalcStyleDurationMs))),
    medianHeapGrowthBytes: Math.round(median(runs.map((run) => run.heapGrowthBytes))),
    medianFrameGapP95Ms: round(median(runs.map((run) => run.frameGapP95Ms))),
    medianFrameGapMaxMs: round(median(runs.map((run) => run.frameGapMaxMs))),
    medianTimerLagP95Ms: round(median(runs.map((run) => run.timerLagP95Ms))),
    totalLongTasks: runs.reduce((total, run) => total + run.longTaskCount, 0),
    medianMountedTimelineRows: round(median(runs.map((run) => run.mountedTimelineRows))),
    totalConsoleErrors: runs.reduce((total, run) => total + run.consoleErrors.length, 0),
  },
  runs,
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath: path.relative(process.cwd(), outputPath), summary: report.summary }, null, 2));
