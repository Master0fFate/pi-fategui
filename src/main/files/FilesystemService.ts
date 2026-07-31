import { shell } from 'electron';
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileEntry, FileList, FilePreview, RuntimeImage } from '../../shared/contracts/ipc';
import { PiDesktopError } from '../pi/errors';
import { encodedImageSize, MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_IMAGE_DIMENSION, MAX_PROMPT_IMAGE_TOTAL_PIXELS } from '../pi/PiPromptImages';

export const MAX_FILE_PREVIEW_BYTES = 1_048_576;
const MAX_DIRECTORY_ENTRIES = 2_000;
const MAX_DIRECTORY_SCAN_ENTRIES = 100_000;
const MAX_SEARCH_VISITED_ENTRIES = 50_000;
const MAX_FUZZY_TOKEN_LENGTH = 128;
const SEARCH_INDEX_TTL_MS = 10_000;
const SEARCH_YIELD_INTERVAL = 128;
const ignoredDirectories = new Set(['.git', 'node_modules']);
const safeExternalExtensions = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.ini', '.java', '.json', '.jsx', '.log',
  '.md', '.rs', '.scss', '.sql', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml',
]);

function invalidPath(message = 'The requested path is outside the active project.'): never {
  throw new PiDesktopError({ code: 'INVALID_REQUEST', message, retryable: false });
}

function normalizedSearchTokens(value: string): string[] {
  return value
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 32)
    .map((token) => token.slice(0, MAX_FUZZY_TOKEN_LENGTH));
}

function editDistance(left: string, right: string, maximum: number): number | null {
  if (Math.abs(left.length - right.length) > maximum) return null;
  const cutoff = maximum + 1;
  let previous = new Uint16Array(right.length + 1);
  let current = new Uint16Array(right.length + 1);
  previous.fill(cutoff);
  for (let index = 0; index <= Math.min(right.length, maximum); index += 1) previous[index] = index;

  // Only cells inside the maximum-distance diagonal band can affect the answer.
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current.fill(cutoff);
    if (leftIndex <= maximum) current[0] = leftIndex;
    const start = Math.max(1, leftIndex - maximum);
    const end = Math.min(right.length, leftIndex + maximum);
    let rowMinimum = cutoff;
    for (let rightIndex = start; rightIndex <= end; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      const value = Math.min(previous[rightIndex]! + 1, current[rightIndex - 1]! + 1, substitution);
      current[rightIndex] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maximum) return null;
    [previous, current] = [current, previous];
  }
  const distance = previous[right.length]!;
  return distance <= maximum ? distance : null;
}

function subsequenceGaps(needle: string, candidate: string): number | null {
  let position = 0;
  let first = -1;
  let last = -1;
  for (const character of needle) {
    const found = candidate.indexOf(character, position);
    if (found === -1) return null;
    if (first === -1) first = found;
    last = found;
    position = found + 1;
  }
  return last - first + 1 - needle.length;
}

function tokenScore(query: string, candidate: string): number | null {
  if (query === candidate) return 0;
  if (candidate.startsWith(query)) return 2 + Math.min(3, candidate.length - query.length) * 0.1;
  const containedAt = candidate.indexOf(query);
  if (containedAt >= 0) return 4 + containedAt * 0.1;
  if (query.length < 3) return null;
  const gaps = subsequenceGaps(query, candidate);
  if (gaps !== null && gaps <= Math.max(2, Math.floor(query.length * 0.35))) return 8 + gaps;
  const maximumDistance = query.length >= 7 ? 2 : query.length >= 4 ? 1 : 0;
  if (maximumDistance === 0 || query.length > MAX_FUZZY_TOKEN_LENGTH || candidate.length > MAX_FUZZY_TOKEN_LENGTH) return null;
  const distance = editDistance(query, candidate, maximumDistance);
  return distance === null ? null : 12 + distance * 2 + Math.abs(candidate.length - query.length) * 0.1;
}

interface SearchIndexEntry {
  entry: FileEntry;
  nameTokens: readonly string[];
  pathTokens: readonly string[];
  stem: string;
  depth: number;
}

interface ScoredSearchEntry {
  indexed: SearchIndexEntry;
  score: number;
}

function indexSearchEntry(entry: FileEntry): SearchIndexEntry {
  return {
    entry,
    nameTokens: normalizedSearchTokens(entry.name),
    pathTokens: normalizedSearchTokens(entry.path),
    stem: normalizedSearchTokens(entry.name.slice(0, Math.max(0, entry.name.length - path.extname(entry.name).length))).join(' '),
    depth: entry.path.split('/').length,
  };
}

