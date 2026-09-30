import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const root = path.resolve('.');
const helper = pathToFileURL(path.join(root, 'scripts/server-web-notices.mjs')).href;
const directories: string[] = [];
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const permission = 'MIT License\nCopyright (c) 2026 fixture authors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction.\n';

async function fixture({ missingLicense = false, unownedFont = false, alteredOutput = false } = {}) {
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
  const capture = { records: [
    { build: 'worker-1', kind: 'worker', cssModules: [], outputs: [worker] },
    { build: 'browser-0', kind: 'browser', cssModules: [path.join(source, 'node_modules/font-lib/index.css')],
      outputs: [entry, { ...worker, type: 'asset', moduleIds: [] }, fontAsset] },
  ] };
  const lock = { sha256: sha('frozen source lock'), value: { packages: Object.fromEntries(packages.map(name =>
    [`${name}@1.2.3`, { resolution: { integrity: `sha512-fixture-${name}` } }])) } };
  await writeFile(path.join(directory, 'inputs.json'), JSON.stringify({ sourceRoot: source, webRoot: web, stageRoot: stage, capture, lock }));
  return { directory, source, web, stage };
}

function collect(directory: string) {
  const script = `import {readFile} from 'node:fs/promises'; import {writeWebNotices} from ${JSON.stringify(helper)};
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

  it('refuses font bytes without an exact captured package source', async () => {
    const item = await fixture({ unownedFont: true }); const processResult = collect(item.directory);
    expect(processResult.status).not.toBe(0); expect(processResult.stderr).toContain('font has no exact captured package source');
  });

  it('refuses output changed after browser capture', async () => {
    const item = await fixture({ alteredOutput: true }); const processResult = collect(item.directory);
    expect(processResult.status).not.toBe(0); expect(processResult.stderr).toContain('Captured browser output hash mismatch');
  });
});
