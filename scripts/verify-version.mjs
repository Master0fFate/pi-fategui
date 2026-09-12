import path from 'node:path';
import { readReleaseMetadata } from './release-metadata.mjs';

const root = path.resolve(import.meta.dirname, '..');
const metadata = await readReleaseMetadata(root);
process.stdout.write(`Version sources match exactly: ${metadata.version}; release title: ${metadata.displayVersion}\n`);
