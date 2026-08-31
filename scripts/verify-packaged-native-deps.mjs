import * as asar from '@electron/asar';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YT_DLP_LICENSES, YT_DLP_VERSION, resolveYtDlpTarget } from './prepare-yt-dlp.mjs';

const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];
const TRANSCRIBE_TARGETS = new Map([
  ['darwin/arm64', 'darwin-arm64-metal'],
  ['darwin/x64', 'darwin-x64-cpu'],
  ['linux/arm64', 'linux-arm64-cpu-vulkan'],
  ['linux/x64', 'linux-x64-cpu-vulkan'],
  ['win32/x64', 'win32-x64-cpu-vulkan'],
]);
const PLATFORM_ALIASES = new Map([
  ['darwin', 'darwin'], ['mac', 'darwin'], ['macos', 'darwin'],
  ['linux', 'linux'],
  ['win32', 'win32'], ['windows', 'win32'], ['win', 'win32'],
]);
const ARCH_ALIASES = new Map([
  ['x64', 'x64'], ['amd64', 'x64'], ['x86_64', 'x64'],
  ['arm64', 'arm64'], ['aarch64', 'arm64'],
  ['ia32', 'ia32'], ['x86', 'ia32'],
  ['armv7l', 'armv7l'], ['arm', 'armv7l'],
  ['universal', 'universal'],
]);

