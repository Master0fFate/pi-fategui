import { describe, expect, it } from 'vitest';
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

describe('actual POSIX desktop launcher', () => {
  it('preserves literal metacharacters, -- and new-instance forwarding', () => {
    const root = mkdtempSync(path.join(privateTestRoot(), 'launcher-'));
    try {
      const cli = path.join(root, 'Contents/Resources/cli');
      mkdirSync(cli, { recursive: true }); mkdirSync(path.join(root, 'Contents/MacOS'), { recursive: true });
      copyFileSync('build/cli/fate', path.join(cli, 'fate'));
      writeFileSync(path.join(root, 'Contents/MacOS/fate-ui'), '#!/bin/sh\nprintf "<%s>\\n" "$@"\n', { mode: 0o700 });
      const literal = 'zażółć path;$(touch NEVER_CREATED)';
      expect(execFileSync('/bin/sh', [path.join(cli, 'fate'), literal, '--new-instance'], { encoding: 'utf8' }))
        .toBe(`<--project=${literal}>\n<--new-instance>\n`);
      expect(execFileSync('/bin/sh', [path.join(cli, 'fate'), '--', 'serve'], { encoding: 'utf8' })).toBe('<--project=serve>\n');
      const denied = spawnSync('/bin/sh', [path.join(cli, 'fate'), '--unknown'], { encoding: 'utf8' });
      expect(denied.status).toBe(1); expect(denied.stdout).toBe('');
      for (const profile of ['_host', 'a'.repeat(65), `fc1_${'a'.repeat(43)}`]) {
        const invalid = spawnSync('/bin/sh', [path.join(cli, 'fate'), 'connect', profile], { encoding: 'utf8' });
        expect(invalid.status).toBe(1); expect(invalid.stdout).toBe('');
      }
      const credential = spawnSync('/bin/sh', [path.join(cli, 'fate'), `fc1_${'a'.repeat(43)}`], { encoding: 'utf8' });
      expect(credential.status).toBe(1); expect(credential.stdout).toBe('');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('reports the missing Node companion before an Electron launch', () => {
    const result = spawnSync('/bin/sh', ['build/cli/fate-linux', 'serve', '--profile', 'fixture'],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/separate fate-server Node package/);
  });
});
