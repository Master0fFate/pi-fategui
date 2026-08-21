import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const YT_DLP_VERSION = '2026.08.19';
const RELEASE_ROOT = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}`;
const SOURCE_ROOT = `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${YT_DLP_VERSION}`;
const CHECKSUMS_SHA256 = 'a63701f30755cb4d9317950d69703e9d751d490cb1b7059e1bb501a353fe7dcb';
const MAX_BINARY_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export const YT_DLP_LICENSES = Object.freeze([
  {
    source: 'LICENSE',
    output: 'yt-dlp-LICENSE',
    sha256: '7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c',
  },
  {
    source: 'THIRD_PARTY_LICENSES.txt',
    output: 'yt-dlp-THIRD_PARTY_LICENSES.txt',
    sha256: '472aefe951c7db35e1657c1d13fd337140511ed6f2b329205105ad441c5a02b7',
  },
]);

const TARGETS = new Map([
  ['win32/x64', { asset: 'yt-dlp.exe', output: 'yt-dlp.exe', sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a' }],
  ['win32/arm64', { asset: 'yt-dlp_arm64.exe', output: 'yt-dlp.exe', sha256: '05b438997bafc3affdfda9d041353c9d73e04dc842207254b655b0887c4445b0' }],
  ['win32/ia32', { asset: 'yt-dlp_x86.exe', output: 'yt-dlp.exe', sha256: 'a8f91bd41452506bc81ebd2f369b186fea0ee7075413ba00cef9fd346a0a5d0c' }],
  ['linux/x64', { asset: 'yt-dlp_linux', output: 'yt-dlp', sha256: '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a' }],
  ['linux/arm64', { asset: 'yt-dlp_linux_aarch64', output: 'yt-dlp', sha256: 'b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc' }],
  ['darwin/x64', { asset: 'yt-dlp_macos', output: 'yt-dlp', sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202' }],
  ['darwin/arm64', { asset: 'yt-dlp_macos', output: 'yt-dlp', sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202' }],
]);

const PLATFORM_ALIASES = new Map([
  ['win', 'win32'], ['windows', 'win32'], ['win32', 'win32'],
  ['mac', 'darwin'], ['macos', 'darwin'], ['darwin', 'darwin'],
  ['linux', 'linux'],
]);
const ARCH_ALIASES = new Map([
  ['x64', 'x64'], ['amd64', 'x64'], ['x86_64', 'x64'],
  ['arm64', 'arm64'], ['aarch64', 'arm64'],
  ['ia32', 'ia32'], ['x86', 'ia32'],
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedPlatform(value) {
  const normalized = String(value).trim().toLocaleLowerCase();
  return PLATFORM_ALIASES.get(normalized) ?? normalized;
}

function normalizedArch(value) {
  const normalized = String(value).trim().toLocaleLowerCase();
  return ARCH_ALIASES.get(normalized) ?? normalized;
}

export function resolveYtDlpTarget(platform = process.platform, arch = process.arch) {
  const targetPlatform = normalizedPlatform(platform);
  const targetArch = normalizedArch(arch);
  const key = `${targetPlatform}/${targetArch}`;
  const target = TARGETS.get(key);
  if (!target) throw new Error(`[yt-dlp] no pinned standalone executable is configured for ${key}`);
  return Object.freeze({ key, platform: targetPlatform, arch: targetArch, ...target });
}

export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/u)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/iu.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLocaleLowerCase());
  }
  return sums;
}

async function fetchPinned(url, expectedSha256, maximumBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': `Fate-UI-build/${YT_DLP_VERSION}` },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > maximumBytes) throw new Error(`response exceeds ${maximumBytes} bytes`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maximumBytes) throw new Error(`received ${bytes.length} bytes; expected 1-${maximumBytes}`);
    const actual = sha256(bytes);
    if (actual !== expectedSha256) throw new Error(`SHA-256 mismatch (expected ${expectedSha256}, received ${actual})`);
    return bytes;
  } catch (error) {
    throw new Error(`[yt-dlp] could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function fileMatches(filePath, expectedSha256) {
  try {
    return sha256(await readFile(filePath)) === expectedSha256;
  } catch {
    return false;
  }
}

