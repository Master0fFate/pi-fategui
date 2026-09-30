// Run from the repository root: node scripts/profile-filesystem-sorting.mjs
// CPU-only bounded heap selection + final sorting; no filesystem or Electron latency is measured.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

const WARMUP_PAIRS = 2;
const REPETITIONS = 7;
const sourcePath = new URL('../src/main/files/FilesystemService.ts', import.meta.url);
const source = ts.createSourceFile(sourcePath.pathname, readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.ES2022, true);
const helperNames = [
  'MAX_DIRECTORY_ENTRIES', 'MAX_DIRECTORY_SCAN_ENTRIES', 'MAX_SEARCH_VISITED_ENTRIES', 'filenameCollator',
  'compareDirectoryEntries', 'retainDirectoryEntry', 'compareSearchEntries',
  'siftSearchHeapUp', 'siftSearchHeapDown', 'retainBestSearchEntry',
];
const declarations = new Map();
for (const statement of source.statements) {
  const declaration = ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
    ? statement.declarationList.declarations[0]
    : ts.isFunctionDeclaration(statement) ? statement : undefined;
  if (declaration?.name && ts.isIdentifier(declaration.name) && helperNames.includes(declaration.name.text)) {
    declarations.set(declaration.name.text, statement.getText(source));
  }
}
for (const name of helperNames) assert.ok(declarations.has(name), `Missing production helper: ${name}`);

// Extract the real production helpers without importing Electron or widening the service's public API.
// The control changes only the two comparisons back to the pre-optimization expressions.
function loadHelpers(legacy) {
  const replacements = legacy ? {
    compareDirectoryEntries: `function compareDirectoryEntries(left, right) {
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    }`,
    compareSearchEntries: `function compareSearchEntries(left, right) {
      return left.score - right.score
        || left.indexed.entry.path.localeCompare(right.indexed.entry.path, undefined, { numeric: true, sensitivity: 'base' });
    }`,
  } : {};
  const code = [...declarations].map(([name, text]) => replacements[name] ?? text).join('\n');
  const compiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    reportDiagnostics: true,
  });
  const errors = compiled.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  assert.equal(errors.length, 0, errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  return new Function(`${compiled.outputText}\nreturn { ${helperNames.join(', ')} };`)();
}

const original = loadHelpers(true);
const candidate = loadHelpers(false);

function scored(entry, score = 0) {
  return { indexed: { entry }, score };
}

// Pairwise comparison also checks zero/tie results, not merely a sorted snapshot.
const edgeNames = [
  'file-10.ts', 'File-2.ts', 'FILE-02.ts', 'file-1.ts', 'file-001.ts',
  'A.ts', 'a.ts', 'á.ts', 'a\u0301.ts', 'ä.ts', 'Å.ts', 'ß.ts', 'ss.ts',
  'Σ.ts', 'σ.ts', 'ς.ts', 'İ.ts', 'I.ts', 'ı.ts', '東京-10.ts', '東京-2.ts',
  'image-٢.png', 'image-2.png', '🚀-10.md', '🚀-2.md', 'a-b.ts', 'a_b.ts',
];
for (const leftName of edgeNames) {
  for (const rightName of edgeNames) {
    const left = { name: leftName, path: `src/${leftName}` };
    const right = { name: rightName, path: `src/${rightName}` };
    assert.equal(candidate.compareDirectoryEntries(left, right), original.compareDirectoryEntries(left, right));
    for (const [leftScore, rightScore] of [[0, 0], [-6, 0], [2, -2]]) {
      assert.equal(
        candidate.compareSearchEntries(scored(left, leftScore), scored(right, rightScore)),
        original.compareSearchEntries(scored(left, leftScore), scored(right, rightScore)),
      );
    }
  }
}

function makeCorpus(count, longNames) {
  const stems = ['file', 'FILE', 'fíle', 'Résumé', 're\u0301sume\u0301', '東京', 'Ångström', 'Σύνολο', 'İstanbul', 'straße', '🧪module', 'notes'];
  const entries = Array.from({ length: count }, (_, index) => {
    const number = String(Math.floor(index / stems.length));
    const suffix = longNames ? '-component-snapshot'.repeat(4) : '';
    const name = `${stems[index % stems.length]}-${index % 2 ? number.padStart(6, '0') : number}${suffix}.tsx`;
    return { name, path: `src/${name}` };
  });
  // Deterministic Fisher-Yates shuffle; every repetition sees the same objects in the same order.
  let seed = 0x51f15e;
  for (let index = entries.length - 1; index > 0; index -= 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const other = seed % (index + 1);
    [entries[index], entries[other]] = [entries[other], entries[index]];
  }
  return entries;
}

