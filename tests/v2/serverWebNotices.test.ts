import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const root = path.resolve('.');
const helper = pathToFileURL(path.join(root, 'scripts/server-web-notices.mjs')).href;
const directories: string[] = [];
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const permission = `MIT License
Copyright (c) 2026 fixture authors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`;

async function fixture({ missingLicense = false, unownedFont = false, alteredOutput = false,
  generatedHelper = false, unownedRuntime = false } = {}) {
  const directory = await mkdtemp(path.join(privateTestRoot(), 'web-license-boundary-')); directories.push(directory);
  const source = path.join(directory, 'source'); const web = path.join(directory, 'web'); const stage = path.join(directory, 'stage');
  await mkdir(source); await mkdir(web); await mkdir(stage); await mkdir(path.join(web, 'assets'));
  const packages = ['bundle-lib', 'worker-lib', 'font-lib', 'unused-build-tool'];
  for (const name of packages) {
    const packageRoot = path.join(source, 'node_modules', name); await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.2.3', license: 'MIT' }));
    if (!(name === 'bundle-lib' && missingLicense)) await writeFile(path.join(packageRoot, 'LICENSE'), permission);
    await writeFile(path.join(packageRoot, 'index.js'), 'export const value = 1;');
  }
  await writeFile(path.join(source, 'node_modules/bundle-lib/README.md'), missingLicense ? '# License\nMIT\n' : 'Bundled fixture package.');
  await writeFile(path.join(source, 'node_modules/worker-lib/ThirdPartyNotices.txt'), 'Published worker attribution retained verbatim.');
  await writeFile(path.join(source, 'node_modules/font-lib/index.css'), '@font-face { src:url(font.woff2) }');
  await writeFile(path.join(source, 'node_modules/font-lib/font.woff2'), 'exact font fixture bytes');
  await writeFile(path.join(source, 'FONT_LICENSES.md'), 'Project font notice.');
  await writeFile(path.join(source, 'THIRD_PARTY_NOTICES.md'), 'Original project notices.');
  const entry = { file: 'assets/entry.js', type: 'chunk', sha256: sha('entry bundle'),
    moduleIds: [path.join(source, 'node_modules/bundle-lib/index.js')], originalFileNames: [], importedCss: [] };
  const worker = { file: 'assets/worker.js', type: 'chunk', sha256: sha('worker bundle'),
    moduleIds: [path.join(source, 'node_modules/worker-lib/index.js')], originalFileNames: [], importedCss: [] };
  const fontAsset = { file: 'assets/font.woff2', type: 'asset', sha256: sha(unownedFont ? 'unowned font bytes' : 'exact font fixture bytes'),
    moduleIds: [], originalFileNames: [], importedCss: [] };
  await writeFile(path.join(web, entry.file), alteredOutput ? 'changed bundle' : 'entry bundle');
  await writeFile(path.join(web, worker.file), 'worker bundle');
  await writeFile(path.join(web, fontAsset.file), unownedFont ? 'unowned font bytes' : 'exact font fixture bytes');
  if (generatedHelper) entry.moduleIds.push('\0rolldown/runtime.js');
  const runtime = { file: 'assets/runtime.js', type: 'chunk', sha256: sha('ownerless runtime'),
    moduleIds: [], originalFileNames: [], importedCss: [] };
  if (unownedRuntime) await writeFile(path.join(web, runtime.file), 'ownerless runtime');
  const capture = { records: [
    { build: 'worker-1', kind: 'worker', cssModules: [], outputs: [worker] },
    { build: 'browser-0', kind: 'browser', cssModules: [path.join(source, 'node_modules/font-lib/index.css')],
      outputs: [entry, { ...worker, type: 'asset', moduleIds: [] }, fontAsset, ...(unownedRuntime ? [runtime] : [])] },
  ] };
  const lock = { sha256: sha('frozen source lock'), value: { packages: Object.fromEntries(packages.map(name =>
    [`${name}@1.2.3`, { resolution: { integrity: `sha512-fixture-${name}` } }])) } };
  await writeFile(path.join(directory, 'inputs.json'), JSON.stringify({ sourceRoot: source, webRoot: web, stageRoot: stage, capture, lock }));
  return { directory, source, web, stage };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function updateInputs(item: Fixture, update: (inputs: any) => void) {
  const file = path.join(item.directory, 'inputs.json');
  const inputs = JSON.parse(await readFile(file, 'utf8')); update(inputs);
  await writeFile(file, JSON.stringify(inputs));
}

// Positive review fixtures use the exact frozen installation's original bytes;
// changed versions, declarations, manifests or license bodies are not reviews.
async function addReviewedPackage(item: Fixture, key: string) {
  const data = JSON.parse(await readFile(path.join(root, 'scripts/web-notice-data/reviewed.json'), 'utf8'));
  const review = data.packages[key]; const name = key.slice(0, key.lastIndexOf('@'));
  let installed = path.join(root, 'node_modules', name);
  try { installed = await realpath(installed); }
  catch { installed = path.join(root, 'node_modules/.pnpm', key.replaceAll('/', '+'), 'node_modules', name); }
  const destination = path.join(item.source, 'node_modules', name); await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'package.json'), await readFile(path.join(installed, 'package.json')));
  for (const file of review.files) {
    await mkdir(path.dirname(path.join(destination, file.source)), { recursive: true });
    await writeFile(path.join(destination, file.source), await readFile(path.join(installed, file.source)));
  }
  const module = path.join(destination, 'fixture.js'); await writeFile(module, 'export const fixture = true;');
  await updateInputs(item, inputs => {
    inputs.capture.records[1].outputs[0].moduleIds.push(module);
    inputs.lock.value.packages[key] = { resolution: { integrity: review.integrity } };
  });
  return { destination, review };
}

