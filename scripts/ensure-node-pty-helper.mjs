// node-pty 1.1.0 publishes its macOS spawn-helper without the executable bit.
// Packaged builds restore it in afterPack (verify-packaged-native-deps.mjs). A
// source checkout needs the same repair, or every manual terminal start fails
// with "posix_spawnp failed". This changes nothing on Windows and Linux.
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Returns the helpers it made executable. Never throws for a missing package. */
export function ensureNodePtyHelper(platform = process.platform, arch = process.arch, resolveFrom = import.meta.url) {
  if (platform !== 'darwin') return [];
  let root;
  try { root = path.dirname(createRequire(resolveFrom).resolve('node-pty/package.json')); }
  catch { return []; }
  const repaired = [];
  for (const base of ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]) {
    const helper = path.join(root, base, 'spawn-helper');
    if (!existsSync(helper) || (statSync(helper).mode & 0o111) !== 0) continue;
    chmodSync(helper, 0o755);
    repaired.push(helper);
  }
  return repaired;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const helper of ensureNodePtyHelper()) process.stdout.write(`Made node-pty helper executable: ${helper}\n`);
}
