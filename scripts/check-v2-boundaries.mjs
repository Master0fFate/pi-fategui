#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sourceExtension = /\.[cm]?[jt]sx?$/u;
const nonProduction = /(?:\.d\.[cm]?ts$|\.(?:test|spec)\.[cm]?[jt]sx?$|[/\\](?:__tests__|fixtures)[/\\])/u;
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));
const nativePackages = /^(?:electron(?:\/|$)|@electron\/|uiohook-napi(?:\/|$)|transcribe-cpp(?:\/|$)|@transcribe-cpp\/|koffi(?:\/|$)|@koromix\/|node-pty(?:\/|$)|node-gyp-build(?:\/|$))/u;
const desktopModule = /^src\/main\/(?:browser\/|speech\/|music\/|updates\/|windows\/|native\/|index\.[cm]?ts$|pi\/BrowserRuntimeBridge\.[cm]?ts$|projects\/DesktopProjectAdapter\.[cm]?ts$|files\/DesktopFileActions\.[cm]?ts$)/u;
const browserForbiddenModule = /^src\/(?:core|server|cli|main|preload)\//u;
const nodeHostPackages = /^(?:@earendil-works\/pi-(?:coding-agent|ai)(?:\/|$)|@modelcontextprotocol\/sdk\/server(?:\/|$))/u;
const ambientNativeTypes = new Set(['Document', 'Window', 'HTMLElement', 'SVGElement', 'Element', 'EventTarget', 'MouseEvent', 'KeyboardEvent', 'BrowserWindow', 'WebContentsView']);
const slash = (value) => value.split(path.sep).join('/');

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(file);
    return sourceExtension.test(file) && !nonProduction.test(file) ? [file] : [];
  });
}

