import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserError } from './BrowserErrors';

const WINDOWS_ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\\\\)/iu;
const NETWORK_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const LOCALHOST_ADDRESS = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::\d+)?(?:[/?#]|$)/iu;
const DOMAIN_LIKE = /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,63}(?::\d+)?(?:[/?#]|$)/iu;

export type BrowserAddress =
  | { kind: 'network'; url: string }
  | { kind: 'local-file'; path: string };

export function parseBrowserAddress(value: string, projectRoot: string): BrowserAddress {
  const input = value.trim();
  if (!input) throw new BrowserError('INVALID_URL', 'Enter a URL, search, or local HTML path.');
  if (input === 'about:blank') return { kind: 'network', url: input };

  if (input.toLocaleLowerCase('en-US').startsWith('file:')) {
    try {
      return { kind: 'local-file', path: fileURLToPath(new URL(input)) };
    } catch {
      throw new BrowserError('INVALID_URL', 'That local file URL is invalid.');
    }
  }

  if (WINDOWS_ABSOLUTE_PATH.test(input) || path.isAbsolute(input)) {
    return { kind: 'local-file', path: path.normalize(input) };
  }

  if (looksProjectRelative(input)) {
    return { kind: 'local-file', path: path.resolve(projectRoot, input) };
  }

  const candidate = LOCALHOST_ADDRESS.test(input)
    ? `http://${input}`
    : NETWORK_SCHEME.test(input)
      ? input
      : DOMAIN_LIKE.test(input)
        ? `https://${input}`
        : `https://www.google.com/search?q=${encodeURIComponent(input)}`;
  try {
    const url = new URL(candidate);
    if (url.href === 'about:blank' || url.protocol === 'http:' || url.protocol === 'https:') {
      return { kind: 'network', url: url.href };
    }
    throw new Error('unsupported protocol');
  } catch {
    throw new BrowserError('INVALID_URL', 'Enter an HTTP(S) URL, search, or local HTML path.');
  }
}

function looksProjectRelative(value: string): boolean {
  if (/\s/u.test(value) || value.startsWith('//')) return false;
  const normalized = value.replace(/\\/gu, '/');
  return normalized.startsWith('./')
    || normalized.startsWith('../')
    || /\.(?:html?|xhtml|svg)(?:[?#].*)?$/iu.test(normalized);
}

export function isPathInside(root: string, candidate: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).normalize('NFC');
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
