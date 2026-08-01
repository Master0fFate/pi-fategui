import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const productionVersion = await readFile(path.join(root, 'PRODVER'), 'utf8');
const strictSemVer = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

if (typeof manifest.version !== 'string' || !strictSemVer.test(manifest.version)) {
  throw new Error(`package.json version is not strict SemVer: ${String(manifest.version)}`);
}
if (productionVersion !== manifest.version) {
  throw new Error(`PRODVER (${JSON.stringify(productionVersion)}) must exactly match package.json (${manifest.version}).`);
}

process.stdout.write(`Version sources match exactly: ${manifest.version}\n`);
