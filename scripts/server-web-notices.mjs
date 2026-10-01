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
// Conservative text coverage, not legal approval. A filename/notice or a
// permission fragment cannot prove the complete declared license. Unknown
// forms stay unresolved until an exact-version text review is supplied.
const mitBody = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const normalizeLicense = text => text.replace(/[\u201c\u201d]/gu, '"')
  .replace(/'(Software|AS IS)'/gu, '"$1"').replace(/\s+/gu, ' ').trim();
function hasKnownCompleteLicense(text, declaration) {
  const grant = /Permission\s+is\s+hereby\s+granted/iu.exec(text);
  // Attribution must precede the permission body. Its own "copyright notice"
  // boilerplate is not a holder, nor is a year with no attributed person/entity.
  const header = grant && text.slice(0, grant.index).match(/^\s*Copyright\s*(?:\(c\)|\u00a9)?\s+([^\r\n]+)/imu);
  const holder = header?.[1].replace(/^\d{4}(?:\s*[,\-\u2013]\s*\d{4})*(?:\s*[-\u2013]\s*(?:present|now))?\s*/iu, '').trim();
  return declaration === 'MIT' && Boolean(holder && /\p{L}/u.test(holder)
    && !/^(?:notice|holders?|permission)\b|^\[.*\]$/iu.test(holder))
    && normalizeLicense(text).includes(normalizeLicense(mitBody));
}

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
          async handler(_options, bundle) {
            const cssModules = [...this.getModuleIds()].filter(id => /\.css(?:[?#]|$)/iu.test(id));
            const outputs = Object.values(bundle).map(output => ({
              file: output.fileName,
              type: output.type,
              sha256: hash(output.type === 'chunk' ? output.code : output.source),
              moduleIds: output.type === 'chunk' ? [...new Set(output.moduleIds ?? Object.keys(output.modules))] : [],
              originalFileNames: output.type === 'asset' ? [...output.originalFileNames ?? []] : [],
              importedCss: output.type === 'chunk' ? [...output.viteMetadata?.importedCss ?? []] : [],
            }));
            for (const output of outputs) if (/\.html$/iu.test(output.file)) {
              output.htmlSources = await Promise.all(output.originalFileNames.map(async id => ({ id,
                sha256: hash(await fs.readFile(path.resolve(this.environment?.config.root ?? process.cwd(), id))) })));
            }
            const generatedModules = [...new Set(outputs.flatMap(output => output.moduleIds))]
              .filter(id => id.startsWith('\0')).map(id => {
                const code = this.getModuleInfo(id)?.code;
                return { id, codeSha256: typeof code === 'string' ? hash(code) : null };
              });
            records.push({ build, kind, cssModules, generatedModules, outputs });
          },
        },
      };
    },
  };
}

