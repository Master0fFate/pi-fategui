// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureNodePtyHelper } from './ensure-node-pty-helper.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function checkout(bases) {
  // The module resolver returns real paths. On macOS the temp directory is
  // behind a symlink (/var -> /private/var), so compare against the real root.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fate-node-pty-helper-')));
  roots.push(root);
  const pty = path.join(root, 'node_modules', 'node-pty');
  mkdirSync(pty, { recursive: true });
  writeFileSync(path.join(pty, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }));
  const helpers = bases.map((base) => {
    mkdirSync(path.join(pty, base), { recursive: true });
    const helper = path.join(pty, base, 'spawn-helper');
    writeFileSync(helper, 'published without the executable bit');
    chmodSync(helper, 0o644);
    return helper;
  });
  return { from: pathToFileURL(path.join(root, 'resolve-from.mjs')).href, helpers };
}

describe('node-pty spawn-helper repair for a source checkout', () => {
  it('makes only the macOS helper for the requested architecture executable', () => {
    const fixture = checkout(['prebuilds/darwin-arm64', 'prebuilds/darwin-x64']);
    expect(ensureNodePtyHelper('darwin', 'arm64', fixture.from)).toEqual([fixture.helpers[0]]);
    if (process.platform !== 'win32') {
      // Windows has no executable mode bits; the selection above is the check there.
      expect(statSync(fixture.helpers[0]).mode & 0o111).not.toBe(0);
      expect(statSync(fixture.helpers[1]).mode & 0o111).toBe(0);
      expect(ensureNodePtyHelper('darwin', 'arm64', fixture.from)).toEqual([]);
    }
  });

  it('changes nothing on other platforms or when node-pty is absent', () => {
    const fixture = checkout(['prebuilds/darwin-arm64']);
    expect(ensureNodePtyHelper('linux', 'x64', fixture.from)).toEqual([]);
    expect(ensureNodePtyHelper('win32', 'x64', fixture.from)).toEqual([]);
    const empty = mkdtempSync(path.join(os.tmpdir(), 'fate-node-pty-absent-'));
    roots.push(empty);
    expect(ensureNodePtyHelper('darwin', 'arm64', pathToFileURL(path.join(empty, 'resolve-from.mjs')).href)).toEqual([]);
  });
});
