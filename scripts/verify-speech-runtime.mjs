import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { artifactDir, version } from 'transcribe-cpp';

const directory = artifactDir();
const library = process.platform === 'win32' ? 'transcribe.dll' : process.platform === 'darwin' ? 'libtranscribe.dylib' : 'libtranscribe.so';
const target = path.join(directory, library);
if (!existsSync(target)) throw new Error(`transcribe.cpp native library is missing: ${target}`);
const files = readdirSync(directory);
if (files.length < 2) throw new Error(`transcribe.cpp artifact directory is incomplete: ${directory}`);
console.log(`[speech] transcribe.cpp ${version().version} runtime verified for ${process.platform}/${process.arch}: ${directory}`);
