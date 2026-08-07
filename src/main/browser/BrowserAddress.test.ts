import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isPathInside, parseBrowserAddress } from './BrowserAddress';

const root = path.resolve('C:/workspace/demo');

describe('parseBrowserAddress', () => {
  it('keeps HTTP URLs and treats localhost as HTTP', () => {
    expect(parseBrowserAddress('https://example.com/docs', root)).toEqual({ kind: 'network', url: 'https://example.com/docs' });
    expect(parseBrowserAddress('localhost:4173/preview', root)).toEqual({ kind: 'network', url: 'http://localhost:4173/preview' });
  });

  it('accepts absolute, relative, and file URL paths', () => {
    const absolute = path.resolve(root, 'dist/index.html');
    expect(parseBrowserAddress(absolute, root)).toEqual({ kind: 'local-file', path: path.normalize(absolute) });
    expect(parseBrowserAddress('./dist/index.html', root)).toEqual({ kind: 'local-file', path: absolute });
    const fileUrl = pathToFileURL(absolute);
    expect(parseBrowserAddress(fileUrl.href, root)).toEqual({ kind: 'local-file', path: path.normalize(absolute) });
  });

  it('turns ordinary text into a search without mistaking dotted paths for queries', () => {
    expect(parseBrowserAddress('responsive pricing cards', root)).toEqual({
      kind: 'network',
      url: 'https://www.google.com/search?q=responsive%20pricing%20cards',
    });
    expect(parseBrowserAddress('preview.html', root)).toEqual({ kind: 'local-file', path: path.join(root, 'preview.html') });
  });
});

describe('isPathInside', () => {
  it('accepts descendants and rejects sibling-prefix escapes', () => {
    expect(isPathInside(root, path.join(root, 'assets/app.js'))).toBe(true);
    expect(isPathInside(root, `${root}-private/secret.html`)).toBe(false);
    expect(isPathInside(root, path.resolve(root, '../secret.html'))).toBe(false);
  });
});