function selectDirectory(helpers, entries) {
  const heap = [];
  for (const entry of entries) helpers.retainDirectoryEntry(heap, entry);
  return heap.sort(helpers.compareDirectoryEntries);
}

function selectSearch(helpers, entries, limit) {
  const heap = [];
  for (const entry of entries) helpers.retainBestSearchEntry(heap, entry, limit);
  return heap.sort(helpers.compareSearchEntries);
}

function assertSameSelection(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    // Object identity detects any difference in selection or ordering of collated ties.
    assert.equal(actual[index], expected[index], `Selection/tie-order mismatch at ${index}`);
  }
}

function measure(operation, expected) {
  const startCpu = process.cpuUsage();
  const startWall = performance.now();
  const result = operation();
  const wallMs = performance.now() - startWall;
  const cpu = process.cpuUsage(startCpu);
  assertSameSelection(result, expected); // Assertions are deliberately outside the measured interval.
  return { wallMs, cpuMs: (cpu.user + cpu.system) / 1_000 };
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function summarize(samples) {
  return {
    medianWallMs: median(samples.map((sample) => sample.wallMs)),
    medianCpuMs: median(samples.map((sample) => sample.cpuMs)),
    samples,
  };
}

const small = makeCorpus(10_000, false);
const large = makeCorpus(candidate.MAX_DIRECTORY_SCAN_ENTRIES, true);
const searchEntries = (entries) => entries.map((entry, index) => scored(entry, index % 5 === 0 ? -2 : 0));
const smallSearch = searchEntries(small);
const largeSearch = searchEntries(large.slice(0, candidate.MAX_SEARCH_VISITED_ENTRIES));
const workloads = [
  { name: 'directory-10k', entries: small, limit: candidate.MAX_DIRECTORY_ENTRIES, run: selectDirectory },
  { name: 'directory-100k-long-names', entries: large, limit: candidate.MAX_DIRECTORY_ENTRIES, run: selectDirectory },
  { name: 'search-10k-mixed-scores', entries: smallSearch, limit: 300, run: selectSearch },
  { name: 'search-50k-long-paths-mixed-scores', entries: largeSearch, limit: 300, run: selectSearch },
];
const results = [];
for (const workload of workloads) {
  const before = () => workload.run(original, workload.entries, workload.limit);
  const after = () => workload.run(candidate, workload.entries, workload.limit);
  const expected = before();
  assertSameSelection(after(), expected);
  for (let pair = 0; pair < WARMUP_PAIRS; pair += 1) {
    for (const operation of pair % 2 === 0 ? [before, after] : [after, before]) assertSameSelection(operation(), expected);
  }
  const samples = { original: [], candidate: [] };
  for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
    const order = repetition % 2 === 0 ? ['original', 'candidate'] : ['candidate', 'original'];
    for (const version of order) samples[version].push(measure(version === 'original' ? before : after, expected));
  }
  const baseline = summarize(samples.original);
  const optimized = summarize(samples.candidate);
  results.push({
    workload: workload.name,
    inputEntries: workload.entries.length,
    retainedEntries: expected.length,
    baseline,
    optimized,
    medianWallSpeedup: baseline.medianWallMs / optimized.medianWallMs,
    medianCpuSpeedup: optimized.medianCpuMs > 0 ? baseline.medianCpuMs / optimized.medianCpuMs : null,
  });
}

console.log(JSON.stringify({
  note: 'Production heap/comparator functions, same deterministic corpus, no disk I/O, index construction, fuzzy scoring, IPC, or Electron/UI latency. CPU is process user+system time; a zero CPU median indicates timer resolution and yields a null CPU ratio.',
  environment: { node: process.version, v8: process.versions.v8, icu: process.versions.icu, platform: process.platform, arch: process.arch, collation: candidate.filenameCollator.resolvedOptions() },
  warmupPairs: WARMUP_PAIRS,
  repetitions: REPETITIONS,
  pairwiseComparisonChecks: edgeNames.length ** 2 * 4,
  results,
}, null, 2));
