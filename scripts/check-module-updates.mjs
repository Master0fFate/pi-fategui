import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const cacheFile = path.resolve('node_modules/.cache/fate-ui/module-updates.json');
const maxAgeMs = 24 * 60 * 60 * 1_000;
const force = process.argv.includes('--force');

try {
  if (!force) {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (Date.now() - Number(cached.checkedAt) < maxAgeMs) process.exit(0);
  }
} catch {
  // A missing or malformed cache simply triggers a fresh check.
}

const result = spawnSync('pnpm', ['outdated', '--format', 'json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 20_000,
  shell: process.platform === 'win32',
});

let updates = {};
try {
  updates = result.stdout.trim() ? JSON.parse(result.stdout) : {};
} catch {
  console.warn('[updates] Could not parse pnpm outdated output; development will continue.');
  process.exit(0);
}

await mkdir(path.dirname(cacheFile), { recursive: true });
await writeFile(cacheFile, JSON.stringify({ checkedAt: Date.now(), updates }, null, 2));
const entries = Object.entries(updates);
if (entries.length === 0) {
  if (force) console.log('[updates] Direct dependencies are current.');
  process.exit(0);
}

console.warn(`[updates] ${entries.length} direct ${entries.length === 1 ? 'dependency has' : 'dependencies have'} newer releases:`);
for (const [name, info] of entries) {
  console.warn(`  ${name}: ${info.current ?? '?'} → ${info.latest ?? info.wanted ?? '?'}`);
}
console.warn('[updates] Review with `pnpm deps:check`. Update the speech runtime with `pnpm deps:update:speech`; other upgrades remain explicit so the lockfile stays reproducible.');
