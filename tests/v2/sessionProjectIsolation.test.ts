import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PiSessionRepository, projectSessionDirectory } from '../../src/main/pi/PiSessionRepository';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 3 })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(privateTestRoot(), 'session-project-isolation-')); roots.push(root);
  const a = path.join(root, 'project-a-b');
  const b = path.join(root, 'project-a', 'b');
  const sessions = path.join(root, 'sessions');
  await Promise.all([fs.mkdir(a, { recursive: true }), fs.mkdir(b, { recursive: true })]);
  const directory = projectSessionDirectory(a, sessions);
  expect(projectSessionDirectory(b, sessions)).toBe(directory); // Real Pi encoding collision.
  await fs.mkdir(directory, { recursive: true });
  const save = async (id: string, cwd: string | undefined, text: string) => {
    const target = path.join(directory, `${id}.jsonl`);
    await fs.writeFile(target, [
      { type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', ...(cwd === undefined ? {} : { cwd }) },
      { type: 'message', id: `${id}-message`, parentId: null, timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    return target;
  };
  return { a, b, sessions, save, repository: new PiSessionRepository(undefined, sessions) };
}

describe('workspace-bound saved sessions with colliding Pi directory names', () => {
  it('does not disclose or mutate another workspace through list/search/resolve/snapshot/history', async () => {
    const { a, b, sessions, save, repository } = await fixture();
    await save('session-a', a, 'Workspace A text');
    const foreignFile = await save('session-b', b, 'B private title and transcript sentinel');
    await save('missing-cwd', undefined, 'Missing authority sentinel');
    await save('relative-cwd', 'project-a-b', 'Relative authority sentinel');
    const before = await fs.readFile(foreignFile);
    const aRows = await repository.list(a, null);
    expect(aRows.map((row) => row.id)).toEqual(['session-a']);
    expect(await repository.list(a, null, 'sentinel')).toEqual([]);
    expect(await repository.resolve(a, 'session-b')).toBeUndefined();
    expect(await repository.readHistoryPage(a, 'session-b')).toBeUndefined();
    const bRows = await repository.list(b, null);
    expect(bRows.map((row) => row.id)).toEqual(['session-b']);
    expect(await repository.snapshot(a, 'session-b', bRows[0])).toBeUndefined();
    expect((await repository.snapshot(b, 'session-b'))?.summary.firstMessage).toContain('B private');
    expect((await repository.readHistoryPage(b, 'session-b'))?.items[0]?.text).toContain('B private');
    await expect(repository.rename(a, 'session-b', 'stolen')).rejects.toThrow();
    expect(await repository.renameIfUnnamed(a, 'session-b', 'stolen')).toBe(false);
    await expect(repository.delete(a, 'session-b')).rejects.toThrow();
    await expect(repository.deleteBranch(a, 'session-b', 'session-b-message', null)).rejects.toThrow();
    expect(await repository.deleteAll(a)).toBe(1);
    expect(await fs.readFile(foreignFile)).toEqual(before);
    expect((await new PiSessionRepository(undefined, sessions).list(b, null)).map((row) => row.id)).toEqual(['session-b']);
  });

  it('checks the actual open-file header rather than a cached or supplied summary', async () => {
    const { a, b, save, repository } = await fixture();
    await save('replaced', a, 'Original A');
    const summary = await repository.resolve(a, 'replaced');
    expect(summary).toBeDefined();
    await save('replaced', b, 'Do not disclose B after replacement');
    expect(await repository.snapshot(a, 'replaced', summary)).toBeUndefined();
    await expect(repository.readHistoryPage(a, 'replaced')).rejects.toThrow(/header.*identity/i);
  });

  it.each(['rename', 'delete', 'deleteBranch'] as const)('does not reuse cached authority for %s after a foreign header replacement', async (operation) => {
    const { a, b, save, repository } = await fixture();
    await save('replaced', a, 'Original A');
    expect(await repository.resolve(a, 'replaced')).toBeDefined();
    const target = await save('replaced', b, 'Retain B after replacement');
    const before = await fs.readFile(target);
    const mutation = operation === 'rename' ? repository.rename(a, 'replaced', 'forbidden')
      : operation === 'delete' ? repository.delete(a, 'replaced') : repository.deleteBranch(a, 'replaced', 'replaced-message', null);
    await expect(mutation).rejects.toThrow();
    expect(await fs.readFile(target)).toEqual(before);
  });

  it('refuses a giant JSONL record at the scan limit without changing source bytes', async () => {
    const { a, save, repository } = await fixture();
    const target = await save('giant', a, 'x'.repeat(9 * 1024 * 1024));
    const before = await fs.stat(target);
    await expect(repository.readHistoryPage(a, 'giant')).rejects.toThrow(/bounded page scan limit/);
    const after = await fs.stat(target);
    expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs });
    await save('small', a, 'A later request remains usable');
    repository.invalidate(a);
    expect((await repository.readHistoryPage(a, 'small'))?.items[0]?.text).toBe('A later request remains usable');
  });

  it.skipIf(process.platform !== 'win32')('compares Windows project identities without case sensitivity', async () => {
    const { a, save, repository } = await fixture();
    await save('case-match', a.toUpperCase(), 'Same Windows project');
    expect((await repository.list(a, null)).map((row) => row.id)).toEqual(['case-match']);
    expect((await repository.snapshot(a, 'case-match'))?.summary.firstMessage).toBe('Same Windows project');
  });
});
