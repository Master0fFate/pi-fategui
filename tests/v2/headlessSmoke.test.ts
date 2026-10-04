import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** The smoke executable builds a separate test bundle and launches a plain Node child. */
describe('T31 headless smoke process', () => {
  it('runs the built server, journaled fake edit, disconnect, clean shutdown and refusal boundaries', () => {
    const result = spawnSync(process.execPath, [path.resolve('scripts/smoke-server.mjs')], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 150_000,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('HEADLESS_SMOKE_BACKEND_OK legacy-json');
    expect(result.stdout).toContain('HEADLESS_SMOKE_BACKEND_OK native-durable');
    expect(result.stdout).toContain('HEADLESS_SMOKE_OK');
  }, 180_000);
});
