import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Electron requires privileged schemes to be registered at module evaluation,
 * before app readiness. The main bundle cannot be imported in unit tests
 * (electron is external), so this characterizes the ordering invariant directly
 * against the composition root source.
 */
describe('protocol registration ordering', () => {
  it('registers privileged schemes at module evaluation, before app readiness', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../index.ts'), 'utf8');
    const registerIndex = source.indexOf('protocol.registerSchemesAsPrivileged');
    const readyIndex = source.indexOf('app.whenReady');
    expect(registerIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(-1);
    expect(registerIndex).toBeLessThan(readyIndex);
  });
});
