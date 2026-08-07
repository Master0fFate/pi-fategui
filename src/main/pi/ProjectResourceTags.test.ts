// @vitest-environment node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendProjectResourceContext } from './ProjectResourceTags';

const temporary: string[] = [];
async function project(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-resource-tags-'));
  temporary.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe('project resource tags', () => {
  it('expands nested folder tags using portable project-relative paths', async () => {
    const root = await project();
    await fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'main.ts'), 'main');
    await fs.writeFile(path.join(root, 'src', 'nested', 'view.tsx'), 'view');
    await fs.mkdir(path.join(root, 'src', 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'node_modules', 'ignored.ts'), 'ignored');
    const result = await appendProjectResourceContext('Review #src', root);
    expect(result).toContain('Review #src');
    expect(result).toContain('- src/main.ts');
    expect(result).toContain('- src/nested/view.tsx');
    expect(result).not.toContain('ignored.ts');
    expect(result).not.toContain('\\');
  });

  it('parses quoted spaces and hash characters without changing separators', async () => {
    const root = await project();
    await fs.writeFile(path.join(root, 'read me.md'), 'read');
    await fs.writeFile(path.join(root, 'src#old.ts'), 'old');

    const result = await appendProjectResourceContext('Review #"read me.md" #"src#old.ts"', root);
    expect(result).toContain('- read me.md');
    expect(result).toContain('- src#old.ts');
  });

  it('rejects traversal, native absolute paths, and escaping symlinks', async () => {
    const root = await project();
    const outside = await project();
    await fs.writeFile(path.join(outside, 'secret.ts'), 'secret');
    await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await appendProjectResourceContext('Check #../secret.ts #C:/secret.ts #escape', root);
    expect(result).toBe('Check #../secret.ts #C:/secret.ts #escape');
  });

  it('bounds large folder manifests and reports truncation', async () => {
    const root = await project();
    await fs.mkdir(path.join(root, 'generated'));
    await Promise.all(Array.from({ length: 520 }, (_value, index) => (
      fs.writeFile(path.join(root, 'generated', `file-${String(index).padStart(4, '0')}.ts`), '')
    )));

    const result = await appendProjectResourceContext('Inspect #generated', root);
    expect(result).toContain('- generated/file-0499.ts');
    expect(result).not.toContain('- generated/file-0519.ts');
    expect(result).toContain('additional project entries omitted');
  });
});
