import { _electron as electron } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const mode = args.get('--mode') ?? 'dark';
if (!['dark', 'light', 'angelcore'].includes(mode)) throw new Error('Use --mode dark, light, or angelcore.');
const out = path.resolve(args.get('--out') ?? `screenshots/fate-ui-${mode}.png`);
const directory = await mkdtemp(path.join(tmpdir(), 'fate-release-showcase-'));
const project = path.join(directory, 'fate-ui-demo');
const data = path.join(directory, 'data');
const hooks = path.join(directory, 'empty-hooks');
await mkdir(path.join(project, 'src'), { recursive: true });
await mkdir(data); await mkdir(hooks);
const signature = 'export function search(\n  items: readonly string[],\n  query: string,\n): string[] {';
const before = `${signature}\n  return items.filter((item) =>\n    item.includes(query),\n  );\n}\n`;
const after = `${signature}\n  const needle = query.trim().toLowerCase();\n\n  return items.filter((item) =>\n    item.toLowerCase().includes(needle),\n  );\n}\n`;
await writeFile(path.join(project, 'README.md'), '# Search workspace\n\nA local demonstration project for Fate UI screenshots.\n');
await writeFile(path.join(project, 'src/search.ts'), before);
await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'fate-ui-demo', private: true, type: 'module' }, null, 2));
await exec('git', ['-c', `core.hooksPath=${hooks}`, 'init', '-q', '-b', 'main'], { cwd: project });
await exec('git', ['add', '.'], { cwd: project });
await exec('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'user.name=Fate UI Demo', '-c', 'user.email=demo@example.test', 'commit', '-qm', 'Create search example'], { cwd: project });
await writeFile(path.join(project, 'src/search.ts'), after);
await writeFile(path.join(data, 'settings.json'), JSON.stringify({
  appearance: 'dark', defaultModel: 'test/deterministic', thinkingLevel: 'medium',
  confirmRiskyCommands: true, terminalShell: null, reduceMotion: true,
  skinId: mode === 'angelcore' ? 'dreamcore' : 'default',
  themeId: mode === 'light' ? 'daylight' : mode === 'angelcore' ? 'monochrome' : 'midnight',
  musicPlayerEnabled: false,
}));

// This is the real renderer with explicitly illustrative, test-only agent content.
const application = await electron.launch({
  args: [path.resolve('.test-dist/main/index.js')],
  env: { ...process.env, PI_DESKTOP_E2E_PROJECT: project, PI_DESKTOP_E2E_USER_DATA: path.join(directory, 'profile'), FATE_GUI_DATA_DIR: data, FATE_UI_SHOWCASE: '1', PI_OFFLINE: '1' },
});
try {
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 960));
  await page.getByRole('button', { name: /Open project/ }).first().click();
  await page.getByLabel('Message Pi').waitFor();
  await page.evaluate(() => window.piDesktop.prompt({ text: '__FATE_RELEASE_SHOWCASE__', behavior: 'prompt' }));
  await page.getByRole('heading', { name: 'A focused change, ready to review' }).waitFor();
  await page.getByRole('button', { name: 'Expand fate-ui-demo', exact: true }).click();
  const handle = page.getByRole('separator', { name: 'Resize inspector', exact: true });
  await handle.focus();
  for (let step = 0; step < 13; step += 1) await page.keyboard.press('ArrowLeft');
  await page.locator('.change-row').filter({ hasText: 'src/search.ts' }).first().click();
  await page.locator('.monaco-editor:visible').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.getByLabel('Message Pi').fill('Review the diff, then help me prepare a commit.');
  await page.mouse.move(700, 60);
  await page.waitForTimeout(500);
  if (errors.length) throw new Error(`Renderer errors: ${errors.join('; ')}`);
  const expectedTheme = mode === 'light' ? 'daylight' : mode === 'angelcore' ? 'monochrome' : 'midnight';
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== expectedTheme) throw new Error(`Expected ${expectedTheme} palette.`);
  await mkdir(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, animations: 'disabled' });
  console.log(JSON.stringify({ mode, output: path.relative(process.cwd(), out), illustrativeAgentContent: true, theme: await page.evaluate(() => ({ ...document.documentElement.dataset })) }));
} finally {
  await application.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
