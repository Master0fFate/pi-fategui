import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../scripts/test-remote.mjs';

// Deliberately fail (never skip/pass) when the external fixture is absent.
// This executes exactly the same real SSH workflows as pnpm test:remote.
test('T50 real remote workflow (external preinstalled disposable fixture only)', { timeout: 240000 }, async () => {
  const fixture = process.env.FATE_T50_FIXTURE_JSON;
  const evidence = process.env.FATE_T50_EVIDENCE_ROOT;
  assert(fixture && evidence, 'REMOTE_FIXTURE_UNAVAILABLE: explicit fixture and fresh evidence directory required');
  assert.equal(await main(['--fixture', fixture, '--evidence', evidence, '--activate']), 0);
});
