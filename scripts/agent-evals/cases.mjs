export const cases = {
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
