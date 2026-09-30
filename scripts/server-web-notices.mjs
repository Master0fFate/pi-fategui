import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const font = /\.(?:woff2?|ttf|otf)$/iu;
const licenseName = /^(?:licen[cs]e|copying|copyright|notice|third[-_ ]?party[-_ ]?notices?)(?:[._ -]|$)/iu;
const cleanId = id => id.replace(/^\0/u, '').replace(/[?#].*$/u, '');

/** Capture emitted modules, CSS inputs, and assets from each browser/worker build. */
export function createWebLicenseCapture() {
  const records = [];
  let nextBuild = 0;
  return {
    records,
    plugin(kind = 'browser') {
      const build = `${kind}-${nextBuild++}`;
      return {
        name: `fate-web-license-capture-${build}`,
        apply: 'build',
        enforce: 'post',
        generateBundle: {
          order: 'post',
          handler(_options, bundle) {
            const cssModules = [...this.getModuleIds()].filter(id => /\.css(?:[?#]|$)/iu.test(id));
            const outputs = Object.values(bundle).map(output => ({
              file: output.fileName,
              type: output.type,
              sha256: hash(output.type === 'chunk' ? output.code : output.source),
              moduleIds: output.type === 'chunk' ? [...new Set(output.moduleIds ?? Object.keys(output.modules))] : [],
              originalFileNames: output.type === 'asset' ? [...output.originalFileNames ?? []] : [],
              importedCss: output.type === 'chunk' ? [...output.viteMetadata?.importedCss ?? []] : [],
            }));
            records.push({ build, kind, cssModules, outputs });
          },
        },
      };
    },
  };
}

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules') continue;
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Web package data contains a link: ${relative}`);
    if (entry.isDirectory()) result.push(...await files(absolute, relative));
    else if (entry.isFile()) result.push({ relative, absolute });
  }
  return result;
}

async function sourceLock(sourceRoot) {
  const sdk = await fs.realpath(path.join(sourceRoot, 'node_modules/@earendil-works/pi-coding-agent'));
  const yaml = createRequire(path.join(sdk, 'package.json'))('yaml');
  const bytes = await fs.readFile(path.join(sourceRoot, 'pnpm-lock.yaml'));
  return { value: yaml.parse(bytes.toString('utf8')), sha256: hash(bytes) };
}

/**
 * Browser licenses are build data, not extra Node runtime dependencies. Physical
 * module IDs and unmodified asset bytes establish the exact published owners.
 */
export async function writeWebNotices({ sourceRoot, webRoot, stageRoot, capture, lock: suppliedLock, strict = true }) {
  assert(capture.records.length, 'No browser/worker license capture was produced.');
  sourceRoot = await fs.realpath(sourceRoot);
  webRoot = await fs.realpath(webRoot);
  const modulesRoot = await fs.realpath(path.join(sourceRoot, 'node_modules'));
  const lock = suppliedLock ?? await sourceLock(sourceRoot);
  const packages = new Map();
  const owners = new Map();
  const generated = new Set();
  const supplementalCss = new Map();
  const emitted = new Map();

  async function owner(id) {
    const physical = cleanId(id);
    if (!path.isAbsolute(physical)) { generated.add(id); return null; }
    let file;
    try { file = await fs.realpath(physical); }
    catch (error) {
      if (id.startsWith('\0') && !physical.includes('node_modules')) { generated.add(id); return null; }
      throw new Error(`Captured browser source is unavailable: ${physical}`, { cause: error });
    }
    if (owners.has(file)) return owners.get(file);
    if (!within(modulesRoot, file)) {
      assert(within(sourceRoot, file), 'Browser source is outside the project and installed packages.');
      const value = { package: null, source: path.relative(sourceRoot, file).split(path.sep).join('/') };
      owners.set(file, value); return value;
    }
    let directory = path.dirname(file), metadata;
    while (within(modulesRoot, directory)) {
      try {
        const bytes = await fs.readFile(path.join(directory, 'package.json'));
        const manifest = JSON.parse(bytes.toString('utf8'));
        if (manifest.name && manifest.version) { metadata = { directory, manifest, bytes }; break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
    }
    assert(metadata, `Browser source has no owning installed package: ${file}`);
    const { manifest, bytes } = metadata;
    const key = `${manifest.name}@${manifest.version}`;
    const locked = lock.value.packages[key];
    assert(locked?.resolution?.integrity, `Bundled browser package lacks exact locked integrity: ${key}`);
    const manifestSha256 = hash(bytes);
    if (packages.has(key)) assert.equal(packages.get(key).manifestSha256, manifestSha256, `Bundled package metadata varies: ${key}`);
    else packages.set(key, { name: manifest.name, version: manifest.version, license: manifest.license ?? null,
      integrity: locked.resolution.integrity, manifestSha256, directory: metadata.directory, modules: new Set(), emitted: new Set() });
    const value = { package: key, source: path.relative(metadata.directory, file).split(path.sep).join('/') };
    packages.get(key).modules.add(value.source); owners.set(file, value); return value;
  }

  for (const record of capture.records) {
    for (const id of record.cssModules) {
      const value = await owner(id); if (value) supplementalCss.set(`${value.package ?? 'project'}:${value.source}`, value);
    }
    for (const output of record.outputs) {
      assert(!path.isAbsolute(output.file) && !output.file.split('/').includes('..'), 'Unsafe emitted browser asset path.');
      const previous = emitted.get(output.file);
      if (previous) assert.equal(previous.sha256, output.sha256, `Browser output changed between captured builds: ${output.file}`);
      const value = previous ?? { file: output.file, type: output.type, sha256: output.sha256, builds: new Set(), modules: new Map(), originals: new Set(), importedCss: new Set() };
      value.builds.add(record.build);
      for (const id of output.moduleIds) {
        const source = await owner(id); if (source) value.modules.set(`${source.package ?? 'project'}:${source.source}`, source);
      }
      for (const id of output.originalFileNames) value.originals.add(id);
      for (const css of output.importedCss) value.importedCss.add(css);
      emitted.set(output.file, value);
    }
  }
  for (const output of emitted.values()) for (const id of output.originals) {
    const source = await owner(path.isAbsolute(id) ? id : path.join(sourceRoot, id));
    if (source) output.modules.set(`${source.package ?? 'project'}:${source.source}`, source);
  }

  // Vite can omit originalFileNames for CSS-url assets. Match their complete bytes
  // against font files in the packages proved by JS/CSS capture, never by filename.
  const fontSources = new Map();
  const packageFiles = new Map();
  for (const [key, info] of packages) {
    const entries = await files(info.directory); packageFiles.set(key, entries);
    for (const entry of entries.filter(entry => font.test(entry.relative))) {
      const sha256 = hash(await fs.readFile(entry.absolute));
      const source = { package: key, source: entry.relative, sha256 };
      const matches = fontSources.get(sha256) ?? []; matches.push(source); fontSources.set(sha256, matches);
    }
  }
  const outputFiles = await files(webRoot);
  for (const entry of outputFiles) {
    // Vite's index rename is Fate project HTML, not a third-party binary.
    if (entry.relative === 'index.html') continue;
    const output = emitted.get(entry.relative);
    assert(output, `Shipped browser file was not captured: ${entry.relative}`);
    assert.equal(hash(await fs.readFile(entry.absolute)), output.sha256, `Captured browser output hash mismatch: ${entry.relative}`);
    if (font.test(entry.relative)) {
      const matches = fontSources.get(output.sha256) ?? [];
      assert(matches.length, `Shipped font has no exact captured package source: ${entry.relative}`);
      for (const source of matches) output.modules.set(`${source.package}:${source.source}`, source);
    }
  }
  // CSS generated from multiple imports may have a project-only original name.
  // Keep exact contributing CSS source IDs separately instead of inventing a
  // per-stylesheet split after minification.
  for (const output of emitted.values()) for (const source of output.modules.values()) {
    if (source.package) packages.get(source.package).emitted.add(output.file);
  }

  const destination = path.join(stageRoot, 'licenses/web');
  await fs.mkdir(destination, { recursive: true });
  const notices = ['# Bundled browser dependency notices\n', 'Published license and notice texts for the exact emitted browser and worker modules and font assets.\n'];
  const metadata = [];
  const unresolvedLicenseTexts = [];
  for (const [key, info] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const entries = packageFiles.get(key) ?? await files(info.directory);
    const licenseFiles = entries.filter(entry => licenseName.test(path.basename(entry.relative)) || entry.relative.split('/').slice(0, -1).some(part => /^licen[cs]es?$/iu.test(part)));
    // Some published packages place the complete permission text in README.
    // Preserve the original file bytes; a bare "MIT" heading is not license text.
    if (!licenseFiles.length) for (const entry of entries.filter(entry => /^readme(?:\.|$)/iu.test(path.basename(entry.relative)))) {
      const text = await fs.readFile(entry.absolute, 'utf8');
      if (/^#{1,6}\s+licen[cs]e\b/imu.test(text) && /Permission is hereby granted|TERMS AND CONDITIONS|Redistribution and use in source and binary forms/iu.test(text)) licenseFiles.push(entry);
    }
    const declarationOnly = !licenseFiles.length;
    if (declarationOnly) {
      unresolvedLicenseTexts.push({ package: key, declaration: info.license,
        reason: 'The published package has no full license/notice text. A manifest identifier or README declaration does not establish text coverage.' });
      for (const entry of entries.filter(entry => /^readme(?:\.|$)/iu.test(path.basename(entry.relative)))) {
        const text = await fs.readFile(entry.absolute, 'utf8');
        if (/^#{1,6}\s+licen[cs]e\b/imu.test(text)) licenseFiles.push(entry);
      }
    }
    const texts = [];
    const folder = key.replaceAll('/', '__');
    await fs.mkdir(path.join(destination, folder), { recursive: true });
    await fs.writeFile(path.join(destination, folder, 'package.json'), await fs.readFile(path.join(info.directory, 'package.json')));
    notices.push(`\n## ${key}: ${info.license ?? 'See published license text (no manifest declaration)'}\n`);
    if (declarationOnly) notices.push('\n**UNRESOLVED:** Only the published declaration is retained. Full license text coverage is pending.\n');
    for (const entry of licenseFiles) {
      const bytes = await fs.readFile(entry.absolute);
      assert(bytes.length, `Empty bundled license/notice text: ${key}/${entry.relative}`);
      const relative = path.posix.join('licenses/web', folder, entry.relative);
      await fs.mkdir(path.dirname(path.join(stageRoot, relative)), { recursive: true });
      await fs.writeFile(path.join(stageRoot, relative), bytes);
      texts.push({ source: entry.relative, file: relative, sha256: hash(bytes), declarationOnly });
      notices.push(`\n### ${entry.relative}\n\n${bytes.toString('utf8')}\n`);
    }
    metadata.push({ name: info.name, version: info.version, license: info.license, integrity: info.integrity,
      manifestSha256: info.manifestSha256, manifestFile: path.posix.join('licenses/web', folder, 'package.json'),
      licenseFiles: texts, noticeTextComplete: !declarationOnly, bundledSources: [...info.modules].sort(), emittedFiles: [...info.emitted].sort() });
  }
  const map = { schema: 1, sourceLockSha256: lock.sha256, noticeClosureComplete: unresolvedLicenseTexts.length === 0,
    unresolvedLicenseTexts, packages: metadata,
    outputs: [...emitted.values()].filter(output => outputFiles.some(entry => entry.relative === output.file)).sort((a, b) => a.file.localeCompare(b.file))
      .map(output => ({ file: output.file, type: output.type, sha256: output.sha256, builds: [...output.builds].sort(),
        sources: [...output.modules.values()].sort((a, b) => `${a.package}:${a.source}`.localeCompare(`${b.package}:${b.source}`)),
        importedCss: [...output.importedCss].sort() })),
    contributingCssSources: [...supplementalCss.values()].sort((a, b) => `${a.package}:${a.source}`.localeCompare(`${b.package}:${b.source}`)),
    generatedModuleIds: [...generated].sort() };
  await fs.writeFile(path.join(stageRoot, 'WEB_THIRD_PARTY_NOTICES.md'), notices.join(''));
  await fs.writeFile(path.join(stageRoot, 'web-dependency-map.json'), JSON.stringify(map, null, 2) + '\n');
  await fs.copyFile(path.join(sourceRoot, 'FONT_LICENSES.md'), path.join(stageRoot, 'FONT_LICENSES.md'));
  await fs.copyFile(path.join(sourceRoot, 'THIRD_PARTY_NOTICES.md'), path.join(stageRoot, 'SOURCE_THIRD_PARTY_NOTICES.md'));
  assert(!strict || map.noticeClosureComplete,
    `Bundled browser packages have no full published license/notice text: ${unresolvedLicenseTexts.map(value => value.package).join(', ')}. Evidence: ${path.join(stageRoot, 'web-dependency-map.json')}`);
  return map;
}
