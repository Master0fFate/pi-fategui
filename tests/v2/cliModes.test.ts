import { describe, expect, it, vi } from 'vitest';
import { parseCliArgs } from '../../src/cli/args';

describe('strict CLI mode grammar', () => {
  it('preserves desktop paths, Unicode, spaces and explicit option terminator', () => {
    expect(parseCliArgs(['../zażółć path;$(false)', '--new-instance'])).toEqual({ mode: 'desktop', project: '../zażółć path;$(false)', newInstance: true });
    expect(parseCliArgs(['--', 'serve'])).toEqual({ mode: 'desktop', project: 'serve', newInstance: false });
    expect(parseCliArgs(['./serve']).mode).toBe('desktop');
    expect(parseCliArgs(['--project=project with spaces']).mode).toBe('desktop');
  });
  it.each([['--unknown'], ['serve'], ['serve','--profile','x','--profile','y'], ['serve','--profile','x','--no-auth'],
    ['serve','--profile','x','web'], ['--web','--workspace'], ['a','b'], ['--new-instance','--new-instance'],
    ['init','--profile','x','--workspace','/x'], ['provider','login','--profile','x','--token','secret']])('rejects before effects: %s', (...args) => {
    expect(() => parseCliArgs(args)).toThrow();
  });
  it('rejects secret command-line values and keeps the companion Node-only', () => {
    expect(() => parseCliArgs(['doctor','--profile',`fc1_${'a'.repeat(43)}`])).toThrow();
    expect(() => parseCliArgs(['connect','host'], 'server')).toThrow(/desktop/i);
    expect(() => parseCliArgs(['project'], 'server')).toThrow();
    expect(parseCliArgs(['serve','--profile','safe'], 'server').mode).toBe('serve');
  });
});

describe('native connection launch metadata', () => {
  it('has a fixed read-only companion discovery query and refuses additional arguments', async () => {
    const { runCli } = await import('../../src/cli/main');
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runCli(['--launcher-entry']);
    expect(output).toHaveBeenCalledTimes(1);
    expect(String(output.mock.calls[0]![0])).toContain('"version":1');
    expect(String(output.mock.calls[0]![0])).toContain('main.ts');
    expect(String(output.mock.calls[0]![0])).toMatch(/^[\x00-\x7f]+$/u);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ version: 1, entry: expect.any(String) });
    await expect(runCli(['--launcher-entry', 'doctor'])).rejects.toThrow();
    expect(output).toHaveBeenCalledTimes(1);
  });
  it('only exposes fixed provider guidance, even if an error message is changed', async () => {
    const { ProviderLoginOperatorError } = await import('../../src/cli/providerLogin');
    const error = new ProviderLoginOperatorError('unsupportedProvider');
    error.message = 'synthetic-untrusted-sdk-response';
    expect(error.operatorMessage).toContain('unavailable in this Pi SDK');
    expect(error.operatorMessage).not.toContain('synthetic-untrusted-sdk-response');
    expect(new ProviderLoginOperatorError('interactive').operatorMessage).toContain('interactive host terminal');
    expect(new ProviderLoginOperatorError('cancelled').operatorMessage).toContain('retains SDK ownership');
  });
  it('accepts only one bounded profile selector', async () => {
    const { parseConnectionProfile } = await import('../../src/main/launchProject');
    expect(parseConnectionProfile(['--connection-profile=host'])).toBe('host');
    expect(() => parseConnectionProfile(['--connection-profile=--evil'])).toThrow();
    expect(() => parseConnectionProfile(['--connection-profile=a','--connection-profile=b'])).toThrow();
  });
});

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { privateTestRoot } from './helpers/isolatedEnvironment';

// Git's installed POSIX shell on Windows checks only the POSIX wrapper.
// Native cmd/PowerShell launchers have separate checks, not a substitute pass.
const posixShell = process.platform === 'win32'
  ? execFileSync('where.exe', ['sh.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/u)[0]!
  : '/bin/sh';
const shellPath = (value: string) => process.platform === 'win32' ? value.replaceAll('\\', '/') : value;

describe('actual POSIX desktop launcher', () => {
  it('preserves literal metacharacters, -- and new-instance forwarding', () => {
    const root = mkdtempSync(path.join(privateTestRoot(), 'launcher-'));
    try {
      const cli = path.join(root, 'Contents/Resources/cli');
      mkdirSync(cli, { recursive: true }); mkdirSync(path.join(root, 'Contents/MacOS'), { recursive: true });
      copyFileSync('build/cli/fate', path.join(cli, 'fate'));
      writeFileSync(path.join(root, 'Contents/MacOS/fate-ui'), '#!/bin/sh\nprintf "<%s>\\n" "$@"\n', { mode: 0o700 });
      const literal = 'zażółć path;$(touch NEVER_CREATED)';
      expect(execFileSync(posixShell, [shellPath(path.join(cli, 'fate')), literal, '--new-instance'], { encoding: 'utf8' }))
        .toBe(`<--project=${literal}>\n<--new-instance>\n`);
      expect(execFileSync(posixShell, [shellPath(path.join(cli, 'fate')), '--', 'serve'], { encoding: 'utf8' })).toBe('<--project=serve>\n');
      const denied = spawnSync(posixShell, [shellPath(path.join(cli, 'fate')), '--unknown'], { encoding: 'utf8' });
      expect(denied.status).toBe(1); expect(denied.stdout).toBe('');
      for (const profile of ['_host', 'a'.repeat(65), `fc1_${'a'.repeat(43)}`]) {
        const invalid = spawnSync(posixShell, [shellPath(path.join(cli, 'fate')), 'connect', profile], { encoding: 'utf8' });
        expect(invalid.status).toBe(1); expect(invalid.stdout).toBe('');
      }
      const credential = spawnSync(posixShell, [shellPath(path.join(cli, 'fate')), `fc1_${'a'.repeat(43)}`], { encoding: 'utf8' });
      expect(credential.status).toBe(1); expect(credential.stdout).toBe('');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('reports the missing Node companion before an Electron launch', () => {
    const result = spawnSync(posixShell, ['build/cli/fate-linux', 'serve', '--profile', 'fixture'],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/separate fate-server Node package/);
  });
});