async function prepared(targetDirectory, target) {
  try {
    const manifest = JSON.parse(await readFile(path.join(targetDirectory, 'yt-dlp-manifest.json'), 'utf8'));
    if (
      manifest.schemaVersion !== 1
      || manifest.version !== YT_DLP_VERSION
      || manifest.platform !== target.platform
      || manifest.arch !== target.arch
      || manifest.asset !== target.asset
      || manifest.output !== target.output
      || manifest.sha256 !== target.sha256
    ) return false;
    if (!await fileMatches(path.join(targetDirectory, target.output), target.sha256)) return false;
    for (const license of YT_DLP_LICENSES) {
      if (!await fileMatches(path.join(targetDirectory, license.output), license.sha256)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function prepareYtDlp({
  platform = process.platform,
  arch = process.arch,
  outputDirectory = path.resolve('build/vendor/yt-dlp'),
} = {}) {
  const target = resolveYtDlpTarget(platform, arch);
  const destination = path.resolve(outputDirectory);
  if (await prepared(destination, target)) {
    console.log(`[yt-dlp] ${YT_DLP_VERSION} ${target.key} already verified at ${destination}`);
    return { ...target, version: YT_DLP_VERSION, outputDirectory: destination, cached: true };
  }

  const sumsBytes = await fetchPinned(`${RELEASE_ROOT}/SHA2-256SUMS`, CHECKSUMS_SHA256, MAX_TEXT_BYTES);
  const publishedHash = parseSha256Sums(sumsBytes.toString('utf8')).get(target.asset);
  if (publishedHash !== target.sha256) {
    throw new Error(`[yt-dlp] pinned hash for ${target.asset} does not match the signed release checksum list`);
  }

  const parent = path.dirname(destination);
  const staging = path.join(parent, `.yt-dlp-${process.pid}-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    const binary = await fetchPinned(`${RELEASE_ROOT}/${target.asset}`, target.sha256, MAX_BINARY_BYTES);
    await writeFile(path.join(staging, target.output), binary, { mode: 0o755 });
    if (process.platform !== 'win32') await chmod(path.join(staging, target.output), 0o755);

    for (const license of YT_DLP_LICENSES) {
      const bytes = await fetchPinned(`${SOURCE_ROOT}/${license.source}`, license.sha256, MAX_TEXT_BYTES);
      await writeFile(path.join(staging, license.output), bytes);
    }

    const manifest = {
      schemaVersion: 1,
      version: YT_DLP_VERSION,
      platform: target.platform,
      arch: target.arch,
      asset: target.asset,
      output: target.output,
      sha256: target.sha256,
      source: `${RELEASE_ROOT}/${target.asset}`,
      licenses: YT_DLP_LICENSES.map(({ source, output, sha256: licenseSha256 }) => ({ source, output, sha256: licenseSha256 })),
    };
    await writeFile(path.join(staging, 'yt-dlp-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await rm(destination, { recursive: true, force: true });
    await mkdir(parent, { recursive: true });
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  console.log(`[yt-dlp] ${YT_DLP_VERSION} ${target.key} verified for packaging at ${destination}`);
  return { ...target, version: YT_DLP_VERSION, outputDirectory: destination, cached: false };
}

function parseCli(args) {
  let platform = process.platform;
  let arch = process.arch;
  let outputDirectory = path.resolve('build/vendor/yt-dlp');
  let describe = false;
  const valueAfter = (option, index) => {
    const value = args[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--platform') platform = valueAfter(argument, index++);
    else if (argument === '--arch') arch = valueAfter(argument, index++);
    else if (argument === '--output') outputDirectory = path.resolve(valueAfter(argument, index++));
    else if (argument === '--describe') describe = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return { platform, arch, outputDirectory, describe };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.describe) {
      console.log(JSON.stringify({ version: YT_DLP_VERSION, ...resolveYtDlpTarget(options.platform, options.arch) }, null, 2));
    } else {
      await prepareYtDlp(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
