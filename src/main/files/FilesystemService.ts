import { shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileEntry, FileList, FilePreview } from '../../shared/contracts/ipc';
import { PiDesktopError } from '../pi/errors';

export const MAX_FILE_PREVIEW_BYTES = 1_048_576;
const MAX_DIRECTORY_ENTRIES = 2_000;
const ignoredDirectories = new Set(['.git', 'node_modules']);
const safeExternalExtensions = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.ini', '.java', '.json', '.jsx', '.log',
  '.md', '.rs', '.scss', '.sql', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml',
]);

function invalidPath(message = 'The requested path is outside the active project.'): never {
  throw new PiDesktopError({ code: 'INVALID_REQUEST', message, retryable: false });
}

function relativeToPosix(value: string): string {
  return value.split(path.sep).join('/');
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  if (buffer.length === 0) return false;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / buffer.length > 0.1;
}

export function isSafeExternalPath(filePath: string): boolean {
  return safeExternalExtensions.has(path.extname(filePath).toLowerCase());
}

export function languageForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cs': 'csharp', '.css': 'css', '.go': 'go', '.html': 'html',
    '.java': 'java', '.js': 'javascript', '.json': 'json', '.jsx': 'javascript', '.md': 'markdown', '.mjs': 'javascript',
    '.php': 'php', '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.scss': 'scss', '.sh': 'shell', '.sql': 'sql',
    '.svg': 'xml', '.toml': 'ini', '.ts': 'typescript', '.tsx': 'typescript', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
  } as Record<string, string>)[extension] ?? 'plaintext';
}

export class FilesystemService {
  private root: string | null = null;

