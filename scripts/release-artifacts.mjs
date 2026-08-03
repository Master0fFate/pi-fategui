import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

async function packageVersion() {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error('package.json has no valid version.');
  const productionVersion = await readFile(path.join(root, 'PRODVER'), 'utf8');
  if (productionVersion !== manifest.version) {
    throw new Error(`PRODVER (${JSON.stringify(productionVersion)}) does not exactly match package version ${manifest.version}.`);
  }
  return manifest.version;
}

function platformArtifacts(version, platform, arch) {
  if (platform === 'win32') return [`Fate-UI-${version}-Windows-${arch}.exe`];
  if (platform === 'darwin') return [`Fate-UI-${version}-macOS-${arch}.dmg`, `Fate-UI-${version}-macOS-${arch}.pkg`];
  if (platform === 'linux') return [`Fate-UI-${version}-Linux-${arch}.AppImage`, `Fate-UI-${version}-Linux-${arch}.deb`];
  throw new Error(`Unsupported release platform: ${platform}`);
}

function releaseArtifacts(version) {
  return [
    ...platformArtifacts(version, 'win32', 'x64'),
    ...platformArtifacts(version, 'darwin', 'arm64'),
    ...platformArtifacts(version, 'darwin', 'x64'),
    ...platformArtifacts(version, 'linux', 'x64'),
  ].sort();
}

async function regularNonemptyFile(filePath) {
  const metadata = await lstat(filePath).catch(() => null);
  return metadata?.isFile() && !metadata.isSymbolicLink() && metadata.size > 0 ? metadata : null;
}

async function assertReleaseArtifactSet(source, version) {
  const entries = await readdir(source, { withFileTypes: true }).catch(() => []);
  const actual = entries.map((entry) => entry.name).filter((name) => name !== 'SHA256SUMS').sort();
  const expected = releaseArtifacts(version);
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`Release artifact set mismatch. Expected ${expected.join(', ')}; received ${actual.join(', ') || '(none)'}.`);
  }
  for (const fileName of expected) {
    const filePath = path.join(source, fileName);
    if (!await regularNonemptyFile(filePath)) throw new Error(`Invalid release artifact: ${filePath}`);
  }
  return expected;
}

async function sha256File(filePath) {
  const before = await regularNonemptyFile(filePath);
  if (!before) throw new Error(`Invalid release artifact: ${filePath}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  const after = await regularNonemptyFile(filePath);
  if (!after || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`Release artifact changed while hashing: ${filePath}`);
  }
  return hash.digest('hex');
}

async function stage(args) {
  const source = path.resolve(root, option(args, '--source', 'release'));
  const output = path.resolve(root, option(args, '--output', 'artifacts'));
  const platform = option(args, '--platform', process.platform);
  const arch = option(args, '--arch', process.arch);
  const version = await packageVersion();
  const expected = platformArtifacts(version, platform, arch);
  if (source === output) throw new Error('Release staging source and output directories must be different.');

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const fileName of expected) {
    let sourceName = fileName;
    if (platform === 'linux' && arch === 'x64') {
      if (fileName.endsWith('.AppImage')) sourceName = fileName.replace('-x64.AppImage', '-x86_64.AppImage');
      if (fileName.endsWith('.deb')) sourceName = fileName.replace('-x64.deb', '-amd64.deb');
    }
    const from = path.join(source, sourceName);
    if (!await regularNonemptyFile(from)) throw new Error(`Missing release artifact: ${from}`);
    await copyFile(from, path.join(output, fileName));
  }
  process.stdout.write(`Staged ${expected.length} ${platform}/${arch} release artifact(s).\n`);
}

async function checksums(args) {
  const source = path.resolve(root, option(args, '--source', 'artifacts'));
  const version = await packageVersion();
  const fileNames = await assertReleaseArtifactSet(source, version);
  const lines = [];
  for (const fileName of fileNames) {
    lines.push(`${await sha256File(path.join(source, fileName))}  ${fileName}`);
  }
  await writeFile(path.join(source, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`Verified ${fileNames.length} release artifacts and wrote SHA256SUMS.\n`);
}

async function validateTag(args) {
  const tag = option(args, '--tag');
  if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) throw new Error(`Release tag is not strict SemVer: ${tag ?? '(missing)'}`);
  const version = await packageVersion();
  if (tag.slice(1) !== version) throw new Error(`Release tag ${tag} does not match package version ${version}.`);
  process.stdout.write(`Release tag ${tag} matches package version ${version}.\n`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'stage') await stage(args);
  else if (command === 'checksums') await checksums(args);
  else if (command === 'validate-tag') await validateTag(args);
  else throw new Error('Usage: node scripts/release-artifacts.mjs <stage|checksums|validate-tag> [options]');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
