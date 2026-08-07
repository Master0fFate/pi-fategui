import type { FileEntry } from '../../../shared/contracts/ipc';

export interface FileTagContext {
  query: string;
  start: number;
  end: number;
}

export function fileTagContext(draft: string, caret: number): FileTagContext | null {
  const boundedCaret = Math.max(0, Math.min(draft.length, caret));
  const beforeCaret = draft.slice(0, boundedCaret);
  const match = /(^|\s)#([^\s#]*)$/u.exec(beforeCaret);
  if (!match) return null;
  const query = match[2] ?? '';
  const start = boundedCaret - query.length - 1;
  const after = /^[^\s#]*/u.exec(draft.slice(boundedCaret))?.[0] ?? '';
  return { query, start, end: boundedCaret + after.length };
}

export function fileTagText(path: string): string {
  const escaped = path.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
  return /[\s#"\\]/u.test(path) ? `#"${escaped}"` : `#${path}`;
}

export function findFileTags(entries: readonly FileEntry[], limit = 12): FileEntry[] {
  return entries
    .filter((entry) => !entry.symlink && !entry.path.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(entry.path))
    .slice(0, Math.max(0, limit));
}
