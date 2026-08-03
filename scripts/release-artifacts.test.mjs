import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts', 'release-artifacts.mjs');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const expected = [
  `Fate-UI-${version}-Windows-x64.exe`,
  `Fate-UI-${version}-macOS-arm64.dmg`,
  `Fate-UI-${version}-macOS-arm64.pkg`,
  `Fate-UI-${version}-macOS-x64.dmg`,
  `Fate-UI-${version}-macOS-x64.pkg`,
  `Fate-UI-${version}-Linux-x64.AppImage`,
  `Fate-UI-${version}-Linux-x64.deb`,
].sort();
const temporaryDirectories = [];

async function artifactDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fate-release-artifacts-'));
  temporaryDirectories.push(directory);
  for (const name of expected) await writeFile(path.join(directory, name), `fresh artifact: ${name}\n`);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('release artifact verification', () => {
  it('requires the exact seven fresh installers and writes streaming SHA-256 checksums', async () => {
    const directory = await artifactDirectory();

    await execFileAsync(process.execPath, [script, 'checksums', '--source', directory], { cwd: root });

    const lines = (await readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(7);
    expect(lines.map((line) => line.replace(/^[0-9a-f]{64}  /u, ''))).toEqual(expected);
  });

  it('rejects any stale or unexpected installer before checksums are published', async () => {
    const directory = await artifactDirectory();
    await writeFile(path.join(directory, 'Fate-UI-0.4.9-Windows-x64.exe'), 'stale');

    await expect(execFileAsync(process.execPath, [script, 'checksums', '--source', directory], { cwd: root }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Release artifact set mismatch') });
  });
});