async function addGeneratedFixture(item: Fixture, id: string) {
  const data = JSON.parse(await readFile(path.join(root, 'scripts/web-notice-data/reviewed.json'), 'utf8'));
  const review = data.generated.find((value: { id: string }) => value.id === id);
  const { tool } = review;
  const installed = tool.name === 'vite' ? path.join(root, 'node_modules/vite')
    : path.join(root, 'node_modules/.pnpm', tool.package, 'node_modules', tool.name);
  const destination = path.join(item.source, 'node_modules', tool.name);
  await mkdir(path.dirname(path.join(destination, tool.source)), { recursive: true });
  for (const file of ['package.json', ...tool.noticeFiles.map((file: { source: string }) => file.source), tool.source]) {
    await writeFile(path.join(destination, file), await readFile(path.join(installed, file)));
  }
  await updateInputs(item, inputs => {
    inputs.capture.records[1].outputs[0].moduleIds.push(id);
    inputs.capture.records[1].generatedModules = [{ id, codeSha256: review.codeSha256 }];
    inputs.lock.value.packages[tool.package] = { resolution: { integrity: tool.integrity } };
  });
  return { destination, review };
}

function collect(directory: string, helperUrl = helper) {
  const script = `import {readFile} from 'node:fs/promises'; import {writeWebNotices} from ${JSON.stringify(helperUrl)};
const inputs=JSON.parse(await readFile(${JSON.stringify(path.join(directory, 'inputs.json'))},'utf8'));
console.log(JSON.stringify(await writeWebNotices(inputs)));`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: process.env, encoding: 'utf8', timeout: 20_000 });
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 3 }))); });

