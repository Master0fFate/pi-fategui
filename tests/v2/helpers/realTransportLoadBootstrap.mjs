// Trusted test-only launcher: a separate process is necessary because the v2
// worker's nodeGuard deliberately blocks even loopback. Never change that guard.
import '../../network/loopbackGuard.mjs';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = realpathSync(path.resolve(import.meta.dirname, '../../..'));
const require = createRequire(path.join(source, 'package.json'));
const ts = require('typescript'); // Existing pinned dependency; no build/install/artifact.
const mode = process.argv[2];
if (!['disabled', 'load'].includes(mode)) throw new Error('Unknown real transport fixture mode.');
let nativeAddonResolutions = 0, nativeMetadataResolutions = 0;
const inside = candidate => {
  const relative = path.relative(source, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node-pty/package.json') {
      nativeMetadataResolutions++;
      if (mode === 'disabled') throw new Error('DISABLED_FIXTURE_RESOLVED_PTY_METADATA');
    } else if (specifier === 'node-pty' || specifier.startsWith('node-pty/')) {
      nativeAddonResolutions++;
      // Real native I/O belongs only in the separately owned pure driver. In
      // particular, never exempt ConPTY named pipes from the application guard.
      throw new Error('IN_PROCESS_NATIVE_PTY_FORBIDDEN_USE_OWNED_DRIVER');
    }
    let candidate;
    if (specifier.startsWith('@shared/')) candidate = path.join(source, 'src/shared', specifier.slice(8));
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const parent = fileURLToPath(context.parentURL);
      if (inside(parent) && !parent.includes(path.sep + 'node_modules' + path.sep)) candidate = path.resolve(path.dirname(parent), specifier);
    }
    if (candidate && inside(candidate)) {
      for (const extension of ['', '.ts', '.tsx', '/index.ts']) {
        const file = candidate + extension;
        if (/\.tsx?$/u.test(file) && existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    // Vite normally supplies the source package metadata import. This test-only
    // TypeScript loader must do the same without changing production modules.
    if (url.startsWith('file:') && fileURLToPath(url) === path.join(source, 'package.json')) {
      const text = readFileSync(path.join(source, 'package.json'), 'utf8');
      JSON.parse(text);
      return { format: 'module', source: `export default JSON.parse(${JSON.stringify(text)});`, shortCircuit: true };
    }
    if (url.startsWith('file:') && /\.tsx?$/u.test(url)) {
      const file = fileURLToPath(url);
      if (inside(file) && !file.includes(path.sep + 'node_modules' + path.sep)) {
        const transformed = ts.transpileModule(readFileSync(file, 'utf8'), {
          fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
            isolatedModules: true, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
        });
        return { format: 'module', source: transformed.outputText, shortCircuit: true };
      }
    }
    return next(url, context);
  },
});
const { runRealTransportLoad } = await import('./realTransportLoadWorker.ts');
await runRealTransportLoad(mode, () => nativeAddonResolutions, () => nativeMetadataResolutions);
