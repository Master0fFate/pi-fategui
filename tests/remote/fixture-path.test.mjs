import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoIndirectFixturePath } from './fixture-private-storage.mjs';

test('real ancestor junction/symlink is refused before ACL lookup or evidence creation', async () => {
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'t50-path-'));
  try {
    const real=path.join(root,'real'); await fs.mkdir(real,{mode:0o700});
    const file=path.join(real,'synthetic-reference.json'); await fs.writeFile(file,'private synthetic fixture only\n',{mode:0o600});
    const alias=path.join(root,'alias'); await fs.symlink(real,alias,process.platform==='win32'?'junction':'dir');
    await assert.rejects(assertNoIndirectFixturePath(path.join(alias,'synthetic-reference.json')),/indirect ancestor/u);
    await assert.rejects(assertNoIndirectFixturePath(path.join(alias,'must-not-exist'),{missingLeaf:true}),/indirect ancestor/u);
    await assert.rejects(fs.stat(path.join(real,'must-not-exist')),{code:'ENOENT'});
    assert.equal(await fs.readFile(file,'utf8'),'private synthetic fixture only\n');
    assert.equal(await assertNoIndirectFixturePath(file),file);
  } finally {await fs.rm(root,{recursive:true,force:true,maxRetries:3});}
});
