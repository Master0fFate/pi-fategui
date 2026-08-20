import { describe, expect, it } from 'vitest';
import { CrashTelemetryService, buildCrashReport, sanitizeCrashStack } from './CrashTelemetry';

describe('CrashTelemetry', () => {
  it('keeps stack, version, and OS and redacts home directories', () => {
    const stack = 'Error: boom\n    at run (C:\\\\Users\\\\alice\\\\project\\\\src\\\\app.ts:1:1)\n    at /Users/bob/code/index.js:2:2';
    const report = buildCrashReport({ version: '0.9.4-beta2', os: 'win32 10', arch: 'x64', stack, now: 10 });
    expect(report.version).toBe('0.9.4-beta2');
    expect(report.os).toBe('win32 10');
    expect(report.arch).toBe('x64');
    expect(report.stack).not.toContain('alice');
    expect(report.stack).not.toContain('bob');
    expect(sanitizeCrashStack(Array.from({ length: 50 }, (_, index) => `L${index}`).join('\n')).split('\n')).toHaveLength(40);
    expect(JSON.stringify(report)).not.toMatch(/prompt|message text/i);
  });

  it('writes nothing when telemetry is off', async () => {
    const writes: string[] = [];
    const service = new CrashTelemetryService('/tmp/crashes', () => false, () => '1.0.0', async (filePath) => { writes.push(filePath); });
    await expect(service.record('Error: boom')).resolves.toBeNull();
    expect(writes).toEqual([]);
  });
});