async function installedFiles(directory, prefix = '') {
  const result = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules') continue;
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Web package data contains a link: ${relative}`);
    if (entry.isDirectory()) result.push(...await installedFiles(absolute, relative));
    else if (entry.isFile()) result.push({ relative, absolute });
  }
  return result;
}

// Shipped output is exhaustive: dependency-shaped directories and links are
// not installed-package inventory boundaries and must never disappear.
async function shippedFiles(directory, prefix = '') {
  const result = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Shipped browser data contains a link: ${relative}`);
    if (entry.isDirectory()) result.push(...await shippedFiles(absolute, relative));
    else { assert(entry.isFile(), `Unsupported shipped browser data: ${relative}`); result.push({ relative, absolute }); }
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
  const reviewedBytes = await fs.readFile(new URL('./web-notice-data/reviewed.json', import.meta.url));
  const reviewed = JSON.parse(reviewedBytes.toString('utf8'));
  const packages = new Map();
  const owners = new Map();
  const generated = new Set();
  const seenGenerated = new Set();
  const generatedAttribution = [];
  const verifiedTools = new Map();
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
      integrity: locked.resolution.integrity, manifestSha256, directory: metadata.directory, modules: new Set(), emitted: new Set(), requiredNoticeFiles: new Map() });
    const value = { package: key, source: path.relative(metadata.directory, file).split(path.sep).join('/') };
    packages.get(key).modules.add(value.source); owners.set(file, value); return value;
  }

  async function generatedOwner(id, record, output) {
    seenGenerated.add(id);
    const review = reviewed.generated.find(value => value.id === id);
    const captured = record.generatedModules?.find(value => value.id === id);
    if (!review || !captured || captured.codeSha256 !== review.codeSha256
      || review.codeSha256 === null && !review.outputSha256.includes(output.sha256)) {
      generated.add(id); return null;
    }
    const { tool } = review;
    const key = `${tool.package}:${tool.source}`;
    let source = verifiedTools.get(key);
    if (!source) {
      try {
        assert.equal(lock.value.packages[tool.package]?.resolution?.integrity, tool.integrity);
        const require = createRequire(path.join(sourceRoot, 'package.json'));
        let manifestFile;
        try { manifestFile = require.resolve(`${tool.name}/package.json`); }
        catch { manifestFile = createRequire(require.resolve('vite/package.json')).resolve(`${tool.name}/package.json`); }
        const manifestBytes = await fs.readFile(manifestFile);
        assert.equal(hash(manifestBytes), tool.manifestSha256);
        const manifest = JSON.parse(manifestBytes.toString('utf8'));
        assert.equal(`${manifest.name}@${manifest.version}`, tool.package);
        const file = path.join(path.dirname(manifestFile), tool.source);
        assert.equal(hash(await fs.readFile(file)), tool.sourceSha256);
        for (const notice of tool.noticeFiles) {
          assert.equal(hash(await fs.readFile(path.join(path.dirname(manifestFile), notice.source))), notice.sha256);
        }
        source = await owner(file);
        assert.equal(source?.package, tool.package);
        verifiedTools.set(key, source);
      } catch { generated.add(id); return null; }
    }
    for (const notice of tool.noticeFiles) {
      assert(!path.isAbsolute(notice.source) && !notice.source.split('/').includes('..'), 'Unsafe required tool notice.');
      const required = packages.get(tool.package).requiredNoticeFiles;
      if (required.has(notice.source)) assert.equal(required.get(notice.source).sha256, notice.sha256, 'Conflicting required tool notice.');
      required.set(notice.source, notice);
    }
    generatedAttribution.push({ id, build: record.build, file: output.file, package: tool.package,
      codeSha256: captured.codeSha256, outputSha256: output.sha256, installedSource: tool.source,
      installedSourceSha256: tool.sourceSha256, noticeFiles: tool.noticeFiles, upstream: review.upstream, review: review.review });
    return { ...source, generatedModule: id, sourceSha256: tool.sourceSha256 };
  }

  for (const record of capture.records) {
    for (const id of record.cssModules) {
      const value = await owner(id); if (value) supplementalCss.set(`${value.package ?? 'project'}:${value.source}`, value);
    }
    for (const output of record.outputs) {
      assert(!path.isAbsolute(output.file) && !output.file.split('/').includes('..'), 'Unsafe emitted browser asset path.');
      const previous = emitted.get(output.file);
      if (previous) assert.equal(previous.sha256, output.sha256, `Browser output changed between captured builds: ${output.file}`);
      const value = previous ?? { file: output.file, type: output.type, sha256: output.sha256, builds: new Set(), modules: new Map(), originals: new Set(), importedCss: new Set(), htmlSources: new Map() };
      value.builds.add(record.build);
      for (const id of output.moduleIds) {
        const source = id.startsWith('\0') ? await generatedOwner(id, record, output) : await owner(id);
        if (source) value.modules.set(`${source.package ?? 'project'}:${source.source}${source.generatedModule ? `:${source.generatedModule}` : ''}`, source);
      }
      for (const id of output.originalFileNames) value.originals.add(id);
      for (const css of output.importedCss) value.importedCss.add(css);
      for (const source of output.htmlSources ?? []) {
        if (value.htmlSources.has(source.id)) assert.equal(value.htmlSources.get(source.id), source.sha256, 'Captured HTML source changed.');
        value.htmlSources.set(source.id, source.sha256);
      }
      emitted.set(output.file, value);
    }
  }
  for (const output of emitted.values()) for (const id of output.originals) {
    const physical = path.isAbsolute(id) ? id : path.join(sourceRoot, id);
    let source = await owner(physical);
    if (/\.html$/iu.test(output.file)) {
      const sha256 = output.htmlSources.get(id);
      assert(sha256 && sha256 === hash(await fs.readFile(physical)), `Captured HTML source hash mismatch: ${output.file}`);
      if (source) source = { ...source, sha256 };
    }
    if (source) output.modules.set(`${source.package ?? 'project'}:${source.source}`, source);
  }

  // Vite's importedCss relation plus the exact chunk CSS module IDs also covers
  // extracted stylesheets without originalFileNames (including worker builds).
  // Never attribute arbitrary CSS by filename or by every CSS input in a build.
  for (const output of emitted.values()) for (const file of output.importedCss) {
    const stylesheet = emitted.get(file);
    assert(stylesheet && /\.css$/iu.test(file), `Captured imported CSS is unavailable: ${file}`);
    for (const [key, source] of output.modules) if (/\.css$/iu.test(source.source)) stylesheet.modules.set(key, source);
  }

  // Vite can omit originalFileNames for CSS-url assets. Match their complete bytes
  // against font files in the packages proved by JS/CSS capture, never by filename.
  const fontSources = new Map();
  const packageFiles = new Map();
  for (const [key, info] of packages) {
    const entries = await installedFiles(info.directory); packageFiles.set(key, entries);
    for (const entry of entries.filter(entry => font.test(entry.relative))) {
      const sha256 = hash(await fs.readFile(entry.absolute));
      const source = { package: key, source: entry.relative, sha256 };
      const matches = fontSources.get(sha256) ?? []; matches.push(source); fontSources.set(sha256, matches);
    }
  }
  const outputFiles = await shippedFiles(webRoot);
  if (emitted.has('web.html') && !outputFiles.some(entry => entry.relative === 'web.html')
    && outputFiles.some(entry => entry.relative === 'index.html')) {
    const html = emitted.get('web.html');
    assert(!emitted.has('index.html') && html.type === 'asset' && html.originals.size === 1
      && html.modules.size === 1 && [...html.modules.values()].every(source => source.package === null
        && source.source === 'web.html' && source.sha256), 'Unverified project HTML rename.');
    emitted.delete('web.html'); html.capturedFile = 'web.html'; html.file = 'index.html'; emitted.set('index.html', html);
  }
  for (const entry of outputFiles) {
    const actualSha256 = hash(await fs.readFile(entry.absolute));
    let output = emitted.get(entry.relative);
    if (!output) {
      output = { file: entry.relative, type: 'uncaptured', sha256: actualSha256, builds: new Set(), modules: new Map(),
        originals: new Set(), importedCss: new Set(), htmlSources: new Map(),
        captureError: `Shipped browser file was not captured: ${entry.relative}` };
      emitted.set(entry.relative, output);
    } else if (actualSha256 !== output.sha256) {
      output.capturedSha256 = output.sha256; output.sha256 = actualSha256;
      output.captureError = `Captured browser output hash mismatch: ${entry.relative}`;
    }
    if (output.captureError) continue;
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
  const retainedTexts = [];
  const unresolvedLicenseTexts = [];
  for (const [key, info] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const entries = packageFiles.get(key) ?? await installedFiles(info.directory);
    const requiredNotices = new Map(info.requiredNoticeFiles);
    let licenseFiles = entries.filter(entry => licenseName.test(path.basename(entry.relative)) || entry.relative.split('/').slice(0, -1).some(part => /^licen[cs]es?$/iu.test(part)));
    // Required verified tool notices are copied independently of their names.
    for (const expected of requiredNotices.values()) {
      const entry = entries.find(value => value.relative === expected.source);
      assert(entry, `Required tool notice is absent: ${key}/${expected.source}`);
      licenseFiles.push(entry);
    }
    const textReview = reviewed.packages[key];
    // A reviewed attribution/header may have a non-license filename. Retain
    // every available reviewed file even when stale bytes force refusal.
    for (const expected of textReview?.files ?? []) {
      const entry = entries.find(value => value.relative === expected.source);
      if (entry) licenseFiles.push(entry);
    }
    let verifiedTextReview = Boolean(textReview && textReview.declaration === info.license
      && textReview.integrity === info.integrity && textReview.manifestSha256 === info.manifestSha256);
    if (verifiedTextReview) {
      for (const expected of textReview.files) {
        const entry = entries.find(value => value.relative === expected.source);
        if (!entry || hash(await fs.readFile(entry.absolute)) !== expected.sha256) verifiedTextReview = false;
      }
      // Supplements are primary-publisher license-version bytes, not another
      // package/version's notice or a fabricated package copyright statement.
      for (const expected of textReview.supplemental ?? []) {
        assert(!path.isAbsolute(expected.source) && !expected.source.split('/').includes('..'), 'Unsafe reviewed license supplement.');
        assert(expected.encoding === 'base64' && expected.storedAs === `${expected.source}.base64`, 'Unknown reviewed license encoding.');
        // Git's text line-ending conversion must not alter the publisher bytes.
        // Decode the frozen byte payload and require the full original hash.
        const encoded = await fs.readFile(new URL(`./web-notice-data/${expected.storedAs}`, import.meta.url), 'ascii');
        assert(/^[A-Za-z0-9+/=\r\n]+$/u.test(encoded), 'Invalid reviewed license byte payload.');
        const bytes = Buffer.from(encoded, 'base64');
        if (hash(bytes) !== expected.sha256) verifiedTextReview = false;
        licenseFiles.push({ relative: expected.source, bytes, provenance: expected });
      }
    }
    if (verifiedTextReview) for (const expected of [...textReview.files, ...textReview.supplemental ?? []]) {
      const previous = requiredNotices.get(expected.source);
      if (previous) assert.equal(previous.sha256, expected.sha256, 'Conflicting required reviewed notice.');
      requiredNotices.set(expected.source, { source: expected.source, sha256: expected.sha256 });
    }
    // Some published packages place the complete permission text in README.
    // Preserve the original file bytes; a bare "MIT" heading is not license text.
    if (!licenseFiles.length) for (const entry of entries.filter(entry => /^readme(?:\.|$)/iu.test(path.basename(entry.relative)))) {
      const text = await fs.readFile(entry.absolute, 'utf8');
      if (/^#{1,6}\s+licen[cs]e\b/imu.test(text) && /Permission is hereby granted|TERMS AND CONDITIONS|Redistribution and use in source and binary forms/iu.test(text)) licenseFiles.push(entry);
    }
    let completeText = verifiedTextReview;
    for (const entry of licenseFiles) {
      if (!textReview && hasKnownCompleteLicense(await fs.readFile(entry.absolute, 'utf8'), info.license)) completeText = true;
    }
    const textCoverageUnverified = !completeText;
    if (textCoverageUnverified) {
      unresolvedLicenseTexts.push({ package: key, declaration: info.license,
        reason: 'Complete declared license text is not established. Filenames, attribution-only notices, fragments and unknown forms require exact-version text review.' });
      for (const entry of entries.filter(entry => /^readme(?:\.|$)/iu.test(path.basename(entry.relative)))) {
        const text = await fs.readFile(entry.absolute, 'utf8');
        if (/^#{1,6}\s+licen[cs]e\b/imu.test(text)) licenseFiles.push(entry);
      }
    }
    licenseFiles = [...new Map(licenseFiles.map(entry => [entry.relative, entry])).values()];
    const texts = [];
    const folder = key.replaceAll('/', '__');
    await fs.mkdir(path.join(destination, folder), { recursive: true });
    await fs.writeFile(path.join(destination, folder, 'package.json'), await fs.readFile(path.join(info.directory, 'package.json')));
    notices.push(`\n## ${key}: ${info.license ?? 'See published license text (no manifest declaration)'}\n`);
    if (textCoverageUnverified) notices.push('\n**UNRESOLVED:** Published files are retained verbatim, but complete declared license text coverage is not established. Exact-version review is pending.\n');
    for (const entry of licenseFiles) {
      const bytes = entry.bytes ?? await fs.readFile(entry.absolute);
      assert(bytes.length, `Empty bundled license/notice text: ${key}/${entry.relative}`);
      const relative = path.posix.join('licenses/web', folder, entry.relative);
      await fs.mkdir(path.dirname(path.join(stageRoot, relative)), { recursive: true });
      const expected = requiredNotices.get(entry.relative);
      if (expected) assert.equal(hash(bytes), expected.sha256, `Required notice source hash mismatch: ${key}/${entry.relative}`);
      await fs.writeFile(path.join(stageRoot, relative), bytes);
      assert((await fs.readFile(path.join(stageRoot, relative))).equals(bytes), `Staged notice bytes differ: ${relative}`);
      retainedTexts.push({ key, source: entry.relative, bytes });
      texts.push({ source: entry.relative, file: relative, sha256: hash(bytes), textCoverageUnverified,
        ...(entry.provenance ? { provenance: entry.provenance } : {}) });
      notices.push(`\n### ${entry.relative}\n\n${bytes.toString('utf8')}\n`);
    }
    for (const expected of requiredNotices.values()) assert(texts.some(text => text.source === expected.source
      && text.sha256 === expected.sha256), `Required notice was not mapped: ${key}/${expected.source}`);
    metadata.push({ name: info.name, version: info.version, license: info.license, integrity: info.integrity,
      manifestSha256: info.manifestSha256, manifestFile: path.posix.join('licenses/web', folder, 'package.json'),
      licenseFiles: texts, requiredNoticeFiles: [...requiredNotices.values()], noticeTextComplete: !textCoverageUnverified,
      ...(textReview ? { textReview: { ...textReview, verified: verifiedTextReview } } : {}),
      bundledSources: [...info.modules].sort(), emittedFiles: [...info.emitted].sort() });
  }
  // Verify aggregate preservation as well as each exact staged text before
  // making completeness available in the map. Invalid UTF-8 cannot silently
  // lose original notice bytes through markdown serialization.
  const aggregate = Buffer.from(notices.join(''), 'utf8');
  await fs.writeFile(path.join(stageRoot, 'WEB_THIRD_PARTY_NOTICES.md'), aggregate);
  const stagedAggregate = await fs.readFile(path.join(stageRoot, 'WEB_THIRD_PARTY_NOTICES.md'));
  assert(stagedAggregate.equals(aggregate), 'Staged aggregate notices differ.');
  for (const text of retainedTexts) assert(stagedAggregate.includes(text.bytes), `Aggregate omits notice bytes: ${text.key}/${text.source}`);
  // A physical package inventory is not complete emitted attribution. Only
  // exact reviewed helper code/output AND locked tool/source bytes establish a
  // generated owner. Unknown virtual IDs and ownerless CSS/workers still fail.
  const unresolvedAttribution = [
    ...[...generated].sort().map(id => ({ kind: 'generated-module', id,
      reason: 'No verified exact-version owner and license provenance for the generated contribution.' })),
    ...[...emitted.values()].filter(output => output.captureError).map(output => ({ kind: 'unverified-shipped-output', file: output.file,
      sha256: output.sha256, reason: output.captureError })),
    ...[...emitted.values()].filter(output => !output.captureError && !font.test(output.file) && output.modules.size === 0
      && outputFiles.some(entry => entry.relative === output.file)).map(output => ({ kind: 'ownerless-output', file: output.file,
      sha256: output.sha256, reason: 'Shipped output has no captured source or verified generated-helper ownership.' })),
  ];
  const map = { schema: 1, sourceLockSha256: lock.sha256, reviewedProvenanceSha256: hash(reviewedBytes),
    noticeClosureComplete: unresolvedLicenseTexts.length === 0 && unresolvedAttribution.length === 0,
    unresolvedLicenseTexts, unresolvedAttribution, packages: metadata,
    outputs: [...emitted.values()].filter(output => outputFiles.some(entry => entry.relative === output.file)).sort((a, b) => a.file.localeCompare(b.file))
      .map(output => ({ file: output.file, type: output.type, sha256: output.sha256, builds: [...output.builds].sort(),
        ...(output.capturedFile ? { capturedFile: output.capturedFile } : {}),
        ...(output.capturedSha256 ? { capturedSha256: output.capturedSha256 } : {}),
        sources: [...output.modules.values()].sort((a, b) => `${a.package}:${a.source}`.localeCompare(`${b.package}:${b.source}`)),
        importedCss: [...output.importedCss].sort() })),
    contributingCssSources: [...supplementalCss.values()].sort((a, b) => `${a.package}:${a.source}`.localeCompare(`${b.package}:${b.source}`)),
    generatedModuleIds: [...new Set([...seenGenerated, ...generated])].sort(), generatedAttribution };
  await fs.writeFile(path.join(stageRoot, 'web-dependency-map.json'), JSON.stringify(map, null, 2) + '\n');
  await fs.copyFile(path.join(sourceRoot, 'FONT_LICENSES.md'), path.join(stageRoot, 'FONT_LICENSES.md'));
  await fs.copyFile(path.join(sourceRoot, 'THIRD_PARTY_NOTICES.md'), path.join(stageRoot, 'SOURCE_THIRD_PARTY_NOTICES.md'));
  assert(!strict || map.noticeClosureComplete,
    `Bundled browser packages have no full published license/notice text: ${unresolvedLicenseTexts.map(value => value.package).join(', ')}. Unresolved generated/output attribution: ${unresolvedAttribution.length}. ${unresolvedAttribution.map(value => value.reason).join(' ')} Evidence: ${path.join(stageRoot, 'web-dependency-map.json')}`);
  return map;
}