describe('bundled browser and worker notice closure', () => {
  it('retains only emitted owners and exact notices, including worker-only modules and CSS-url fonts', async () => {
    const item = await fixture(); const processResult = collect(item.directory); expect(processResult.status, processResult.stderr).toBe(0);
    const map = JSON.parse(processResult.stdout);
    expect(map.noticeClosureComplete).toBe(true);
    expect(map.packages.map((value: { name: string }) => value.name).sort()).toEqual(['bundle-lib', 'font-lib', 'worker-lib']);
    expect(map.outputs.find((value: { file: string }) => value.file === 'assets/worker.js').sources).toContainEqual({ package: 'worker-lib@1.2.3', source: 'index.js' });
    expect(map.outputs.find((value: { file: string }) => value.file === 'assets/font.woff2').sources).toContainEqual({ package: 'font-lib@1.2.3', source: 'font.woff2', sha256: sha('exact font fixture bytes') });
    const worker = map.packages.find((value: { name: string }) => value.name === 'worker-lib');
    const notice = worker.licenseFiles.find((value: { source: string }) => value.source === 'ThirdPartyNotices.txt');
    expect(await readFile(path.join(item.stage, notice.file), 'utf8')).toBe('Published worker attribution retained verbatim.');
    expect(notice.sha256).toBe(sha('Published worker attribution retained verbatim.'));
    expect(await readFile(path.join(item.stage, 'FONT_LICENSES.md'), 'utf8')).toBe('Project font notice.');
  });

  it('refuses a manifest/README license identifier without actual text and preserves the full unresolved graph', async () => {
    const item = await fixture({ missingLicense: true }); const processResult = collect(item.directory);
    expect(processResult.status).not.toBe(0); expect(processResult.stderr).toContain('no full published license/notice text: bundle-lib@1.2.3');
    const map = JSON.parse(await readFile(path.join(item.stage, 'web-dependency-map.json'), 'utf8'));
    expect(map.noticeClosureComplete).toBe(false); expect(map.outputs).toHaveLength(3);
    expect(map.unresolvedLicenseTexts).toEqual([expect.objectContaining({ package: 'bundle-lib@1.2.3', declaration: 'MIT' })]);
    expect(await readFile(path.join(item.stage, 'licenses/web/bundle-lib@1.2.3/README.md'), 'utf8')).toBe('# License\nMIT\n');
  });

  it.each(['declaration-only-license', 'attribution-only-notice', 'truncated-permission'])('refuses %s despite a license-like filename', async (kind) => {
    const item = await fixture({ missingLicense: true });
    const file = kind === 'attribution-only-notice' ? 'NOTICE' : 'LICENSE';
    const bytes = kind === 'declaration-only-license' ? 'MIT\n' : kind === 'attribution-only-notice'
      ? 'Copyright (c) 2026 fixture authors. Published attribution only.\n'
      : permission.slice(0, permission.indexOf('THE SOFTWARE IS PROVIDED'));
    await writeFile(path.join(item.source, 'node_modules/bundle-lib', file), bytes);
    const processResult = collect(item.directory); expect(processResult.status).not.toBe(0);
    const map = JSON.parse(await readFile(path.join(item.stage, 'web-dependency-map.json'), 'utf8'));
    expect(map.noticeClosureComplete).toBe(false);
    expect(map.unresolvedLicenseTexts).toContainEqual(expect.objectContaining({ package: 'bundle-lib@1.2.3' }));
    expect(await readFile(path.join(item.stage, 'licenses/web/bundle-lib@1.2.3', file), 'utf8')).toBe(bytes);
  });

  it.each(['generated-helper', 'ownerless-runtime'])('refuses unresolved %s even when all physical license texts exist', async (kind) => {
    const item = await fixture({ generatedHelper: kind === 'generated-helper', unownedRuntime: kind === 'ownerless-runtime' });
    const processResult = collect(item.directory);
    expect(processResult.status).not.toBe(0); expect(processResult.stderr).toContain('Unresolved generated/output attribution: 1');
    const map = JSON.parse(await readFile(path.join(item.stage, 'web-dependency-map.json'), 'utf8'));
    expect(map.unresolvedLicenseTexts).toEqual([]); expect(map.noticeClosureComplete).toBe(false);
    expect(map.unresolvedAttribution).toHaveLength(1);
    expect(map.unresolvedAttribution[0].kind).toBe(kind === 'generated-helper' ? 'generated-module' : 'ownerless-output');
  });

  it('accepts the complete MIT single-quote form without altering upstream bytes', async () => {
    const item = await fixture(); const bytes = permission.replaceAll('"Software"', "'Software'").replaceAll('"AS IS"', "'AS IS'");
    await writeFile(path.join(item.source, 'node_modules/bundle-lib/LICENSE'), bytes);
    const result = collect(item.directory); expect(result.status, result.stderr).toBe(0);
    expect(await readFile(path.join(item.stage, 'licenses/web/bundle-lib@1.2.3/LICENSE'), 'utf8')).toBe(bytes);
  });

  it.each(['OFL-1.1', 'ISC', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'undeclared-MIT', 'ISC-and-MIT', 'ISC-and-Apache'])
    ('retains exact reviewed complete %s text, not declaration fragments', async kind => {
      const keys: Record<string, string> = { 'OFL-1.1': '@fontsource-variable/inter@5.3.0', ISC: 'd3-array@3.2.4',
        'BSD-3-Clause': 'd3-array@2.12.1', 'Apache-2.0': 'dompurify@3.4.14', '0BSD': 'tslib@2.8.1',
        'undeclared-MIT': 'khroma@2.1.0', 'ISC-and-MIT': 'lucide-react@1.40.0', 'ISC-and-Apache': 'd3-scale-chromatic@3.1.0' };
      const item = await fixture(); const key = keys[kind];
      if (!key) throw new Error('Unknown reviewed license fixture.');
      const added = await addReviewedPackage(item, key);
      const result = collect(item.directory); expect(result.status, result.stderr).toBe(0);
      const map = JSON.parse(result.stdout); const owner = map.packages.find((value: { name: string; version: string }) => `${value.name}@${value.version}` === key);
      expect(owner.noticeTextComplete).toBe(true); expect(owner.textReview.verified).toBe(true);
      for (const file of added.review.files) {
        expect(await readFile(path.join(item.stage, 'licenses/web', key.replaceAll('/', '__'), file.source)))
          .toEqual(await readFile(path.join(added.destination, file.source)));
      }
      if (kind === 'ISC-and-Apache') {
        const supplement = owner.licenseFiles.find((file: { source: string }) => file.source === 'Apache-2.0.txt');
        expect(supplement.provenance.url).toBe('https://www.apache.org/licenses/LICENSE-2.0.txt');
        const frozen = Buffer.from(await readFile(path.join(root, 'scripts/web-notice-data/Apache-2.0.txt.base64'), 'ascii'), 'base64');
        expect(await readFile(path.join(item.stage, supplement.file))).toEqual(frozen);
      }
    });

  it.each(['truncated-text', 'declaration-only', 'changed-manifest', 'changed-integrity'])('refuses a stale exact text review: %s', async kind => {
    const item = await fixture(); const { destination } = await addReviewedPackage(item, 'd3-array@3.2.4');
    if (kind === 'truncated-text' || kind === 'declaration-only') {
      const text = await readFile(path.join(destination, 'LICENSE'), 'utf8');
      await writeFile(path.join(destination, 'LICENSE'), kind === 'declaration-only' ? 'ISC\n' : text.slice(0, text.indexOf('THE SOFTWARE')));
    } else if (kind === 'changed-manifest') {
      const file = path.join(destination, 'package.json'); const bytes = JSON.parse(await readFile(file, 'utf8')); bytes.forged = true;
      await writeFile(file, JSON.stringify(bytes));
    } else await updateInputs(item, inputs => { inputs.lock.value.packages['d3-array@3.2.4'].resolution.integrity = 'sha512-false-provenance'; });
    const result = collect(item.directory); expect(result.status).not.toBe(0);
    const map = JSON.parse(await readFile(path.join(item.stage, 'web-dependency-map.json'), 'utf8'));
    expect(map.unresolvedLicenseTexts).toContainEqual(expect.objectContaining({ package: 'd3-array@3.2.4' }));
  });

  it.each(['Unreviewed-Custom-License', null])('refuses unreviewed declaration %s despite copied full MIT text', async declaration => {
    const item = await fixture(); const file = path.join(item.source, 'node_modules/bundle-lib/package.json');
    const manifest = JSON.parse(await readFile(file, 'utf8')); manifest.license = declaration; await writeFile(file, JSON.stringify(manifest));
    const result = collect(item.directory); expect(result.status).not.toBe(0);
    const map = JSON.parse(await readFile(path.join(item.stage, 'web-dependency-map.json'), 'utf8'));
    expect(map.unresolvedLicenseTexts).toContainEqual(expect.objectContaining({ package: 'bundle-lib@1.2.3' }));
  });

  it.each(['\0vite/preload-helper.js', '\0vite/modulepreload-polyfill.js'])('attributes only exact reviewed helper %s and includes tool notices', async id => {
    const item = await fixture(); const { review } = await addGeneratedFixture(item, id);
    const result = collect(item.directory); expect(result.status, result.stderr).toBe(0);
    const map = JSON.parse(result.stdout);
    expect(map.generatedAttribution).toContainEqual(expect.objectContaining({ id, package: review.tool.package, codeSha256: review.codeSha256 }));
    const toolOwner = map.packages.find((value: { name: string }) => value.name === review.tool.name);
    expect(toolOwner.noticeTextComplete).toBe(true);
    const aggregate = await readFile(path.join(item.stage, 'WEB_THIRD_PARTY_NOTICES.md'));
    for (const required of review.tool.noticeFiles) {
      const text = toolOwner.licenseFiles.find((value: { source: string }) => value.source === required.source);
      expect(text).toMatchObject({ source: required.source, sha256: required.sha256 });
      const bytes = await readFile(path.join(item.stage, text.file));
      expect(sha(bytes)).toBe(required.sha256); expect(aggregate.includes(bytes)).toBe(true);
    }
  });

  it.each(['unknown-prefix', 'changed-helper-code', 'changed-tool-source', 'changed-tool-notice', 'changed-tool-lock'])('refuses malicious helper provenance: %s', async kind => {
    const item = await fixture(); const { destination, review } = await addGeneratedFixture(item, '\0vite/preload-helper.js');
    if (kind === 'changed-tool-source') await writeFile(path.join(destination, review.tool.source), 'forged tool implementation');
    else if (kind === 'changed-tool-notice') await writeFile(path.join(destination, review.tool.noticeFiles[0].source), permission);
    else await updateInputs(item, inputs => {
      const record = inputs.capture.records[1];
      if (kind === 'unknown-prefix') {
        record.outputs[0].moduleIds[1] = '\0vite/preload-helper.js/evil'; record.generatedModules[0].id = '\0vite/preload-helper.js/evil';
      } else if (kind === 'changed-helper-code') record.generatedModules[0].codeSha256 = sha('malicious helper');
      else inputs.lock.value.packages[review.tool.package].resolution.integrity = 'sha512-forged-tool';
    });
    const result = collect(item.directory); expect(result.status).not.toBe(0);
    const map = JSON.parse(await readFile(path.join(item.stage, 'web-dependency-map.json'), 'utf8'));
    expect(map.unresolvedAttribution).toHaveLength(1); expect(map.unresolvedAttribution[0].kind).toBe('generated-module');
  });

  it('refuses changed runtime bytes even with the exact reviewed ID, source and tool version', async () => {
    const item = await fixture(); await addGeneratedFixture(item, '\0rolldown/runtime.js');
    const result = collect(item.directory); expect(result.status).not.toBe(0);
    const map = JSON.parse(await readFile(path.join(item.stage, 'web-dependency-map.json'), 'utf8'));
    expect(map.unresolvedAttribution).toContainEqual(expect.objectContaining({ kind: 'generated-module', id: '\0rolldown/runtime.js' }));
  });

  it.each([false, true])('does not ignore ownerless CSS from browser/worker builds (worker=%s)', async worker => {
    const item = await fixture(); const file = 'assets/worker.css'; await writeFile(path.join(item.web, file), 'unowned css');
    await updateInputs(item, inputs => { inputs.capture.records[worker ? 0 : 1].outputs.push({ file, type: 'asset', sha256: sha('unowned css'), moduleIds: [], originalFileNames: [], importedCss: [] }); });
    const result = collect(item.directory); expect(result.status).not.toBe(0);
    const map = JSON.parse(await readFile(path.join(item.stage, 'web-dependency-map.json'), 'utf8'));
    expect(map.unresolvedAttribution).toContainEqual(expect.objectContaining({ kind: 'ownerless-output', file }));
  });

  it('attributes extracted worker CSS only through its captured chunk CSS modules and importedCss edge', async () => {
    const item = await fixture(); const file = 'assets/worker.css'; const source = path.join(item.source, 'node_modules/worker-lib/style.css');
    await writeFile(source, 'worker input css'); await writeFile(path.join(item.web, file), 'worker output css');
    await updateInputs(item, inputs => {
      inputs.capture.records[0].cssModules.push(source); const worker = inputs.capture.records[0].outputs[0];
      worker.moduleIds.push(source); worker.importedCss.push(file);
      inputs.capture.records[0].outputs.push({ file, type: 'asset', sha256: sha('worker output css'), moduleIds: [], originalFileNames: [], importedCss: [] });
    });
    const result = collect(item.directory); expect(result.status, result.stderr).toBe(0);
    const map = JSON.parse(result.stdout); const output = map.outputs.find((value: { file: string }) => value.file === file);
    expect(output.sources).toEqual([{ package: 'worker-lib@1.2.3', source: 'style.css' }]);
  });

  it.each(['no-header', 'year-only', 'boilerplate-header'])('refuses MIT without actual pre-body attribution: %s', async kind => {
    const item = await fixture();
    const header = kind === 'no-header' ? '' : kind === 'year-only' ? 'Copyright (c) 2026' : 'Copyright notice';
    await writeFile(path.join(item.source, 'node_modules/bundle-lib/LICENSE'), permission.replace('Copyright (c) 2026 fixture authors', header));
    const result = collect(item.directory); expect(result.status).not.toBe(0);
    const map = JSON.parse(await readFile(path.join(item.stage, 'web-dependency-map.json'), 'utf8'));
    expect(map.unresolvedLicenseTexts).toContainEqual(expect.objectContaining({ package: 'bundle-lib@1.2.3' }));
  });

  it('accepts an actual copyright holder without a year', async () => {
    const item = await fixture(); const bytes = permission.replace('Copyright (c) 2026 fixture authors', 'Copyright (c) fixture authors');
    await writeFile(path.join(item.source, 'node_modules/bundle-lib/LICENSE'), bytes);
    const result = collect(item.directory); expect(result.status, result.stderr).toBe(0);
    expect(await readFile(path.join(item.stage, 'licenses/web/bundle-lib@1.2.3/LICENSE'), 'utf8')).toBe(bytes);
  });

  it('copies a verified reviewed file outside filename discovery, with exact staged and aggregate bytes', async () => {
    const item = await fixture(); const packageRoot = path.join(item.source, 'node_modules/bundle-lib');
    await rm(path.join(packageRoot, 'LICENSE')); await writeFile(path.join(packageRoot, 'ATTRIBUTION.txt'), permission);
    const data = JSON.parse(await readFile(path.join(root, 'scripts/web-notice-data/reviewed.json'), 'utf8'));
    data.packages['bundle-lib@1.2.3'] = { declaration: 'MIT', integrity: 'sha512-fixture-bundle-lib',
      manifestSha256: sha(await readFile(path.join(packageRoot, 'package.json'))), files: [{ source: 'ATTRIBUTION.txt', sha256: sha(permission) }],
      review: 'Private synthetic test-only exact fixture review, not a publication license.' };
    const scripts = path.join(item.directory, 'test-helper'); await mkdir(path.join(scripts, 'web-notice-data'), { recursive: true });
    await writeFile(path.join(scripts, 'server-web-notices.mjs'), await readFile(path.join(root, 'scripts/server-web-notices.mjs')));
    await writeFile(path.join(scripts, 'web-notice-data/reviewed.json'), JSON.stringify(data));
    const result = collect(item.directory, pathToFileURL(path.join(scripts, 'server-web-notices.mjs')).href);
    expect(result.status, result.stderr).toBe(0);
    const map = JSON.parse(result.stdout); const owner = map.packages.find((value: { name: string }) => value.name === 'bundle-lib');
    expect(owner.requiredNoticeFiles).toContainEqual({ source: 'ATTRIBUTION.txt', sha256: sha(permission) });
    const text = owner.licenseFiles.find((value: { source: string }) => value.source === 'ATTRIBUTION.txt');
    expect(await readFile(path.join(item.stage, text.file), 'utf8')).toBe(permission);
    expect((await readFile(path.join(item.stage, 'WEB_THIRD_PARTY_NOTICES.md'))).includes(Buffer.from(permission))).toBe(true);
  });

  it.each(['missing', 'changed'])('refuses a %s pinned Rolldown third-party notice', async kind => {
    const item = await fixture(); const { destination } = await addGeneratedFixture(item, '\0vite/modulepreload-polyfill.js');
    const file = path.join(destination, 'THIRD-PARTY-LICENSE');
    if (kind === 'missing') await rm(file); else await writeFile(file, 'MIT declaration without upstream attributions');
    const result = collect(item.directory); expect(result.status).not.toBe(0);
    const map = JSON.parse(await readFile(path.join(item.stage, 'web-dependency-map.json'), 'utf8'));
    expect(map.unresolvedAttribution).toContainEqual(expect.objectContaining({ kind: 'generated-module', id: '\0vite/modulepreload-polyfill.js' }));
  });

  it('retains every required notice for an accepted exact runtime output', async () => {
    const item = await fixture(); const { review } = await addGeneratedFixture(item, '\0rolldown/runtime.js');
    const bytes = 'var e=Object.create,t=Object.defineProperty,n=Object.getOwnPropertyDescriptor,r=Object.getOwnPropertyNames,i=Object.getPrototypeOf,a=Object.prototype.hasOwnProperty,o=(e,t)=>()=>(t||(e((t={exports:{}}).exports,t),e=null),t.exports),s=(e,n)=>{let r={};for(var i in e)t(r,i,{get:e[i],enumerable:!0});return n||t(r,Symbol.toStringTag,{value:`Module`}),r},c=(e,i,o,s)=>{if(i&&typeof i==`object`||typeof i==`function`)for(var c=r(i),l=0,u=c.length,d;l<u;l++)d=c[l],!a.call(e,d)&&d!==o&&t(e,d,{get:(e=>i[e]).bind(null,d),enumerable:!(s=n(i,d))||s.enumerable});return e},l=(n,r,o)=>(o=n==null?{}:e(i(n)),c(r||!n||!n.__esModule||!a.call(n,`default`)?t(o,`default`,{value:n,enumerable:!0}):o,n));export{s as n,l as r,o as t};';
    expect(review.outputSha256).toContain(sha(bytes));
    await writeFile(path.join(item.web, 'assets/entry.js'), bytes);
    await updateInputs(item, inputs => { inputs.capture.records[1].outputs[0].sha256 = sha(bytes); });
    const result = collect(item.directory); expect(result.status, result.stderr).toBe(0);
    const owner = JSON.parse(result.stdout).packages.find((value: { name: string }) => value.name === 'rolldown');
    for (const required of review.tool.noticeFiles) {
      const text = owner.licenseFiles.find((value: { source: string }) => value.source === required.source);
      expect(text).toMatchObject(required); const copied = await readFile(path.join(item.stage, text.file));
      expect(sha(copied)).toBe(required.sha256);
      expect((await readFile(path.join(item.stage, 'WEB_THIRD_PARTY_NOTICES.md'))).includes(copied)).toBe(true);
    }
  });

  it.each(['exact-rename', 'uncaptured', 'changed-output', 'changed-source'])('binds project HTML rather than exempting index.html: %s', async kind => {
    const item = await fixture(); const source = path.join(item.source, 'web.html'); const html = '<html><body>private project fixture</body></html>';
    await writeFile(source, html);
    await writeFile(path.join(item.web, 'index.html'), kind === 'changed-output' ? html + '<script>unreviewed()</script>' : html);
    if (kind !== 'uncaptured') await updateInputs(item, inputs => { inputs.capture.records[1].outputs.push({ file: 'web.html', type: 'asset',
      sha256: sha(html), moduleIds: [], originalFileNames: [source], htmlSources: [{ id: source, sha256: sha(html) }], importedCss: [] }); });
    if (kind === 'changed-source') await writeFile(source, html + 'changed source');
    const result = collect(item.directory);
    if (kind === 'exact-rename') {
      expect(result.status, result.stderr).toBe(0); const map = JSON.parse(result.stdout);
      expect(map.outputs).toContainEqual(expect.objectContaining({ file: 'index.html', capturedFile: 'web.html', sha256: sha(html),
        sources: [{ package: null, source: 'web.html', sha256: sha(html) }] }));
    } else {
      expect(result.status).not.toBe(0);
      if (kind !== 'changed-source') {
        const map = JSON.parse(await readFile(path.join(item.stage, 'web-dependency-map.json'), 'utf8'));
        expect(map.outputs).toContainEqual(expect.objectContaining({ file: 'index.html' }));
        expect(map.unresolvedAttribution).toContainEqual(expect.objectContaining({ file: 'index.html' }));
      }
    }
  });

  it('rejects changed directly captured index.html and preserves it in the refused inventory', async () => {
    const item = await fixture(); const source = path.join(item.source, 'page.html'); await writeFile(source, '<div>source</div>');
    await writeFile(path.join(item.web, 'index.html'), '<script>substituted()</script>');
    await updateInputs(item, inputs => { inputs.capture.records[1].outputs.push({ file: 'index.html', type: 'asset', sha256: sha('<div>captured</div>'),
      moduleIds: [], originalFileNames: [source], htmlSources: [{ id: source, sha256: sha('<div>source</div>') }], importedCss: [] }); });
    const result = collect(item.directory); expect(result.status).not.toBe(0);
    const map = JSON.parse(await readFile(path.join(item.stage, 'web-dependency-map.json'), 'utf8'));
    expect(map.outputs).toContainEqual(expect.objectContaining({ file: 'index.html', capturedSha256: sha('<div>captured</div>') }));
    expect(map.unresolvedAttribution).toContainEqual(expect.objectContaining({ file: 'index.html' }));
  });

  it.each(['unknown-file', 'link'])('never skips shipped node_modules data: %s', async kind => {
    const item = await fixture(); const directory = path.join(item.web, 'node_modules');
    if (kind === 'link') await symlink(path.join(item.source, 'node_modules'), directory, process.platform === 'win32' ? 'junction' : 'dir');
    else { await mkdir(directory); await writeFile(path.join(directory, 'unknown.js'), 'unreviewed output'); }
    const result = collect(item.directory); expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(kind === 'link' ? 'contains a link: node_modules' : 'Shipped browser file was not captured: node_modules/unknown.js');
  });

  it('does not mistake installed nested dependency notices for the captured owner', async () => {
    const item = await fixture(); const directory = path.join(item.source, 'node_modules/bundle-lib/node_modules/unused-dependency');
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'LICENSE'), 'unused nested dependency notice');
    const result = collect(item.directory); expect(result.status, result.stderr).toBe(0);
    const owner = JSON.parse(result.stdout).packages.find((value: { name: string }) => value.name === 'bundle-lib');
    expect(owner.licenseFiles.map((value: { source: string }) => value.source)).toEqual(['LICENSE']);
  });

  it('refuses font bytes without an exact captured package source', async () => {
    const item = await fixture({ unownedFont: true }); const processResult = collect(item.directory);
    expect(processResult.status).not.toBe(0); expect(processResult.stderr).toContain('font has no exact captured package source');
  });

  it('refuses output changed after browser capture', async () => {
    const item = await fixture({ alteredOutput: true }); const processResult = collect(item.directory);
    expect(processResult.status).not.toBe(0); expect(processResult.stderr).toContain('Captured browser output hash mismatch');
  });
});
