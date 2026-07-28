import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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
  return manifest.version;
}

async function stage(args) {
  const source = path.resolve(root, option(args, '--source', 'release'));
  const output = path.resolve(root, option(args, '--output', 'artifacts'));
  const platform = option(args, '--platform', process.platform);
  const arch = option(args, '--arch', process.arch);
  const version = await packageVersion();
  const expected = platform === 'win32'
    ? [`Fate-UI-${version}-Windows-${arch}.exe`]
    : platform === 'darwin'
      ? [`Fate-UI-${version}-macOS-${arch}.dmg`, `Fate-UI-${version}-macOS-${arch}.pkg`]
      : platform === 'linux'
        ? [`Fate-UI-${version}-Linux-${arch}.AppImage`, `Fate-UI-${version}-Linux-${arch}.deb`]
        : [];
  if (expected.length === 0) throw new Error(`Unsupported release platform: ${platform}`);

  await mkdir(output, { recursive: true });
  for (const fileName of expected) {
    let sourceName = fileName;
    if (platform === 'linux' && arch === 'x64') {
      if (fileName.endsWith('.AppImage')) sourceName = fileName.replace('-x64.AppImage', '-x86_64.AppImage');
      if (fileName.endsWith('.deb')) sourceName = fileName.replace('-x64.deb', '-amd64.deb');
    }
    const from = path.join(source, sourceName);
    const metadata = await stat(from).catch(() => null);
    if (!metadata?.isFile() || metadata.size === 0) throw new Error(`Missing release artifact: ${from}`);
    await copyFile(from, path.join(output, fileName));
  }
  process.stdout.write(`Staged ${expected.length} ${platform}/${arch} release artifact(s).\n`);
}

async function checksums(args) {
  const source = path.resolve(root, option(args, '--source', 'artifacts'));
  const fileNames = (await readdir(source)).filter((name) => name !== 'SHA256SUMS').sort((left, right) => left.localeCompare(right, 'en'));
  if (fileNames.length === 0) throw new Error(`No release artifacts found in ${source}.`);
  const lines = [];
  for (const fileName of fileNames) {
    const filePath = path.join(source, fileName);
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size === 0) throw new Error(`Invalid release artifact: ${filePath}`);
    const hash = createHash('sha256').update(await readFile(filePath)).digest('hex');
    lines.push(`${hash}  ${fileName}`);
  }
  await writeFile(path.join(source, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`Wrote SHA256SUMS for ${lines.length} release artifact(s).\n`);
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
