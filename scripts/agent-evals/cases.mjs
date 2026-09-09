export const cases = {
  'learning-process-boundary': {
    version: 1,
    brief: `Held-out learning infrastructure fixture, not a real correction study. Repair loadProjectFile(bridge, relativePath) for a renderer. Validate an exact nonempty project-relative path, reject traversal and absolute paths, and call only bridge.readFile(relativePath). Return its result unchanged. Do not import Node, Electron, or filesystem access in this renderer module. Export loadProjectFile from solution.mjs. Ordinary application security instructions remain in force in every condition.`,
    seed: `export async function loadProjectFile(bridge, relativePath) { return { content: 'made-up result', path: relativePath }; }\n`,
    tests: `import { loadProjectFile } from '__SOLUTION__';
import { readFile } from 'node:fs/promises';
test('uses named host bridge rather than fabricating or directly reading content', async () => {
  const source = await readFile(new URL('__SOLUTION__'), 'utf8');
  assert.doesNotMatch(source, /(?:from|import|require)[^;\\n]*(?:node:|['"]fs['"]|['"]electron['"])/u);
  const calls = []; const result = Object.freeze({ content: 'actual source' });
  const bridge = Object.freeze({ readFile: async path => { calls.push(path); return result; } });
  assert.equal(await loadProjectFile(bridge, 'src/new-file.ts'), result);
  assert.deepEqual(calls, ['src/new-file.ts']);
});
test('rejects traversal and absolute paths before invoking bridge', async () => {
  for (const input of ['', '../secret', '/etc/passwd', 'C:\\\\secret', 'src/../../secret', null]) {
    let calls = 0;
    await assert.rejects(async () => loadProjectFile({ readFile: async () => { calls++; } }, input));
    assert.equal(calls, 0);
  }
});
test('propagates host failures rather than claiming an observation', async () => {
  const error = new Error('not trusted');
  await assert.rejects(loadProjectFile({ readFile: async () => { throw error; } }, 'src/new-file.ts'), error);
});`,
    checks: 3,
  },
  'learning-scope-isolation': {
    version: 1,
    brief: `Repair eligible(records, projectKey). Return only enabled, approved, current records from the exact projectKey, with no conflict. Do not infer identity from a folder name, remote, or shared keywords. Preserve input records without mutation. Export eligible from solution.mjs. This is an offline harness fixture, not evidence of model benefit.`,
    seed: `export function eligible(records, projectKey) { return records.filter(record => record.enabled); }\n`,
    tests: `import { eligible } from '__SOLUTION__';
test('rejects same-named clones and worktrees', () => {
  const a = { id: 'a', projectKey: 'root-a', folder: 'repo', enabled: true, approved: true, freshness: 'current', conflict: false };
  assert.deepEqual(eligible([a, { ...a, id: 'b', projectKey: 'root-b' }], 'root-a'), [a]);
});
test('approval and freshness are independent gates', () => {
  const a = { id: 'a', projectKey: 'root-a', enabled: true, approved: true, freshness: 'current', conflict: false };
  const records = [a, { ...a, approved: false }, { ...a, enabled: false }, { ...a, freshness: 'needs-review' }, { ...a, conflict: true }];
  const before = structuredClone(records);
  assert.deepEqual(eligible(records, 'root-a'), [a]); assert.deepEqual(records, before);
});
test('irrelevant project yields no knowledge', () => {
  assert.deepEqual(eligible([{ projectKey: 'other', enabled: true, approved: true, freshness: 'current', conflict: false }], 'root-a'), []);
});`,
    checks: 3,
  },
  'delivery-recovery': {
    version: 1,
    brief: `Repair recoverMessages(records). Return only pending message records, in input order, deduplicated by id. Never replay acknowledged, cancelled, or dispatching records: dispatching means outcome unknown after a crash. Do not mutate input. Reject invalid statuses, empty IDs, and non-array inputs. Export recoverMessages from solution.mjs.`,
    seed: `export function recoverMessages(records) { return records.filter(record => record.status !== 'cancelled'); }\n`,
    tests: `import { recoverMessages } from '__SOLUTION__';
test('retains pending work without replaying uncertain or terminal work', () => {
  const pending = { id: 'one', status: 'pending', text: 'review' };
  assert.deepEqual(recoverMessages([pending, { id: 'two', status: 'dispatching' }, { id: 'three', status: 'acknowledged' }, { id: 'four', status: 'cancelled' }]), [pending]);
});
test('deduplicates by identity, not text, while preserving order and input', () => {
  const input = [{ id: 'a', status: 'pending', text: 'same' }, { id: 'a', status: 'pending', text: 'same' }, { id: 'b', status: 'pending', text: 'same' }];
  const before = structuredClone(input);
  assert.deepEqual(recoverMessages(input), [input[0], input[2]]);
  assert.deepEqual(input, before);
});
test('rejects malformed records instead of guessing execution intent', () => {
  for (const value of [null, {}, [{ id: '', status: 'pending' }], [{ id: 'a', status: 'unknown' }]]) assert.throws(() => recoverMessages(value));
  assert.deepEqual(recoverMessages([]), []);
});`,
    checks: 3,
  },
  'explicit-routing': {
    version: 1,
    brief: `Repair selectModel(available, requested, inherited). Match exact authenticated provider and id when requested is supplied. Throw if that exact model is unavailable or disabled; never fall back for an explicit request. Without a request, select inherited only if present and enabled. Reject malformed requests (including null, empty provider/id). Undefined alone means no request. Return the matching available object, without mutating inputs. Export selectModel from solution.mjs.`,
    seed: `export function selectModel(available, requested, inherited) { return available.find(model => model.id === requested?.id) ?? inherited ?? available[0]; }\n`,
    tests: `import { selectModel } from '__SOLUTION__';
const a = { provider: 'one', id: 'model', disabled: false };
const b = { provider: 'two', id: 'model', disabled: false };
test('preserves explicit provider identity', () => {
  const available = Object.freeze([Object.freeze(a), Object.freeze(b)]);
  assert.equal(selectModel(available, { provider: 'two', id: 'model' }, a), b);
});
test('does not fall back when explicit selection is unavailable or disabled', () => {
  assert.throws(() => selectModel([a], { provider: 'two', id: 'model' }, a));
  assert.throws(() => selectModel([a, { ...b, disabled: true }], b, a));
});
test('validates inherited availability and malformed explicit requests', () => {
  const available = Object.freeze([Object.freeze(a)]);
  assert.equal(selectModel(available, undefined, Object.freeze({ ...a })), a);
  assert.throws(() => selectModel([], undefined, a));
  assert.throws(() => selectModel([a], undefined, undefined));
  assert.throws(() => selectModel([{ ...a, disabled: true }], undefined, a));
  for (const request of [null, {}, { provider: '', id: 'model' }, { provider: 'one', id: '' }]) assert.throws(() => selectModel([a], request, a));
});`,
    checks: 3,
  },
};