function normalize(relativePath) {
  const clean = String(relativePath).replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
  if (!clean) return '';
  const normalized = path.posix.normalize(clean);
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(`[native-deps] unsafe packaged path: ${relativePath}`);
  return normalized;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function walkFiles(root) {
  const files = new Map();
  const issues = [];
  if (!existsSync(root)) return { files, issues };
  const realRoot = realpathSync(root);

  const visit = (directory, relative, ancestors) => {
    let realDirectory;
    try {
      realDirectory = realpathSync(directory);
    } catch (error) {
      issues.push(`${normalize(relative)} (unreadable directory: ${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (!isWithin(realRoot, realDirectory)) {
      issues.push(`${normalize(relative)} (symlink escapes packaged root)`);
      return;
    }
    if (ancestors.has(realDirectory)) {
      issues.push(`${normalize(relative)} (symlink cycle)`);
      return;
    }
    const nextAncestors = new Set(ancestors).add(realDirectory);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      issues.push(`${normalize(relative)} (unreadable directory: ${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    for (const entry of entries) {
      const nextRelative = normalize(path.posix.join(relative.replaceAll('\\', '/'), entry.name));
      const candidate = path.join(directory, entry.name);
      try {
        const resolved = entry.isSymbolicLink() ? realpathSync(candidate) : candidate;
        if (entry.isSymbolicLink() && !isWithin(realRoot, resolved)) {
          issues.push(`${nextRelative} (symlink escapes packaged root)`);
          continue;
        }
        const stats = statSync(candidate);
        if (stats.isDirectory()) visit(candidate, nextRelative, nextAncestors);
        else if (stats.isFile()) files.set(nextRelative, { path: candidate, size: stats.size });
      } catch (error) {
        issues.push(`${nextRelative} (unreadable entry: ${error instanceof Error ? error.message : String(error)})`);
      }
    }
  };

  visit(root, '', new Set());
  return { files, issues };
}

function findResourcesDir(appOutDir) {
  const direct = path.join(appOutDir, 'resources');
  if (existsSync(path.join(direct, 'app.asar')) || existsSync(path.join(direct, 'app'))) return direct;

  const queue = [{ directory: appOutDir, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > 4 || !existsSync(current.directory)) continue;
    for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(current.directory, entry.name);
      if (entry.name === 'Resources' && (existsSync(path.join(directory, 'app.asar')) || existsSync(path.join(directory, 'app')))) return directory;
      queue.push({ directory, depth: current.depth + 1 });
    }
  }
  throw new Error(`[native-deps] packaged resources were not found under ${appOutDir}`);
}

function createArtifactIndex(appOutDir) {
  const resourcesDir = findResourcesDir(path.resolve(appOutDir));
  const archivePath = path.join(resourcesDir, 'app.asar');
  const unpackedRoot = `${archivePath}.unpacked`;
  const appRoot = path.join(resourcesDir, 'app');
  const archivePaths = new Map();
  if (existsSync(archivePath)) {
    for (const listed of asar.listPackage(archivePath)) {
      const key = normalize(listed);
      if (key) archivePaths.set(key, listed.replace(/^[\\/]+/u, ''));
    }
  }
  const unpacked = walkFiles(unpackedRoot);
  const app = walkFiles(appRoot);
  const archiveInfoCache = new Map();
  const underCache = new Map();

  const archiveInfo = (key) => {
    if (!archivePaths.has(key)) return null;
    if (archiveInfoCache.has(key)) return archiveInfoCache.get(key);
    try {
      const info = asar.statFile(archivePath, archivePaths.get(key), false);
      const value = 'files' in info || 'link' in info ? null : info;
      archiveInfoCache.set(key, value);
      return value;
    } catch {
      archiveInfoCache.set(key, null);
      return null;
    }
  };
  const physical = (key) => unpacked.files.get(key) ?? app.files.get(key) ?? null;
  const has = (relativePath, unpackedOnly = false) => {
    const key = normalize(relativePath);
    if (physical(key)) return true;
    if (unpackedOnly) return false;
    const info = archiveInfo(key);
    return Boolean(info && !info.unpacked);
  };
  const under = (prefix, unpackedOnly = false) => {
    const normalizedPrefix = `${normalize(prefix)}/`;
    const cacheKey = `${unpackedOnly ? 'u' : 'a'}:${normalizedPrefix}`;
    const cached = underCache.get(cacheKey);
    if (cached) return cached;
    const result = new Set();
    for (const source of [unpacked.files, app.files]) {
      for (const entry of source.keys()) if (entry.startsWith(normalizedPrefix)) result.add(entry);
    }
    if (!unpackedOnly) {
      for (const entry of archivePaths.keys()) {
        if (entry.startsWith(normalizedPrefix)) {
          const info = archiveInfo(entry);
          if (info && !info.unpacked) result.add(entry);
        }
      }
    }
    const entries = [...result].sort();
    underCache.set(cacheKey, entries);
    return entries;
  };
  const size = (relativePath, unpackedOnly = false) => {
    const key = normalize(relativePath);
    const local = physical(key);
    if (local) return local.size;
    if (unpackedOnly) return null;
    const info = archiveInfo(key);
    return info && !info.unpacked ? Number(info.size) : null;
  };
  const read = (relativePath, { unpackedOnly = false, maximumBytes = 512_000 } = {}) => {
    const key = normalize(relativePath);
    const local = physical(key);
    const bytes = size(key, unpackedOnly);
    if (bytes === null) throw new Error(`missing ${key}`);
    if (bytes > maximumBytes) throw new Error(`${key} exceeds the ${maximumBytes.toLocaleString()}-byte metadata limit`);
    if (local) return readFileSync(local.path);
    if (unpackedOnly) throw new Error(`missing unpacked ${key}`);
    return asar.extractFile(archivePath, archivePaths.get(key));
  };

  return {
    resourcesDir,
    archivePath,
    has,
    under,
    size,
    read,
    physicalPath: (relativePath) => physical(normalize(relativePath))?.path ?? null,
    issues: [...unpacked.issues, ...app.issues],
  };
}

function requireFile(index, errors, relativePath, { unpacked = false, minimumBytes = 1 } = {}) {
  const key = normalize(relativePath);
  if (!index.has(key, unpacked)) {
    errors.push(`${key}${unpacked ? ' (must be unpacked)' : ''}`);
    return false;
  }
  const bytes = index.size(key, unpacked);
  if (bytes === null || bytes < minimumBytes) {
    errors.push(`${key} (expected at least ${minimumBytes.toLocaleString()} bytes${unpacked ? ' unpacked' : ''})`);
    return false;
  }
  return true;
}

function requireDirectoryContent(index, errors, relativePath, { unpacked = false } = {}) {
  if (index.under(relativePath, unpacked).length === 0) {
    errors.push(`${normalize(relativePath)}/**${unpacked ? ' (must be unpacked)' : ''}`);
    return false;
  }
  return true;
}

function readJson(index, errors, relativePath, { unpacked = false } = {}) {
  try {
    return JSON.parse(index.read(relativePath, { unpackedOnly: unpacked }).toString('utf8'));
  } catch (error) {
    errors.push(`${normalize(relativePath)} (unreadable JSON: ${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

function validatePackageMetadata(errors, metadata, expectedName, relativePath, { platform, arch, version } = {}) {
  if (!metadata || typeof metadata !== 'object') return;
  if (metadata.name !== expectedName) errors.push(`${relativePath} (expected package name ${expectedName})`);
  if (typeof metadata.version !== 'string' || !metadata.version.trim()) errors.push(`${relativePath} (missing package version)`);
  if (version && metadata.version !== version) errors.push(`${relativePath} (version ${String(metadata.version)} does not match ${version})`);
  if (typeof metadata.license !== 'string' || !metadata.license.trim()) errors.push(`${relativePath} (missing license metadata)`);
  if (platform && Array.isArray(metadata.os) && !metadata.os.includes(platform)) errors.push(`${relativePath} (does not declare target OS ${platform})`);
  if (arch && Array.isArray(metadata.cpu) && !metadata.cpu.includes(arch)) errors.push(`${relativePath} (does not declare target CPU ${arch})`);
}

function readAt(fileDescriptor, length, position) {
  const buffer = Buffer.alloc(length);
  const bytes = readSync(fileDescriptor, buffer, 0, length, position);
  return buffer.subarray(0, bytes);
}

function sha256File(filePath) {
  const descriptor = openSync(filePath, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytes = 0;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

function packagedResource(resourcesDir, errors, relativePath, minimumBytes = 1) {
  const root = realpathSync(resourcesDir);
  const candidate = path.resolve(root, relativePath);
  try {
    const canonical = realpathSync(candidate);
    if (!isWithin(root, canonical)) {
      errors.push(`${relativePath} (resource escapes the packaged resources directory)`);
      return null;
    }
    const stats = statSync(canonical);
    if (!stats.isFile() || stats.size < minimumBytes) {
      errors.push(`${relativePath} (expected a file of at least ${minimumBytes.toLocaleString()} bytes)`);
      return null;
    }
    return canonical;
  } catch (error) {
    errors.push(`${relativePath} (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

function inspectBinary(filePath) {
  const descriptor = openSync(filePath, 'r');
  try {
    const header = readAt(descriptor, 64, 0);
    if (header.length >= 20 && header[0] === 0x7f && header.subarray(1, 4).toString('ascii') === 'ELF') {
      const littleEndian = header[5] === 1;
      const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
      const arch = new Map([[3, 'ia32'], [40, 'armv7l'], [62, 'x64'], [183, 'arm64']]).get(machine);
      return { format: 'ELF', arch: arch ?? `machine-${machine}` };
    }
    if (header.length >= 64 && header[0] === 0x4d && header[1] === 0x5a) {
      const peOffset = header.readUInt32LE(0x3c);
      if (peOffset > 1_048_576) return { format: 'PE', arch: 'invalid-header' };
      const pe = readAt(descriptor, 6, peOffset);
      if (pe.length < 6 || pe.readUInt32LE(0) !== 0x00004550) return { format: 'PE', arch: 'invalid-header' };
      const machine = pe.readUInt16LE(4);
      const arch = new Map([[0x014c, 'ia32'], [0x8664, 'x64'], [0xaa64, 'arm64']]).get(machine);
      return { format: 'PE', arch: arch ?? `machine-${machine.toString(16)}` };
    }
    if (header.length >= 8) {
      const littleMagic = header.readUInt32LE(0);
      const bigMagic = header.readUInt32BE(0);
      const little = littleMagic === 0xfeedface || littleMagic === 0xfeedfacf;
      const big = bigMagic === 0xfeedface || bigMagic === 0xfeedfacf;
      if (little || big) {
        const cpu = little ? header.readInt32LE(4) : header.readInt32BE(4);
        const arch = new Map([[7, 'ia32'], [0x01000007, 'x64'], [12, 'armv7l'], [0x0100000c, 'arm64']]).get(cpu);
        return { format: 'Mach-O', arch: arch ?? `cpu-${cpu}` };
      }
    }
    return { format: 'unknown', arch: 'unknown' };
  } finally {
    closeSync(descriptor);
  }
}

function requireTargetBinary(index, errors, relativePath, platform, arch) {
  if (!requireFile(index, errors, relativePath, { unpacked: true, minimumBytes: 512 })) return false;
  const physicalPath = index.physicalPath(relativePath);
  if (!physicalPath) {
    errors.push(`${normalize(relativePath)} (native binary is not physically unpacked)`);
    return false;
  }
  try {
    const binary = inspectBinary(physicalPath);
    if (binary.arch !== arch) {
      errors.push(`${normalize(relativePath)} (${binary.format} architecture ${binary.arch}, expected ${arch})`);
      return false;
    }
  } catch (error) {
    errors.push(`${normalize(relativePath)} (unreadable native binary: ${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
  return true;
}

function normalizePlatform(platform) {
  return PLATFORM_ALIASES.get(String(platform).toLocaleLowerCase()) ?? String(platform).toLocaleLowerCase();
}

function normalizeArch(arch) {
  const raw = typeof arch === 'number' ? ARCH_NAMES[arch] ?? String(arch) : String(arch).toLocaleLowerCase();
  return ARCH_ALIASES.get(raw) ?? raw;
}

export function nodePtyRuntimeRelativeBases(platform, arch) {
  const targetPlatform = normalizePlatform(platform);
  const targetArch = normalizeArch(arch);
  return ['build/Release', 'build/Debug', `prebuilds/${targetPlatform}-${targetArch}`];
}

export function verifyPackagedNativeDeps({ appOutDir, platform, arch }) {
  const targetPlatform = normalizePlatform(platform);
  const targetArch = normalizeArch(arch);
  const targetKey = `${targetPlatform}/${targetArch}`;
  const transcribeTuple = TRANSCRIBE_TARGETS.get(targetKey);
  if (!transcribeTuple) throw new Error(`[native-deps] transcribe-cpp has no packaged runtime for ${targetKey}`);

  const index = createArtifactIndex(appOutDir);
  const errors = [...index.issues];

  requireFile(index, errors, 'package.json');
  requireFile(index, errors, 'LICENSE', { minimumBytes: 10_000 });
  requireFile(index, errors, 'NOTICE', { minimumBytes: 500 });
  const hasThirdPartyNotices = requireFile(index, errors, 'THIRD_PARTY_NOTICES.md', { minimumBytes: 1_000 });
  requireFile(index, errors, 'FONT_LICENSES.md');
  const appPackage = readJson(index, errors, 'package.json');
  validatePackageMetadata(errors, appPackage, 'pi-fategui', 'package.json');
  if (hasThirdPartyNotices) {
    try {
      const notices = index.read('THIRD_PARTY_NOTICES.md').toString('utf8');
      for (const requiredText of [
        'MIT License',
        'Copyright (c) 2025 Mario Zechner',
        'Permission is hereby granted, free of charge',
        'THE SOFTWARE IS PROVIDED "AS IS"',
      ]) {
        if (!notices.includes(requiredText)) errors.push(`THIRD_PARTY_NOTICES.md (missing ${JSON.stringify(requiredText)})`);
      }
    } catch (error) {
      errors.push(`THIRD_PARTY_NOTICES.md (unreadable: ${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const ytDlpTarget = resolveYtDlpTarget(targetPlatform, targetArch);
  const ytDlpManifestPath = packagedResource(index.resourcesDir, errors, 'yt-dlp-manifest.json');
  const ytDlpBinaryPath = packagedResource(index.resourcesDir, errors, ytDlpTarget.output, 1_000_000);
  let ytDlpManifest = null;
  if (ytDlpManifestPath) {
    try {
      ytDlpManifest = JSON.parse(readFileSync(ytDlpManifestPath, 'utf8'));
      for (const [field, expected] of Object.entries({
        schemaVersion: 1,
        version: YT_DLP_VERSION,
        platform: targetPlatform,
        arch: targetArch,
        asset: ytDlpTarget.asset,
        output: ytDlpTarget.output,
        sha256: ytDlpTarget.sha256,
      })) {
        if (ytDlpManifest?.[field] !== expected) errors.push(`yt-dlp-manifest.json (${field} does not match the pinned ${targetKey} artifact)`);
      }
    } catch (error) {
      errors.push(`yt-dlp-manifest.json (unreadable JSON: ${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (ytDlpBinaryPath && targetPlatform !== 'darwin') {
    const binary = inspectBinary(ytDlpBinaryPath);
    if (binary.arch !== targetArch) errors.push(`${ytDlpTarget.output} (${binary.format} architecture ${binary.arch}, expected ${targetArch})`);
  }
  for (const license of YT_DLP_LICENSES) {
    const licensePath = packagedResource(index.resourcesDir, errors, license.output);
    if (licensePath && sha256File(licensePath) !== license.sha256) errors.push(`${license.output} (SHA-256 does not match yt-dlp ${YT_DLP_VERSION})`);
  }

  const transcribeJs = 'node_modules/transcribe-cpp';
  for (const relative of ['package.json', 'dist/index.js', 'dist/loader.js', 'dist/_generated.js', 'LICENSE']) {
    requireFile(index, errors, `${transcribeJs}/${relative}`);
  }
  const transcribeApiPackage = readJson(index, errors, `${transcribeJs}/package.json`);
  validatePackageMetadata(errors, transcribeApiPackage, 'transcribe-cpp', `${transcribeJs}/package.json`);

  const transcribeNative = `node_modules/@transcribe-cpp/${transcribeTuple}`;
  requireFile(index, errors, `${transcribeNative}/package.json`, { unpacked: true });
  requireFile(index, errors, `${transcribeNative}/contract.json`, { unpacked: true });
  const transcribePackage = readJson(index, errors, `${transcribeNative}/package.json`, { unpacked: true });
  validatePackageMetadata(errors, transcribePackage, `@transcribe-cpp/${transcribeTuple}`, `${transcribeNative}/package.json`, {
    platform: targetPlatform,
    arch: targetArch,
    version: typeof transcribeApiPackage?.version === 'string' ? transcribeApiPackage.version : undefined,
  });
  const contract = readJson(index, errors, `${transcribeNative}/contract.json`, { unpacked: true });
  if (contract?.version !== transcribeApiPackage?.version) errors.push(`${transcribeNative}/contract.json (version does not match transcribe-cpp)`);
  if (typeof contract?.header_hash !== 'string' || !/^[0-9a-f]{8,128}$/iu.test(contract.header_hash)) {
    errors.push(`${transcribeNative}/contract.json (missing valid header_hash)`);
  } else {
    try {
      const generated = index.read(`${transcribeJs}/dist/_generated.js`).toString('utf8');
      const expectedHash = /PUBLIC_HEADER_HASH\s*=\s*["']([0-9a-f]+)["']/iu.exec(generated)?.[1];
      if (!expectedHash || expectedHash !== contract.header_hash) errors.push(`${transcribeNative}/contract.json (header_hash does not match JS binding)`);
    } catch (error) {
      errors.push(`${transcribeJs}/dist/_generated.js (unreadable: ${error instanceof Error ? error.message : String(error)})`);
    }
  }
  for (const declared of Array.isArray(transcribePackage?.files) ? transcribePackage.files : []) {
    if (typeof declared !== 'string') {
      errors.push(`${transcribeNative}/package.json (non-string files entry)`);
      continue;
    }
    const candidate = `${transcribeNative}/${normalize(declared)}`;
    if (!index.has(candidate, true) && index.under(candidate, true).length === 0) {
      errors.push(`${candidate} (declared runtime asset is not unpacked)`);
    }
  }
  const transcribeFiles = index.under(transcribeNative, true);
  const nativeExtension = targetPlatform === 'win32' ? '.dll' : targetPlatform === 'darwin' ? '.dylib' : '.so';
  const nativeLibraryName = targetPlatform === 'win32' ? 'transcribe.dll' : targetPlatform === 'darwin' ? 'libtranscribe.dylib' : 'libtranscribe.so';
  requireTargetBinary(index, errors, `${transcribeNative}/${nativeLibraryName}`, targetPlatform, targetArch);
  if (!transcribeFiles.some((entry) => /\/licenses?\/(?:license|copying|notice)/iu.test(`/${entry}`))) errors.push(`${transcribeNative}/licenses/**`);
  const transcribeLibraries = transcribeFiles.filter((entry) => entry.toLocaleLowerCase().endsWith(nativeExtension));
  if (transcribeLibraries.length < 2) errors.push(`${transcribeNative} companion ${nativeExtension} runtime libraries`);
  for (const library of transcribeLibraries) requireTargetBinary(index, errors, library, targetPlatform, targetArch);

  const koffi = 'node_modules/koffi';
  for (const relative of ['package.json', 'index.js', 'index.cjs', 'src/koffi/index.js', 'src/koffi/src/static.js', 'LICENSE.txt']) {
    requireFile(index, errors, `${koffi}/${relative}`, { unpacked: true });
  }
  const koffiPackage = readJson(index, errors, `${koffi}/package.json`, { unpacked: true });
  validatePackageMetadata(errors, koffiPackage, 'koffi', `${koffi}/package.json`);
  const koffiNative = `node_modules/@koromix/koffi-${targetPlatform}-${targetArch}`;
  requireFile(index, errors, `${koffiNative}/package.json`, { unpacked: true });
  requireFile(index, errors, `${koffiNative}/index.js`, { unpacked: true });
  const koffiNativePackage = readJson(index, errors, `${koffiNative}/package.json`, { unpacked: true });
  validatePackageMetadata(errors, koffiNativePackage, `@koromix/koffi-${targetPlatform}-${targetArch}`, `${koffiNative}/package.json`, {
    platform: targetPlatform,
    arch: targetArch,
    version: typeof koffiPackage?.version === 'string' ? koffiPackage.version : undefined,
  });
  const koffiAddon = `${koffiNative}/${targetPlatform}_${targetArch}/koffi.node`;
  requireTargetBinary(index, errors, koffiAddon, targetPlatform, targetArch);
  const koffiAddons = index.under(koffiNative, true).filter((entry) => entry.toLocaleLowerCase().endsWith('.node'));

  const uiohook = 'node_modules/uiohook-napi';
  requireFile(index, errors, `${uiohook}/package.json`);
  requireFile(index, errors, `${uiohook}/dist/index.js`);
  const uiohookPackage = readJson(index, errors, `${uiohook}/package.json`);
  validatePackageMetadata(errors, uiohookPackage, 'uiohook-napi', `${uiohook}/package.json`);
  requireTargetBinary(index, errors, `${uiohook}/prebuilds/${targetPlatform}-${targetArch}/uiohook-napi.node`, targetPlatform, targetArch);
  // uiohook-napi resolves its .node through node-gyp-build at require time, so the
  // resolver must ship too (pure JS, may live inside the asar).
  requireFile(index, errors, 'node_modules/node-gyp-build/package.json');
  requireFile(index, errors, 'node_modules/node-gyp-build/index.js');

  const nodePty = 'node_modules/node-pty';
  for (const relative of ['package.json', 'LICENSE', 'lib/index.js', 'lib/utils.js']) requireFile(index, errors, `${nodePty}/${relative}`, { unpacked: true });
  const nodePtyPackage = readJson(index, errors, `${nodePty}/package.json`, { unpacked: true });
  validatePackageMetadata(errors, nodePtyPackage, 'node-pty', `${nodePty}/package.json`);
  // Match node-pty's runtime loader order exactly. A local build takes
  // precedence over a prebuild, so validating only the prebuild can miss the
  // helper binary the packaged app will actually execute.
  const nodePtyBases = nodePtyRuntimeRelativeBases(targetPlatform, targetArch)
    .map((relativeBase) => `${nodePty}/${relativeBase}`);
  const nodePtyBase = nodePtyBases.find((candidate) => index.has(`${candidate}/pty.node`, true));
  if (!nodePtyBase) errors.push(`${nodePtyBases.join(' or ')}/pty.node (must be unpacked)`);
  const nodePtyAddons = nodePtyBase
    ? index.under(nodePtyBase, true).filter((entry) => entry.toLocaleLowerCase().endsWith('.node'))
    : [];
  if (nodePtyBase) {
    if (targetPlatform === 'win32') {
      for (const relative of [
        'pty.node', 'conpty.node', 'conpty_console_list.node',
        'winpty.dll', 'winpty-agent.exe', 'conpty/conpty.dll', 'conpty/OpenConsole.exe',
      ]) requireTargetBinary(index, errors, `${nodePtyBase}/${relative}`, targetPlatform, targetArch);
    } else {
      requireTargetBinary(index, errors, `${nodePtyBase}/pty.node`, targetPlatform, targetArch);
      // node-pty builds and uses spawn-helper only on macOS. Linux passes the
      // path through its shared JS layer but the native implementation ignores it.
      if (targetPlatform === 'darwin') {
        const helper = `${nodePtyBase}/spawn-helper`;
        if (requireTargetBinary(index, errors, helper, targetPlatform, targetArch)) {
          const helperPath = index.physicalPath(helper);
          if (!helperPath || (statSync(helperPath).mode & 0o111) === 0) errors.push(`${helper} (must be executable)`);
        }
      }
    }
  }

  const piRuntime = 'node_modules/@earendil-works/pi-coding-agent';
  for (const relative of [
    'package.json',
    'dist/index.js',
    'dist/core/agent-session.js',
    'dist/core/agent-session-runtime.js',
    'dist/core/model-runtime.js',
    'dist/modes/interactive/theme/dark.json',
    'dist/modes/interactive/theme/light.json',
  ]) {
    requireFile(index, errors, `${piRuntime}/${relative}`);
  }
  const piPackage = readJson(index, errors, `${piRuntime}/package.json`);
  validatePackageMetadata(errors, piPackage, '@earendil-works/pi-coding-agent', `${piRuntime}/package.json`);

  const photon = 'node_modules/@silvia-odwyer/photon-node';
  for (const relative of ['package.json', 'LICENSE.md', 'photon_rs.js', 'photon_rs_bg.js']) requireFile(index, errors, `${photon}/${relative}`);
  requireFile(index, errors, `${photon}/photon_rs_bg.wasm`, { minimumBytes: 1_024 });
  const photonPackage = readJson(index, errors, `${photon}/package.json`);
  validatePackageMetadata(errors, photonPackage, '@silvia-odwyer/photon-node', `${photon}/package.json`);

  if (errors.length > 0) {
    throw new Error(`[native-deps] ${targetKey} package is incomplete:\n- ${errors.join('\n- ')}`);
  }

  const evidence = {
    appOutDir: path.resolve(appOutDir),
    resourcesDir: index.resourcesDir,
    platform: targetPlatform,
    arch: targetArch,
    transcribePackage: `@transcribe-cpp/${transcribeTuple}`,
    transcribeLibraries: transcribeLibraries.length,
    koffiPackage: `@koromix/koffi-${targetPlatform}-${targetArch}`,
    koffiAddons: koffiAddons.length,
    uiohookPrebuild: `${targetPlatform}-${targetArch}`,
    nodePtyBase,
    nodePtyAddons: nodePtyAddons.length,
    piRuntimeVersion: piPackage?.version,
    photonWasm: true,
    ytDlpVersion: ytDlpManifest?.version,
  };
  console.log(`[native-deps] ${targetKey} verified: transcribe-cpp + ${evidence.transcribeLibraries} target libraries; Koffi ${evidence.koffiAddons} addon; uiohook-napi ${evidence.uiohookPrebuild}; node-pty ${evidence.nodePtyAddons} addons; Pi ${String(evidence.piRuntimeVersion)} + Photon WASM; yt-dlp ${String(evidence.ytDlpVersion)}`);
  return evidence;
}

export async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    // PKG installation on Intel macOS can clear the executable bit inherited
    // from extraResources. Restore it on the bundled media helper before
    // electron-builder seals the app so every installer keeps it runnable.
    const resourcesDir = findResourcesDir(context.appOutDir);
    const ytDlp = path.join(resourcesDir, 'yt-dlp');
    if (!existsSync(ytDlp)) throw new Error('[native-deps] bundled yt-dlp is missing');
    chmodSync(ytDlp, 0o755);
    const nodePtyRoot = path.resolve(import.meta.dirname, '..', 'node_modules', 'node-pty');
    const relativeBases = nodePtyRuntimeRelativeBases('darwin', context.arch);
    for (const relativeBase of relativeBases) {
      if (!existsSync(path.join(nodePtyRoot, relativeBase, 'pty.node'))) continue;
      const source = path.join(nodePtyRoot, relativeBase, 'spawn-helper');
      if (!existsSync(source)) throw new Error(`[native-deps] node-pty ${relativeBase}/spawn-helper is missing`);
      const target = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'node-pty', relativeBase, 'spawn-helper');
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
      chmodSync(target, 0o755);
    }
  }
  return verifyPackagedNativeDeps({
    appOutDir: context.appOutDir,
    platform: context.electronPlatformName,
    arch: context.arch,
  });
}

export default afterPack;

function parseCli(args) {
  let appOutDir = null;
  let platform = process.platform;
  let arch = process.arch;
  const takeValue = (option, index) => {
    const value = args[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`[native-deps] ${option} requires a value`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--platform') platform = takeValue(argument, index++);
    else if (argument === '--arch') arch = takeValue(argument, index++);
    else if (argument === '--app-out-dir') appOutDir = takeValue(argument, index++);
    else if (!argument.startsWith('-') && appOutDir === null) appOutDir = argument;
    else throw new Error(`[native-deps] unknown argument: ${argument}`);
  }
  if (!appOutDir) throw new Error('Usage: node scripts/verify-packaged-native-deps.mjs <app-out-dir> [--platform win32] [--arch x64]');
  return { appOutDir, platform, arch };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyPackagedNativeDeps(parseCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
