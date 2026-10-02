import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import ts from 'typescript';

const monacoWorkerService = '/monaco-editor/esm/vs/editor/browser/services/editorWorkerService.js';
const fallbackWorkerUrl = "new URL('../../common/services/editorWebWorkerMain.js', import.meta.url)";

/** Vite's generic new-URL asset handling copies this module without its imports. */
export function bundleMonacoFallbackWorker(): Plugin {
  return {
    name: 'fate-bundle-monaco-fallback-worker',
    enforce: 'pre',
    apply: 'build',
    transform(code, id) {
      if (!id.split('?')[0]!.replaceAll('\\', '/').endsWith(monacoWorkerService)) return;
      if (code.split(fallbackWorkerUrl).length !== 2) {
        this.error('Monaco fallback worker entry changed; review its explicit worker bundling before building.');
      }
      return {
        code: "import __fateFallbackWorkerUrl from '../../common/services/editorWebWorkerMain.js?worker&url';\n"
          + code.replace(fallbackWorkerUrl, 'new URL(__fateFallbackWorkerUrl, import.meta.url)'),
        map: null,
      };
    },
  };
}

export interface MissingEmittedModule {
  importer: string;
  specifier: string;
  target: string;
}

/** Inspect emitted code as data; never evaluate renderer or worker modules. */
export function findMissingEmittedModules(files: ReadonlyMap<string, string>): MissingEmittedModule[] {
  const missing: MissingEmittedModule[] = [];
  const literal = (node: ts.Node | undefined): string | undefined => node
    && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

  for (const [importer, code] of files) {
    if (!/\.m?js$/u.test(importer)) continue;
    const source = ts.createSourceFile(importer, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    const check = (specifier: string | undefined, assetUrl = false): void => {
      if (!specifier || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(specifier)) return;
      if (!assetUrl && !specifier.startsWith('.')) return;
      if (assetUrl && !/\.m?js(?:[?#]|$)/u.test(specifier)) return;
      const pathname = specifier.split(/[?#]/u)[0]!;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), pathname));
      if (!files.has(target)) missing.push({ importer, specifier, target });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        check(literal(node.moduleSpecifier));
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        check(literal(node.arguments[0]));
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
        && node.arguments?.[1]?.getText(source) === 'import.meta.url') {
        check(literal(node.arguments[0]), true);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return missing;
}

/** Fail the renderer build when copied worker assets retain unbundled imports. */
export function verifyEmittedRendererModules(): Plugin {
  return {
    name: 'fate-verify-emitted-renderer-modules',
    apply: 'build',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const files = new Map(Object.entries(bundle).map(([name, file]) => [
          name,
          file.type === 'chunk' ? file.code : typeof file.source === 'string' ? file.source
            : /\.m?js$/u.test(name) ? new TextDecoder().decode(file.source) : '',
        ]));
        const missing = findMissingEmittedModules(files);
        if (missing.length) {
          this.error(`Renderer output contains unresolved local modules:\n${missing.map(({ importer, specifier }) => `${importer} -> ${specifier}`).join('\n')}`);
        }
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  plugins: [
    bundleMonacoFallbackWorker(),
    react(),
    {
      name: 'pi-desktop-csp',
      transformIndexHtml(html) {
        const scriptPolicy = command === 'serve' ? "'self' 'unsafe-inline'" : "'self'";
        return html.replace('__SCRIPT_CSP__', scriptPolicy);
      },
    },
    verifyEmittedRendererModules(),
  ],
  base: './',
  resolve: {
    alias: {
      '@renderer': path.resolve('src/renderer'),
      '@shared': path.resolve('src/shared'),
      'monaco-editor-esm': path.resolve('node_modules/monaco-editor/esm/vs'),
    },
  },
  build: {
    outDir: path.resolve('dist/renderer'),
    emptyOutDir: true,
    // Keep bundled fonts as local files so the strict font-src CSP never blocks
    // Vite-inlined data URLs and the stylesheet stays cheaper to parse.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
}));