  async setRoot(root: string): Promise<void> {
    const canonical = path.normalize(await fs.realpath(root));
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) invalidPath('The workspace root must be a directory.');
    this.root = canonical;
  }

  clearRoot(): void {
    this.root = null;
  }

  getRoot(): string {
    if (!this.root) {
      throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a project to browse files.', retryable: true });
    }
    return this.root;
  }

  private validateRelative(relativePath: string, allowRoot: boolean): string {
    if (typeof relativePath !== 'string' || relativePath.includes('\0')) invalidPath('The requested path is invalid.');
    if (path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath) || /^[/\\]{2}/.test(relativePath)) invalidPath();
    if (relativePath.includes('\\')) invalidPath('Backslash paths are not accepted.');
    const segments = relativePath.split('/');
    if (segments.some((segment) => segment === '..' || segment === '.')) invalidPath();
    if (!allowRoot && relativePath.length === 0) invalidPath('A file path is required.');
    return relativePath;
  }

  private ensureConfined(candidate: string): void {
    const root = this.getRoot();
    const relative = path.relative(root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) invalidPath();
  }

  async confinePath(relativePath: string): Promise<string> {
    const root = this.getRoot();
    const safeRelative = this.validateRelative(relativePath, false);
    const candidate = path.resolve(root, ...safeRelative.split('/'));
    this.ensureConfined(candidate);
    try {
      const canonical = path.normalize(await fs.realpath(candidate));
      this.ensureConfined(canonical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A missing leaf may still sit below an escaping symlink. Resolve the
      // nearest existing ancestor before allowing Git to receive the path.
      let ancestor = path.dirname(candidate);
      while (ancestor !== root) {
        try {
          this.ensureConfined(path.normalize(await fs.realpath(ancestor)));
          break;
        } catch (ancestorError) {
          if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') throw ancestorError;
          const parent = path.dirname(ancestor);
          if (parent === ancestor) break;
          ancestor = parent;
        }
      }
    }
    return safeRelative;
  }

  async resolvePath(relativePath: string, allowRoot = false): Promise<string> {
    const root = this.getRoot();
    const safeRelative = this.validateRelative(relativePath, allowRoot);
    const candidate = path.resolve(root, ...safeRelative.split('/'));
    this.ensureConfined(candidate);
    let canonical: string;
    try {
      canonical = path.normalize(await fs.realpath(candidate));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The requested project file no longer exists.', retryable: true });
      }
      throw error;
    }
    this.ensureConfined(canonical);
    return canonical;
  }

  async list(relativePath = ''): Promise<FileList> {
    const directory = await this.resolvePath(relativePath, true);
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) invalidPath('The requested path is not a directory.');
    const children = await fs.readdir(directory, { withFileTypes: true });
    const entries: FileEntry[] = [];
    const sorted = children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const child of sorted) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) break;
      if (child.name === '.git' || child.name === 'node_modules') continue;
      const childRelative = relativePath ? `${relativePath}/${child.name}` : child.name;
      try {
        const canonical = await this.resolvePath(childRelative);
        const childStat = await fs.stat(canonical);
        if (!childStat.isFile() && !childStat.isDirectory()) continue;
        entries.push({ path: childRelative, name: child.name, kind: childStat.isDirectory() ? 'directory' : 'file', symlink: child.isSymbolicLink() });
      } catch (error) {
        // Broken and escaping links are intentionally invisible to the renderer.
        if (!(error instanceof PiDesktopError)) throw error;
      }
    }
    return { path: relativePath, entries, truncated: children.length > MAX_DIRECTORY_ENTRIES };
  }

  async search(query: string, limit = 300): Promise<{ entries: FileEntry[]; truncated: boolean }> {
    this.getRoot();
    const normalizedQuery = query.toLocaleLowerCase();
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const matches: FileEntry[] = [];
    let truncated = false;
    const visit = async (directoryPath: string): Promise<void> => {
      if (truncated) return;
      const listing = await this.list(directoryPath);
      if (listing.truncated) truncated = true;
      for (const entry of listing.entries) {
        if (entry.name.toLocaleLowerCase().includes(normalizedQuery) || entry.path.toLocaleLowerCase().includes(normalizedQuery)) {
          if (matches.length >= boundedLimit) { truncated = true; return; }
          matches.push(entry);
        }
        if (entry.kind === 'directory' && !entry.symlink && !ignoredDirectories.has(entry.name)) await visit(entry.path);
        if (truncated) return;
      }
    };
    await visit('');
    return { entries: matches, truncated };
  }

  async pathKind(relativePath: string): Promise<'file' | 'directory' | 'symlink' | 'missing' | 'other'> {
    const root = this.getRoot();
    const safeRelative = this.validateRelative(relativePath, false);
    const candidate = path.resolve(root, ...safeRelative.split('/'));
    this.ensureConfined(candidate);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) return 'symlink';
      if (stat.isFile()) return 'file';
      if (stat.isDirectory()) return 'directory';
      return 'other';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  async read(relativePath: string): Promise<FilePreview> {
    const absolute = await this.resolvePath(relativePath);
    const handle = await fs.open(absolute, 'r');
    try {
      // Size checks and reads use the same open handle so a later path swap
      // cannot substitute a different file after validation.
      const stat = await handle.stat();
      if (!stat.isFile()) invalidPath('The requested path is not a file.');
      const base = { path: relativePath, name: path.basename(absolute), size: stat.size, language: languageForPath(relativePath), openable: isSafeExternalPath(relativePath) };
      const length = Math.min(stat.size, 8_192);
      const sample = Buffer.alloc(length);
      await handle.read(sample, 0, length, 0);
      if (isBinaryBuffer(sample)) return { ...base, state: 'binary' };
      if (stat.size > MAX_FILE_PREVIEW_BYTES) return { ...base, state: 'large' };
      return { ...base, state: 'text', content: await handle.readFile({ encoding: 'utf8' }) };
    } finally {
      await handle.close();
    }
  }

  async open(relativePath: string): Promise<{ opened: boolean; error?: string }> {
    const preview = await this.read(relativePath);
    const extension = path.extname(relativePath).toLowerCase();
    if (preview.state !== 'text' || !safeExternalExtensions.has(extension)) {
      return { opened: false, error: 'Only known text and source files can be opened externally.' };
    }
    const absolute = await this.resolvePath(relativePath);
    const error = await shell.openPath(absolute);
    return error ? { opened: false, error } : { opened: true };
  }
}
