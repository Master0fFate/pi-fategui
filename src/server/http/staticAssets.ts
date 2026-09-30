import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

const MAX_ASSET_BYTES = 32 * 1024 * 1024;
function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
  response.end();
}
const mimeTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.avif': 'image/avif',
};

/** A trusted host explicitly supplies the built app directory; request data cannot choose a root. */
export async function createStaticAssetHandler(directory: string): Promise<(target: string, host: string, response: ServerResponse) => Promise<void>> {
  if (!path.isAbsolute(directory) || directory.includes('\0')) throw new Error('The built web directory must be an absolute host path.');
  const rootStat = await fs.lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('The built web directory must be a real directory.');
  const root = await fs.realpath(directory);
  const rootPrefix = `${root}${path.sep}`;
  return async (target, host, response) => {
    // Only a literal asset URL is eligible. Never decode a URL into a filesystem path.
    const segments = (target === '/' ? ['index.html'] : target.slice(1).split('/'));
    if (!target.startsWith('/') || target.startsWith('//') || segments.some((segment) => !segment || segment.startsWith('.')
      || !/^[a-zA-Z0-9_.-]+$/u.test(segment))) { notFound(response); return; }
    const mime = mimeTypes[path.extname(segments.at(-1)!).toLowerCase()];
    if (!mime) { notFound(response); return; }
    let candidate = root;
    try {
      for (const segment of segments) {
        candidate = path.join(candidate, segment);
        const stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink()) { notFound(response); return; }
      }
      const resolved = await fs.realpath(candidate);
      if (!resolved.startsWith(rootPrefix)) { notFound(response); return; }
      const file = await fs.open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) { notFound(response); return; }
        const finalPath = await fs.realpath(candidate);
        if (!finalPath.startsWith(rootPrefix)) { notFound(response); return; }
        const finalStat = await fs.stat(finalPath);
        if (finalStat.dev !== stat.dev || finalStat.ino !== stat.ino) { notFound(response); return; }
        const body = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < body.length) {
          const { bytesRead } = await file.read(body, offset, body.length - offset, offset);
          if (!bytesRead) { notFound(response); return; }
          offset += bytesRead;
        }
        if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) { notFound(response); return; }
        response.writeHead(200, {
          'Content-Type': mime, 'Content-Length': String(body.length), 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self' ws://${host}; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
        });
        response.end(body);
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ELOOP'
        || (error as NodeJS.ErrnoException).code === 'ENOTDIR') { notFound(response); return; }
      throw error;
    }
  };
}