/** Parse syntax, never import/execute the module being inspected. */
export function parseEdges(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edges = [];
  const ambientTypes = [];
  const add = (node, expression, typeOnly, kind) => {
    edges.push({
      specifier: expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) ? expression.text : null,
      typeOnly,
      kind,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };
  const visit = (node) => {
    if (ts.isTypeReferenceNode(node) || ts.isTypeQueryNode(node) || ts.isExpressionWithTypeArguments(node)) {
      const name = ts.isTypeReferenceNode(node) ? node.typeName : ts.isTypeQueryNode(node) ? node.exprName : node.expression;
      const terminal = ts.isIdentifier(name) ? name.text : ts.isQualifiedName(name) ? name.right.text : ts.isPropertyAccessExpression(name) ? name.name.text : null;
      if (terminal && ambientNativeTypes.has(terminal)) ambientTypes.push({ name: terminal, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly = !!clause?.isTypeOnly || !!(clause && !clause.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly));
      add(node, node.moduleSpecifier, typeOnly, 'import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.exportClause;
      const typeOnly = node.isTypeOnly || !!(clause && ts.isNamedExports(clause)
        && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly));
      add(node, node.moduleSpecifier, typeOnly, 're-export');
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, node.isTypeOnly, 'import-equals');
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal, true, 'import-type');
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node, node.arguments[0], false, node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic import' : 'require');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { edges, ambientTypes, diagnostics: source.parseDiagnostics };
}

/** Repository source graph. Package internals/native ABI packaging require separate release checks. */
export function checkBoundaries({ root = process.cwd(), headless = [], browser = [] } = {}) {
  root = path.resolve(root);
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile).config : {};
  const compilerOptions = ts.convertCompilerOptionsFromJson(config?.compilerOptions ?? {}, root).options;
  const cache = new Map();
  const failures = [];
  const checked = new Set();
  const relative = (file) => slash(path.relative(root, file));
  const fail = (chain, edge, reason) => failures.push({ chain: chain.map(relative), line: edge?.line ?? 1, specifier: edge?.specifier ?? null, reason });
  const resolve = (specifier, from) => {
    // Vite aliases must resolve into the same graph, not be mistaken for packages.
    const alias = specifier.startsWith('@shared/') ? path.join(root, 'src/shared', specifier.slice(8))
      : specifier.startsWith('@renderer/') ? path.join(root, 'src/renderer', specifier.slice(10)) : null;
    const clean = specifier.split('?')[0];
    const local = alias ?? (clean.startsWith('.') ? path.resolve(path.dirname(from), clean) : path.isAbsolute(clean) ? clean : null);
    const resolved = ts.resolveModuleName(alias ?? clean, from, compilerOptions, ts.sys).resolvedModule;
    if (resolved && !resolved.isExternalLibraryImport && !resolved.resolvedFileName.includes('/node_modules/')) return path.resolve(resolved.resolvedFileName);
    if (local) {
      for (const candidate of [local, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'].map((extension) => local + extension)]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
      return false;
    }
    // Bare packages are leaves, except local paths resolved by tsconfig aliases above.
    return null;
  };
  const walk = (file, mode, chain) => {
    const key = `${mode}:${file}`;
    if (checked.has(key)) return;
    checked.add(key);
    if (!fs.existsSync(file)) { fail(chain, null, 'Protected entry does not exist'); return; }
    if (!sourceExtension.test(file)) return; // e.g. a literal CSS import; never executable TS.
    let parsed = cache.get(file);
    if (!parsed) { parsed = parseEdges(file, fs.readFileSync(file, 'utf8')); cache.set(file, parsed); }
    for (const diagnostic of parsed.diagnostics) fail(chain, null, `Cannot parse protected source: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
    if (mode === 'ports') for (const ambient of parsed.ambientTypes) {
      fail(chain, { line: ambient.line, specifier: null }, `Ambient DOM/native type is forbidden in portable host ports: ${ambient.name}`);
    }
    for (const edge of parsed.edges) {
      if (edge.specifier === null) {
        fail(chain, edge, `Nonliteral ${edge.kind} cannot be checked in a protected closure (no blanket exceptions)`);
        continue;
      }
      const native = nativePackages.test(edge.specifier) || edge.specifier.endsWith('.node');
      const node = edge.specifier.startsWith('node:') || builtins.has(edge.specifier);
      // Native types cannot become browser/wire contracts. Headless implementation-only
      // type edges are erased, so they do not create false Electron runtime failures.
      if (edge.typeOnly && mode === 'headless') continue;
      if (mode === 'ports' && native) {
        fail(chain, edge, 'Native types cannot appear in portable host ports');
        continue;
      }
      // Prohibit alternate module loaders instead of pretending AST literal-import
      // traversal can track arbitrary createRequire aliases and callbacks.
      if (!edge.typeOnly && (edge.specifier === 'node:module' || edge.specifier === 'module')) {
        fail(chain, edge, 'Module loader APIs are forbidden in protected closures; use static imports or literal import()');
        continue;
      }
      // T37: the optional host-only manual shell has one audited lazy loading site.
      // The portable core receives a loader and the browser can never import it.
      // Never generalize this exception to a directory, package, or static import.
      const optionalHostPty = mode === 'headless' && relative(file) === 'src/server/ws/TerminalBridge.ts'
        && edge.kind === 'dynamic import' && edge.specifier === 'node-pty';
      if ((native && !optionalHostPty) || (mode === 'browser' && (node || nodeHostPackages.test(edge.specifier)))) {
        fail(chain, edge, `${edge.typeOnly ? 'Type' : 'Runtime'} dependency is forbidden in ${mode}: ${edge.specifier}`);
        continue;
      }
      const target = resolve(edge.specifier, file);
      if (target === false) { fail(chain, edge, 'Unresolved local import; boundary cannot be established'); continue; }
      if (!target) continue;
      const targetName = relative(target);
      if (mode === 'browser' ? browserForbiddenModule.test(targetName) : desktopModule.test(targetName)) {
        fail([...chain, target], edge, `Forbidden ${mode} dependency: ${targetName}`);
        continue;
      }
      // Follow type edges in browser contracts too: an indirect re-export must not leak
      // host/native types. They remain ignored for Node implementation closures.
      walk(target, mode, [...chain, target]);
    }
  };
  const defaultHeadless = ['src/core', 'src/server', 'src/cli'].flatMap((area) => filesUnder(path.join(root, area)));
  const portableServices = ['src/main/files/FilesystemService.ts', 'src/main/pi/PiPromptImages.ts'];
  defaultHeadless.push(...portableServices.map((file) => path.join(root, file)).filter((file) => fs.existsSync(file)));
  const defaultBrowser = ['src/client', 'src/shared', 'src/renderer'].flatMap((area) => filesUnder(path.join(root, area)));
  for (const file of [...defaultHeadless, ...headless.map((file) => path.resolve(root, file))]) walk(file, 'headless', [file]);
  const publicPorts = path.join(root, 'src/core/ports.ts');
  if (fs.existsSync(publicPorts)) walk(publicPorts, 'ports', [publicPorts]);
  for (const file of [...defaultBrowser, ...browser.map((file) => path.resolve(root, file))]) walk(file, 'browser', [file]);
  return { ok: failures.length === 0, checked: checked.size, failures };
}

function main(args) {
  const options = { headless: [], browser: [] };
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') json = true;
    else if (['--root', '--headless', '--browser'].includes(arg) && args[index + 1]) {
      const value = args[++index];
      if (arg === '--root') options.root = value;
      else options[arg.slice(2)].push(value);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  const result = checkBoundaries(options);
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const failure of result.failures) console.error(`${failure.chain.join(' -> ')}:${failure.line}: ${failure.reason}`);
    console.log(`V2 boundaries: ${result.ok ? 'PASS' : 'FAIL'} (${result.checked} source/mode pairs; ${result.failures.length} violations)`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