function fuzzyPathScore(indexed: SearchIndexEntry, queryTokens: readonly string[], queryPhrase: string): number | null {
  let score = indexed.stem === queryPhrase ? -6 : indexed.stem.startsWith(`${queryPhrase} `) ? -2 : 0;
  for (const queryToken of queryTokens) {
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of indexed.pathTokens) {
      const candidateScore = tokenScore(queryToken, candidate);
      if (candidateScore !== null) best = Math.min(best, candidateScore + (indexed.nameTokens.includes(candidate) ? 0 : 1.5));
    }
    if (!Number.isFinite(best)) return null;
    score += best;
  }
  return score + indexed.depth * 0.05;
}

function compareSearchEntries(left: ScoredSearchEntry, right: ScoredSearchEntry): number {
  return left.score - right.score
    || left.indexed.entry.path.localeCompare(right.indexed.entry.path, undefined, { numeric: true, sensitivity: 'base' });
}

function siftSearchHeapUp(heap: ScoredSearchEntry[], start: number): void {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareSearchEntries(heap[index]!, heap[parent]!) <= 0) break;
    [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
    index = parent;
  }
}

function siftSearchHeapDown(heap: ScoredSearchEntry[]): void {
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && compareSearchEntries(heap[left]!, heap[worst]!) > 0) worst = left;
    if (right < heap.length && compareSearchEntries(heap[right]!, heap[worst]!) > 0) worst = right;
    if (worst === index) return;
    [heap[index], heap[worst]] = [heap[worst]!, heap[index]!];
    index = worst;
  }
}

function retainBestSearchEntry(heap: ScoredSearchEntry[], candidate: ScoredSearchEntry, limit: number): void {
  if (heap.length < limit) {
    heap.push(candidate);
    siftSearchHeapUp(heap, heap.length - 1);
  } else if (compareSearchEntries(candidate, heap[0]!) < 0) {
    heap[0] = candidate;
    siftSearchHeapDown(heap);
  }
}

function compareDirectoryEntries(left: Dirent, right: Dirent): number {
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
}

function retainDirectoryEntry(heap: Dirent[], candidate: Dirent): void {
  if (heap.length < MAX_DIRECTORY_ENTRIES) {
    heap.push(candidate);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareDirectoryEntries(heap[index]!, heap[parent]!) <= 0) break;
      [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
      index = parent;
    }
    return;
  }
  if (compareDirectoryEntries(candidate, heap[0]!) >= 0) return;
  heap[0] = candidate;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && compareDirectoryEntries(heap[left]!, heap[worst]!) > 0) worst = left;
    if (right < heap.length && compareDirectoryEntries(heap[right]!, heap[worst]!) > 0) worst = right;
    if (worst === index) break;
    [heap[index], heap[worst]] = [heap[worst]!, heap[index]!];
    index = worst;
  }
}

