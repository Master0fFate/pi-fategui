import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPrivateWindowsAcl, assertPrivateWindowsAcls, assertPrivateWindowsTree, withPrivateWindowsAclScope } from '../../src/core/storage/WindowsPrivateAcl';
import { privateTestRoot } from './helpers/isolatedEnvironment';

import { setOtherLocalUsersRead } from './helpers/windowsAcl';

const grantOtherLocalUsersRead = (target: string) => setOtherLocalUsersRead(target, true);
describe('Windows server credential privacy', () => {
  it.skipIf(process.platform !== 'win32')('scoped live queries preserve literal Unicode paths and see ACL changes between requests', async () => {
    const directory = await fs.mkdtemp(path.join(privateTestRoot(), 'scope-acl-'));
    const file = path.join(directory, 'literal [é中] $name.txt');
    try {
      await fs.writeFile(file, 'fixture');
      await expect(withPrivateWindowsAclScope(async () => {
        await assertPrivateWindowsAcl(file);
        await assertPrivateWindowsAcls([directory, file]);
        await assertPrivateWindowsTree(directory);
        await grantOtherLocalUsersRead(file);
        await assertPrivateWindowsAcl(file);
      })).rejects.toThrow('Private Windows storage ACL cannot be verified.');
      // A new scope must not inherit authority, either.
      await expect(withPrivateWindowsAclScope(() => assertPrivateWindowsAcls([directory, file]))).rejects.toThrow('cannot be verified');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }, 30_000);
  it.skipIf(process.platform !== 'win32')('scoped tree checks reject a new reparse point instead of reusing an earlier tree result', async () => {
    const directory = await fs.mkdtemp(path.join(privateTestRoot(), 'scope-tree-acl-'));
    try {
      const tree = path.join(directory, 'tree'); const other = path.join(directory, 'other');
      await fs.mkdir(tree); await fs.mkdir(other);
      await expect(withPrivateWindowsAclScope(async () => {
        await assertPrivateWindowsTree(tree);
        await fs.symlink(other, path.join(tree, 'replaced'), 'junction');
        await assertPrivateWindowsTree(tree);
      })).rejects.toThrow('cannot be verified');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }, 30_000);
  it.skipIf(process.platform !== 'win32')('checks every batch member and refuses unsafe or oversized batches without caching', async () => {
    const directory = await fs.mkdtemp(path.join(privateTestRoot(), 'batch-acl-'));
    const file = path.join(directory, 'private.txt');
    try {
      await fs.writeFile(file, 'fixture');
      await expect(assertPrivateWindowsAcls([directory, file])).resolves.toBeUndefined();
      await grantOtherLocalUsersRead(file);
      await expect(assertPrivateWindowsAcls([directory, file])).rejects.toThrow('Private Windows storage ACL cannot be verified.');
      await expect(assertPrivateWindowsAcls(Array.from({ length: 33 }, () => directory))).rejects.toThrow('bounds');
      await expect(assertPrivateWindowsAcls([directory, path.join(directory, 'missing')])).rejects.toThrow('cannot be verified');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }, 30_000);
  it.skipIf(process.platform !== 'win32')('uses system ACL modules even when a parent supplies incompatible PowerShell modules', async () => {
    const directory = await fs.mkdtemp(path.join(privateTestRoot(), 'module-acl-'));
    const previous = process.env.PSModulePath;
    try {
      const module = path.join(directory, 'modules', 'Microsoft.PowerShell.Security');
      await fs.mkdir(module, { recursive: true });
      await fs.writeFile(path.join(module, 'Microsoft.PowerShell.Security.psm1'),
        "throw 'Incompatible parent module must not load'; function Get-Acl {}\n");
      process.env.PSModulePath = path.dirname(module);
      await expect(assertPrivateWindowsAcl(directory)).resolves.toBeUndefined();
      await expect(assertPrivateWindowsTree(directory)).resolves.toBeUndefined();
      await expect(withPrivateWindowsAclScope(async () => {
        await assertPrivateWindowsAcl(directory); await assertPrivateWindowsTree(directory);
      })).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = previous;
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
  it.skipIf(process.platform !== 'win32')('refuses a profile directory with an allow rule for other local users', async () => {
    const directory = await fs.mkdtemp(path.join(privateTestRoot(), 'untrusted-acl-'));
    try {
      await grantOtherLocalUsersRead(directory);
      await expect(assertPrivateWindowsAcl(directory)).rejects.toThrow('Private Windows storage ACL cannot be verified.');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }, 30_000);
  it.skipIf(process.platform !== 'win32')('rejects an unsafe provider file inside an otherwise private profile', async () => {
    const directory = await fs.mkdtemp(path.join(privateTestRoot(), 'nested-acl-'));
    try {
      const data = path.join(directory, 'data');
      await fs.mkdir(data);
      const provider = path.join(data, 'auth.json');
      await fs.writeFile(provider, '{"fake":"private"}');
      await assertPrivateWindowsTree(directory);
      await grantOtherLocalUsersRead(provider);
      await expect(assertPrivateWindowsTree(directory)).rejects.toThrow('Private Windows storage ACL cannot be verified.');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }, 30_000);
});
