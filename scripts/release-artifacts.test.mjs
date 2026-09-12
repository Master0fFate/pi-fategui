import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  it('requires the exact seven Windows, macOS, and Linux installers and writes streaming SHA-256 checksums', async () => {
    const directory = await artifactDirectory();

    await execFileAsync(process.execPath, [script, 'checksums', '--source', directory], { cwd: root });

    const lines = (await readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(7);
    expect(lines.map((line) => line.replace(/^[0-9a-f]{64}  /u, ''))).toEqual(expected);
    expect(lines.join('\n')).not.toContain('Modulo');
  });

  it('stages native builder output under canonical public names on every platform', async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), 'fate-release-source-'));
    temporaryDirectories.push(source);
    const sourceNames = [
      `Fate-UI-${version}-Windows-x64.exe`,
      `Fate-UI-${version}-macOS-arm64.dmg`, `Fate-UI-${version}-macOS-arm64.pkg`,
      `Fate-UI-${version}-macOS-x64.dmg`, `Fate-UI-${version}-macOS-x64.pkg`,
      `Fate-UI-${version}-Linux-x86_64.AppImage`, `Fate-UI-${version}-Linux-amd64.deb`,
    ];
    for (const name of sourceNames) await writeFile(path.join(source, name), `builder artifact: ${name}\n`);

    for (const [platform, arch, names] of [
      ['win32', 'x64', [`Fate-UI-${version}-Windows-x64.exe`]],
      ['darwin', 'arm64', [`Fate-UI-${version}-macOS-arm64.dmg`, `Fate-UI-${version}-macOS-arm64.pkg`]],
      ['darwin', 'x64', [`Fate-UI-${version}-macOS-x64.dmg`, `Fate-UI-${version}-macOS-x64.pkg`]],
      ['linux', 'x64', [`Fate-UI-${version}-Linux-x64.AppImage`, `Fate-UI-${version}-Linux-x64.deb`]],
    ]) {
      const output = await mkdtemp(path.join(os.tmpdir(), 'fate-release-stage-'));
      temporaryDirectories.push(output);
      await execFileAsync(process.execPath, [script, 'stage', '--source', source, '--output', output, '--platform', platform, '--arch', arch], { cwd: root });
      expect((await readdir(output)).sort()).toEqual(names.sort());
      expect((await readdir(output)).join('\n')).not.toContain('Modulo');
    }
  });

  it('rejects any stale or unexpected installer before checksums are published', async () => {
    const directory = await artifactDirectory();
    await writeFile(path.join(directory, 'Fate-UI-0.4.9-Windows-x64.exe'), 'stale');

    await expect(execFileAsync(process.execPath, [script, 'checksums', '--source', directory], { cwd: root }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Release artifact set mismatch') });
  });

  it('reports a clean tag, exact titled release, and stable classification', async () => {
    const metadata = async (field) => (await execFileAsync(process.execPath, [script, 'metadata', '--field', field], { cwd: root })).stdout.trim();
    await expect(metadata('version')).resolves.toBe('1.0.0');
    await expect(metadata('tag')).resolves.toBe('v1.0.0');
    await expect(metadata('display-version')).resolves.toBe('V1.0.0 - Modulo');
    await expect(metadata('is-prerelease')).resolves.toBe('false');
    await expect(execFileAsync(process.execPath, [script, 'validate-tag', '--tag', 'v1.0.0'], { cwd: root })).resolves.toMatchObject({
      stdout: expect.stringContaining('title V1.0.0 - Modulo'),
    });
    await expect(execFileAsync(process.execPath, [script, 'validate-tag', '--tag', 'V1.0.0 - Modulo'], { cwd: root }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('does not match package version 1.0.0') });
  });

  it('prints a safe gh latest flag from the current package and published tag', async () => {
    const policy = async (...args) => (await execFileAsync(process.execPath, [script, 'latest-policy', ...args], { cwd: root })).stdout.trim();
    await expect(policy()).resolves.toBe('--latest');
    await expect(policy('--published-tag', 'v0.9.9')).resolves.toBe('--latest');
    await expect(policy('--published-tag', 'v0.9.9-beta4')).resolves.toBe('--latest');
    await expect(policy('--published-tag', 'v1.0.1-beta1')).resolves.toBe('--latest=false');
    await expect(policy('--published-tag', 'v1.0.0')).resolves.toBe('--latest=false');
    await expect(policy('--published-tag', 'v1.1.0')).resolves.toBe('--latest=false');
    await expect(policy('--published-tag', 'V1.0.0 - Old Title')).rejects.toMatchObject({
      stderr: expect.stringContaining('Published release tag is invalid'),
    });
  });

  it('keeps computed latest policy off drafts and verifies latest through gh release list', async () => {
    const workflow = await readFile(path.join(root, '.github', 'workflows', 'cross-platform.yml'), 'utf8');
    const lines = workflow.split(/\r?\n/u).map((line) => line.trim());
    const draftCreates = lines.filter((line) => line.startsWith('gh release create ') && line.includes(' --draft '));
    const draftEdits = lines.filter((line) => line.startsWith('gh release edit ') && line.includes(' --draft '));
    const publications = lines.filter((line) => line.startsWith('gh release edit ') && line.includes(' --draft=false '));
    expect(draftCreates).toHaveLength(2);
    expect(draftEdits).toHaveLength(2);
    expect(publications).toHaveLength(2);
    expect([...draftCreates, ...draftEdits].every((line) => line.includes(' --latest=false '))).toBe(true);
    expect([...draftCreates, ...draftEdits].some((line) => line.includes('$latest_flag'))).toBe(false);
    expect(publications.every((line) => line.includes('"$latest_flag"'))).toBe(true);
    expect(workflow).not.toMatch(/gh release view[^\n]+--json[^\n]+isLatest/u);
    expect(workflow.match(/gh release list --limit 100 --json tagName,isLatest/gu)).toHaveLength(2);
  });
});