export type RasterImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export function rasterImageMimeType(buffer: Buffer): RasterImageMimeType | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
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
  private searchIndex: { entries: SearchIndexEntry[]; truncated: boolean } | null = null;
  private searchIndexBuild: Promise<{ entries: SearchIndexEntry[]; truncated: boolean }> | null = null;
  private searchIndexTimer: ReturnType<typeof setTimeout> | null = null;
  private searchGeneration = 0;
  private searchRequestGeneration = 0;
  private rootRequestGeneration = 0;
  private rootGeneration = 0;
  private activeExternalOpens = 0;
  private externalOpensSettled: Promise<void> = Promise.resolve();
  private settleExternalOpens: (() => void) | null = null;

  constructor(private readonly maxSearchVisitedEntries = MAX_SEARCH_VISITED_ENTRIES) {}

  async setRoot(root: string): Promise<void> {
    const requestGeneration = ++this.rootRequestGeneration;
    const canonical = path.normalize(await fs.realpath(root));
    const stat = await fs.stat(canonical);
    while (this.activeExternalOpens > 0) await this.externalOpensSettled;
    if (requestGeneration !== this.rootRequestGeneration) throw this.searchSuperseded();
    if (!stat.isDirectory()) invalidPath('The workspace root must be a directory.');
    this.invalidateSearchIndex();
    this.root = canonical;
    this.rootGeneration += 1;
  }

  async clearRoot(): Promise<void> {
    const requestGeneration = ++this.rootRequestGeneration;
    while (this.activeExternalOpens > 0) await this.externalOpensSettled;
    if (requestGeneration !== this.rootRequestGeneration) throw this.searchSuperseded();
    this.invalidateSearchIndex();
    this.root = null;
    this.rootGeneration += 1;
  }

  getRootOrNull(): string | null {
    return this.root;
  }

  getRoot(): string {
    if (!this.root) {
      throw new PiDesktopError({ code: 'RUNTIME_NOT_READY', message: 'Open a project to browse files.', retryable: true });
    }
    return this.root;
  }

  private rootOperation(): { root: string; generation: number } {
    return { root: this.getRoot(), generation: this.rootGeneration };
  }

  private assertRootOperation(operation: { root: string; generation: number }): void {
    if (this.root !== operation.root || this.rootGeneration !== operation.generation) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The active project changed while the file operation was running.', retryable: true });
    }
  }

  private beginExternalOpen(): () => void {
    if (this.activeExternalOpens === 0) {
      this.externalOpensSettled = new Promise<void>((resolve) => { this.settleExternalOpens = resolve; });
    }
    this.activeExternalOpens += 1;
    return () => {
      this.activeExternalOpens -= 1;
      if (this.activeExternalOpens === 0) {
        this.settleExternalOpens?.();
        this.settleExternalOpens = null;
      }
    };
  }

  invalidate(expectedRoot: string): void {
    if (this.getRoot() !== path.normalize(expectedRoot)) return;
    this.invalidateSearchIndex();
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
    const operation = this.rootOperation();
    const directory = await this.resolvePath(relativePath, true);
    this.assertRootOperation(operation);
    const stat = await fs.stat(directory);
    this.assertRootOperation(operation);
    if (!stat.isDirectory()) invalidPath('The requested path is not a directory.');
    const selected: Dirent[] = [];
    let visibleChildren = 0;
    let scannedChildren = 0;
    let scanTruncated = false;
    const handle = await fs.opendir(directory);
    this.assertRootOperation(operation);
    for await (const child of handle) {
      scannedChildren += 1;
      if (scannedChildren > MAX_DIRECTORY_SCAN_ENTRIES) { scanTruncated = true; break; }
      this.assertRootOperation(operation);
      if (child.name === '.git' || child.name === 'node_modules') continue;
      visibleChildren += 1;
      retainDirectoryEntry(selected, child);
    }
    selected.sort(compareDirectoryEntries);

    const entries: FileEntry[] = [];
    for (const child of selected) {
      this.assertRootOperation(operation);
      const childRelative = relativePath ? `${relativePath}/${child.name}` : child.name;
      try {
        const canonical = await this.resolvePath(childRelative);
        this.assertRootOperation(operation);
        const childStat = await fs.stat(canonical);
        this.assertRootOperation(operation);
        if (!childStat.isFile() && !childStat.isDirectory()) continue;
        entries.push({ path: childRelative, name: child.name, kind: childStat.isDirectory() ? 'directory' : 'file', symlink: child.isSymbolicLink() });
      } catch (error) {
        this.assertRootOperation(operation);
        // Broken and escaping links are intentionally invisible to the renderer.
        if (!(error instanceof PiDesktopError)) throw error;
      }
    }
    this.assertRootOperation(operation);
    return { path: relativePath, entries, truncated: scanTruncated || visibleChildren > MAX_DIRECTORY_ENTRIES };
  }

  private invalidateSearchIndex(): void {
    this.searchGeneration += 1;
    this.searchRequestGeneration += 1;
    this.searchIndex = null;
    this.searchIndexBuild = null;
    if (this.searchIndexTimer) clearTimeout(this.searchIndexTimer);
    this.searchIndexTimer = null;
  }

  private searchSuperseded(): PiDesktopError {
    return new PiDesktopError({ code: 'INVALID_REQUEST', message: 'Project search was superseded by a newer request.', retryable: true });
  }

  private assertSearchRoot(expectedRoot: string, generation: number): void {
    if (this.root !== expectedRoot || this.searchGeneration !== generation) throw this.searchSuperseded();
  }

  private async buildSearchIndex(expectedRoot: string, generation: number): Promise<{ entries: SearchIndexEntry[]; truncated: boolean }> {
    const entries: SearchIndexEntry[] = [];
    const pending = [''];
    let scanned = 0;
    let truncated = false;
    while (pending.length > 0 && scanned < this.maxSearchVisitedEntries) {
      this.assertSearchRoot(expectedRoot, generation);
      const directoryPath = pending.pop()!;
      const handle = await fs.opendir(path.join(expectedRoot, ...directoryPath.split('/').filter(Boolean)));
      for await (const child of handle) {
        scanned += 1;
        if (scanned >= this.maxSearchVisitedEntries) { truncated = true; break; }
        if (scanned % SEARCH_YIELD_INTERVAL === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          this.assertSearchRoot(expectedRoot, generation);
        }
        if (child.name === '.git' || child.name === 'node_modules' || child.isSymbolicLink()) continue;
        const kind = child.isDirectory() ? 'directory' : child.isFile() ? 'file' : null;
        if (!kind) continue;
        const childPath = directoryPath ? `${directoryPath}/${child.name}` : child.name;
        const entry: FileEntry = { path: childPath, name: child.name, kind, symlink: false };
        entries.push(indexSearchEntry(entry));
        if (kind === 'directory' && !ignoredDirectories.has(child.name)) pending.push(childPath);
      }
    }
    if (pending.length > 0) truncated = true;
    return { entries, truncated };
  }

  private async getSearchIndex(): Promise<{ entries: SearchIndexEntry[]; truncated: boolean }> {
    if (this.searchIndex) return this.searchIndex;
    if (this.searchIndexBuild) return this.searchIndexBuild;
    const expectedRoot = this.getRoot();
    const generation = this.searchGeneration;
    const build = this.buildSearchIndex(expectedRoot, generation);
    this.searchIndexBuild = build;
    try {
      const index = await build;
      this.assertSearchRoot(expectedRoot, generation);
      this.searchIndex = index;
      this.searchIndexTimer = setTimeout(() => {
        if (this.searchIndex === index) this.searchIndex = null;
        this.searchIndexTimer = null;
      }, SEARCH_INDEX_TTL_MS);
      this.searchIndexTimer.unref();
      return index;
    } finally {
      if (this.searchIndexBuild === build) this.searchIndexBuild = null;
    }
  }

  async search(query: string, limit = 300): Promise<{ entries: FileEntry[]; truncated: boolean }> {
    const expectedRoot = this.getRoot();
    const requestGeneration = ++this.searchRequestGeneration;
    const queryTokens = normalizedSearchTokens(query).slice(0, 8);
    if (queryTokens.length === 0) {
      this.invalidateSearchIndex();
      return { entries: [], truncated: false };
    }
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const index = await this.getSearchIndex();
    if (this.root !== expectedRoot || requestGeneration !== this.searchRequestGeneration) throw this.searchSuperseded();
    const queryPhrase = queryTokens.join(' ');
    const best: ScoredSearchEntry[] = [];
    let matchCount = 0;
    for (let entryIndex = 0; entryIndex < index.entries.length; entryIndex += 1) {
      if (entryIndex > 0 && entryIndex % SEARCH_YIELD_INTERVAL === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.root !== expectedRoot || requestGeneration !== this.searchRequestGeneration) throw this.searchSuperseded();
      }
      const indexed = index.entries[entryIndex]!;
      const score = fuzzyPathScore(indexed, queryTokens, queryPhrase);
      if (score === null) continue;
      matchCount += 1;
      retainBestSearchEntry(best, { indexed, score }, boundedLimit);
    }
    best.sort(compareSearchEntries);
    return {
      entries: best.map(({ indexed }) => indexed.entry),
      truncated: index.truncated || matchCount > boundedLimit,
    };
  }

  async pathKind(relativePath: string): Promise<'file' | 'directory' | 'symlink' | 'missing' | 'other'> {
    const operation = this.rootOperation();
    const safeRelative = this.validateRelative(relativePath, false);
    const candidate = path.resolve(operation.root, ...safeRelative.split('/'));
    this.ensureConfined(candidate);
    try {
      const stat = await fs.lstat(candidate);
      this.assertRootOperation(operation);
      if (stat.isSymbolicLink()) return 'symlink';
      if (stat.isFile()) return 'file';
      if (stat.isDirectory()) return 'directory';
      return 'other';
    } catch (error) {
      this.assertRootOperation(operation);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  async readLocalImage(reference: string): Promise<RuntimeImage> {
    let absolute: string;
    if (/^file:/iu.test(reference)) {
      let parsed: URL;
      try {
        parsed = new URL(reference);
      } catch {
        invalidPath('The local image URL is invalid.');
      }
      if (parsed.protocol !== 'file:' || parsed.hostname) invalidPath('Only local file URLs can be displayed.');
      try {
        absolute = fileURLToPath(parsed);
      } catch {
        invalidPath('The local image URL is invalid.');
      }
    } else {
      const encodedPath = reference.split(/[?#]/u, 1)[0] ?? '';
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(encodedPath);
      } catch {
        invalidPath('The local image path is invalid.');
      }
      if (!decodedPath || decodedPath.includes('\0')) invalidPath('The local image path is invalid.');
      if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(decodedPath) && !/^[A-Za-z]:[\\/]/u.test(decodedPath)) {
        invalidPath('Only local image paths can be displayed.');
      }
      absolute = path.isAbsolute(decodedPath) ? path.normalize(decodedPath) : path.resolve(this.getRoot(), decodedPath);
    }

    const handle = await fs.open(absolute, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) invalidPath('The local image path is not a file.');
      if (stat.size <= 0 || stat.size > MAX_PROMPT_IMAGE_BYTES) invalidPath('Local images must be under 10 MB.');
      const image = await handle.readFile();
      const mimeType = rasterImageMimeType(image);
      const dimensions = mimeType ? encodedImageSize(image, mimeType) : null;
      if (
        !mimeType
        || !dimensions
        || image.length <= 0
        || image.length > MAX_PROMPT_IMAGE_BYTES
        || dimensions.width <= 0
        || dimensions.height <= 0
        || dimensions.width > MAX_PROMPT_IMAGE_DIMENSION
        || dimensions.height > MAX_PROMPT_IMAGE_DIMENSION
        || dimensions.width * dimensions.height > MAX_PROMPT_IMAGE_TOTAL_PIXELS
      ) {
        invalidPath('The local image is malformed, unsupported, or too large to display safely.');
      }
      return { data: image.toString('base64'), mimeType, alt: path.basename(absolute) };
    } finally {
      await handle.close();
    }
  }

  async read(relativePath: string): Promise<FilePreview> {
    const operation = this.rootOperation();
    const absolute = await this.resolvePath(relativePath);
    this.assertRootOperation(operation);
    const handle = await fs.open(absolute, 'r');
    try {
      this.assertRootOperation(operation);
      // Size checks and reads use the same open handle so a later path swap
      // cannot substitute a different file after validation.
      const stat = await handle.stat();
      this.assertRootOperation(operation);
      if (!stat.isFile()) invalidPath('The requested path is not a file.');
      const base = { path: relativePath, name: path.basename(absolute), size: stat.size, language: languageForPath(relativePath), openable: isSafeExternalPath(relativePath) };
      const length = Math.min(stat.size, 8_192);
      const sample = Buffer.alloc(length);
      await handle.read(sample, 0, length, 0);
      this.assertRootOperation(operation);
      const imageMimeType = rasterImageMimeType(sample);
      let preview: FilePreview;
      if (stat.size > MAX_FILE_PREVIEW_BYTES) preview = { ...base, state: 'large' };
      else if (imageMimeType) preview = { ...base, state: 'image', content: (await handle.readFile()).toString('base64'), mimeType: imageMimeType };
      else if (isBinaryBuffer(sample)) preview = { ...base, state: 'binary' };
      else preview = { ...base, state: 'text', content: await handle.readFile({ encoding: 'utf8' }) };
      this.assertRootOperation(operation);
      return preview;
    } finally {
      await handle.close();
    }
  }

  async open(relativePath: string): Promise<{ opened: boolean; error?: string }> {
    const operation = this.rootOperation();
    if (await this.pathKind(relativePath) === 'symlink') {
      this.assertRootOperation(operation);
      return { opened: false, error: 'Linked files cannot be opened through the system shell.' };
    }
    this.assertRootOperation(operation);
    const preview = await this.read(relativePath);
    this.assertRootOperation(operation);
    const absolute = await this.resolvePath(relativePath);
    this.assertRootOperation(operation);
    const requestedExtension = path.extname(relativePath).toLowerCase();
    const canonicalExtension = path.extname(absolute).toLowerCase();
    if (
      preview.state !== 'text'
      || !safeExternalExtensions.has(requestedExtension)
      || !safeExternalExtensions.has(canonicalExtension)
    ) {
      this.assertRootOperation(operation);
      return { opened: false, error: 'Only known text and source files can be opened externally.' };
    }
    this.assertRootOperation(operation);
    const releaseExternalOpen = this.beginExternalOpen();
    try {
      const error = await shell.openPath(absolute);
      this.assertRootOperation(operation);
      return error ? { opened: false, error } : { opened: true };
    } finally {
      releaseExternalOpen();
    }
  }
}
