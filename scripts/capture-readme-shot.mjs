import { _electron as electron } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

// Captures a README screenshot of the Fate UI workspace against the E2E harness.
// The FakePiRuntimeService seeds sessions, telemetry, and a rich assistant reply
// so the shot needs no real Pi auth. Modeled on scripts/profile-live-renderer.mjs.
//
//   node scripts/capture-readme-shot.mjs --mode dark  --out screenshots/fate-ui-dark.png
//   node scripts/capture-readme-shot.mjs --mode light --out screenshots/fate-ui-light.png

// Real built-in palettes (src/shared/themes.ts). The E2E harness does not apply the
// configured theme at runtime (the App settings effect no-ops in the harness), so we
// inject the exact palette the renderer would use, mirroring applyTheme() in theme.ts
// token-for-token and dispatching the same fate-theme-change event Monaco/Mermaid hear.
const THEMES = {
  dark: {
    id: 'midnight', tone: 'dark', name: 'Midnight',
    colors: {
      canvas: '#090b12', panel: '#0f121c', raised: '#171b28', raisedHover: '#202536',
      border: '#292f3e', borderStrong: '#3b4357', text: '#eef0f7', textSoft: '#c4c9d4',
      muted: '#8992a7', subtle: '#626c80', accent: '#7c6cff', accentHover: '#9589ff',
      accentSoft: '#24213f', onAccent: '#ffffff', success: '#55c78a', warning: '#d2a94b',
      danger: '#e35d6a', shadow: '#020308',
    },
  },
  light: {
    id: 'daylight', tone: 'light', name: 'Daylight',
    colors: {
      canvas: '#f5f7fb', panel: '#ffffff', raised: '#edf1f7', raisedHover: '#e2e7f0',
      border: '#d5dbe6', borderStrong: '#b7c0d0', text: '#171b26', textSoft: '#343b4b',
      muted: '#59657a', subtle: '#7c8799', accent: '#5f50d8', accentHover: '#4d40bd',
      accentSoft: '#e8e5ff', onAccent: '#ffffff', success: '#237a4b', warning: '#8a6508',
      danger: '#b33b4a', shadow: '#63708a',
    },
  },
};

const TOKEN_VARS = {
  canvas: '--theme-canvas', panel: '--theme-panel', raised: '--theme-raised', raisedHover: '--theme-raised-hover',
  border: '--theme-border', borderStrong: '--theme-border-strong', text: '--theme-text', textSoft: '--theme-text-soft',
  muted: '--theme-muted', subtle: '--theme-subtle', accent: '--theme-accent', accentHover: '--theme-accent-hover',
  accentSoft: '--theme-accent-soft', onAccent: '--theme-on-accent', success: '--theme-success', warning: '--theme-warning',
  danger: '--theme-danger', shadow: '--theme-shadow',
};

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);

const mode = args.get('--mode') === 'light' ? 'light' : 'dark';
const out = path.resolve(args.get('--out') ?? `screenshots/fate-ui-${mode}.png`);
const e2eMain = path.resolve('.test-dist/main/index.js');
const theme = THEMES[mode];

// Clean project name so the sidebar reads "fate-ui-demo" instead of a temp prefix.
const project = path.join(tmpdir(), 'fate-ui-demo');
await rm(project, { recursive: true, force: true });
await mkdir(path.join(project, 'src'), { recursive: true });
const userData = await mkdtemp(path.join(tmpdir(), 'fate-shot-user-'));
await writeFile(path.join(project, 'README.md'), '# Fate UI\n\nA local-first desktop workspace for Pi Agent.\n');
await writeFile(path.join(project, 'src', 'example.ts'), 'export const answer = 42;\n');
await writeFile(path.join(project, 'package.json'), '{\n  "name": "fate-ui-demo",\n  "version": "1.0.0"\n}\n');
// Real Git repo with an untracked file so the Changes panel has something to show.
try {
  execSync('git init -q', { cwd: project, stdio: 'ignore' });
  execSync('git -c user.email=demo@fate.local -c user.name="Fate UI" add README.md src/example.ts package.json', { cwd: project, stdio: 'ignore' });
  execSync('git -c user.email=demo@fate.local -c user.name="Fate UI" commit -qm "Initial demo project"', { cwd: project, stdio: 'ignore' });
  await writeFile(path.join(project, 'src', 'utils.ts'), 'export const greet = (name: string) => `Hello, ${name}!`;\n');
} catch {
  // Git is optional; the screenshot still works without it.
}

const application = await electron.launch({
  args: [e2eMain, '--force-device-scale-factor=2'],
  env: {
    ...process.env,
    PI_DESKTOP_E2E_PROJECT: project,
    PI_DESKTOP_E2E_USER_DATA: userData,
    FATE_GUI_DATA_DIR: path.join(userData, 'fateGUI'),
    PI_OFFLINE: '1',
  },
});

async function applyTheme(page) {
  await page.evaluate((palette) => {
    const root = document.documentElement;
    root.style.colorScheme = palette.tone;
    root.dataset.theme = palette.id;
    root.dataset.themeTone = palette.tone;
    root.dataset.appearance = palette.tone;
    for (const [key, variable] of Object.entries(palette.vars)) root.style.setProperty(variable, palette.colors[key]);
    window.dispatchEvent(new CustomEvent('fate-theme-change', { detail: palette.theme }));
  }, { id: theme.id, tone: theme.tone, colors: theme.colors, vars: TOKEN_VARS, theme });
}

try {
  const page = await application.firstWindow();
  await applyTheme(page);
  await page.getByRole('heading', { name: 'What would you like Pi to do?' }).waitFor();
  await page.locator('.action-card--primary').click();
  const composer = page.getByLabel('Message Pi');
  await composer.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#pi-composer')?.hasAttribute('disabled'));
  await applyTheme(page); // re-apply after the project opens, in case React re-rendered the root.

  // Any non-marker text triggers the deterministic assistant reply: a tool call,
  // an inline image, and a mermaid diagram. Pick wording that reads well on screen.
  await composer.fill('Inspect this project and summarize the architecture.');
  await page.getByRole('button', { name: 'Send message' }).click();

  await page.getByText('Everything is ready.').waitFor({ timeout: 20_000 });
  // Let the mermaid diagram and inline image finish rendering, then lock the theme in.
  await page.waitForTimeout(2500);
  await applyTheme(page);

  const rendered = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? null,
    tone: document.documentElement.dataset.themeTone ?? null,
    canvas: getComputedStyle(document.body).backgroundColor,
  }));
  console.log('rendered', JSON.stringify(rendered));

  await mkdir(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log(`captured ${mode} (${theme.id}) -> ${path.relative(process.cwd(), out)}`);
} finally {
  await application.close().catch(() => undefined);
  await rm(project, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
}
