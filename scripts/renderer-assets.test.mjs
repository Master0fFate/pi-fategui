import { describe, expect, it } from 'vitest';
import { bundleMonacoFallbackWorker, findMissingEmittedModules, verifyEmittedRendererModules } from './renderer-build-plugins.ts';
import rendererConfig from '../vite.renderer.config.ts';
import webConfig from '../vite.web.config.ts';

describe('renderer emitted-module integrity', () => {
  it('rejects the unbundled Monaco fallback that a successful Vite build used to copy', () => {
    const files = new Map([
      ['assets/editor.api.js', 'const url = new URL("editorWebWorkerMain.js", import.meta.url);'],
      ['assets/editorWebWorkerMain.js', "import { bootstrapWebWorker } from '../../../base/common/worker/webWorkerBootstrap.js';\nimport { EditorWorker } from './editorWebWorker.js';"],
    ]);
    expect(findMissingEmittedModules(files)).toEqual([
      { importer: 'assets/editorWebWorkerMain.js', specifier: '../../../base/common/worker/webWorkerBootstrap.js', target: '../../base/common/worker/webWorkerBootstrap.js' },
      { importer: 'assets/editorWebWorkerMain.js', specifier: './editorWebWorker.js', target: 'assets/editorWebWorker.js' },
    ]);
  });

  it('accepts bundled workers and existing static, lazy, export and worker URL targets', () => {
    const files = new Map([
      ['assets/main.js', 'import "./shared.js"; export { value } from "./shared.js"; import(`./lazy.js`); new URL("worker.js", import.meta.url);'],
      ['assets/shared.js', 'export const value = 1;'],
      ['assets/lazy.js', 'export default 2;'],
      ['assets/worker.js', 'self.onmessage = () => {};'],
    ]);
    expect(findMissingEmittedModules(files)).toEqual([]);
  });

  it('does not confuse bundled CommonJS module labels or remote URLs with imports', () => {
    const files = new Map([['assets/main.js', 'const modules = {"../../node_modules/library.js": () => {}}; new URL("https://example.test/worker.js", import.meta.url);']]);
    expect(findMissingEmittedModules(files)).toEqual([]);
  });

  it('reports missing dynamic imports and worker URL assets', () => {
    const files = new Map([['assets/main.js', 'import("./lazy.js"); new URL("worker.js", import.meta.url);']]);
    expect(findMissingEmittedModules(files).map(({ target }) => target)).toEqual(['assets/lazy.js', 'assets/worker.js']);
  });

  it('checks copied byte assets as well as generated chunks in the build hook', () => {
    const bundle = {
      'assets/main.js': { type: 'chunk', code: 'new URL("worker.js", import.meta.url);' },
      'assets/worker.js': { type: 'asset', source: new TextEncoder().encode('import "./missing.js";') },
    };
    const context = { error(message) { throw new Error(message); } };
    expect(() => verifyEmittedRendererModules().generateBundle.handler.call(context, {}, bundle))
      .toThrow('assets/worker.js -> ./missing.js');
  });
});

describe('Monaco fallback worker bundling', () => {
  const id = '/node_modules/monaco-editor/esm/vs/editor/browser/services/editorWorkerService.js';
  const source = "const worker = { esmModuleLocationBundler: () => new URL('../../common/services/editorWebWorkerMain.js', import.meta.url) };";
  const context = { error(message) { throw new Error(message); } };

  it('routes only the known fallback through Vite worker bundling', () => {
    const plugin = bundleMonacoFallbackWorker();
    const result = plugin.transform.call(context, source, id);
    expect(result.code).toContain("from '../../common/services/editorWebWorkerMain.js?worker&url'");
    expect(result.code).toContain('new URL(__fateFallbackWorkerUrl, import.meta.url)');
    expect(result.code).not.toContain('MonacoEnvironment');
    expect(plugin.transform.call(context, source, '/src/renderer/other.js')).toBeUndefined();
  });

  it('requires review if the targeted upstream worker expression changes', () => {
    expect(() => bundleMonacoFallbackWorker().transform.call(context, 'const worker = {};', id)).toThrow('Monaco fallback worker entry changed');
  });
});

describe('renderer build target parity', () => {
  it.each([
    ['desktop', rendererConfig({ command: 'build', mode: 'production' })],
    ['web', webConfig],
  ])('bundles and verifies fallback workers for the %s renderer', (_target, config) => {
    const plugins = config.plugins.flat(Infinity).filter(Boolean);
    const fallback = plugins.find(({ name }) => name === 'fate-bundle-monaco-fallback-worker');
    const integrity = plugins.find(({ name }) => name === 'fate-verify-emitted-renderer-modules');
    expect(fallback?.apply).toBe('build');
    expect(fallback?.enforce).toBe('pre');
    expect(integrity?.apply).toBe('build');
    expect(integrity?.enforce).toBe('post');
  });
});
