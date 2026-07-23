import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GitChange, GitDiff, GitStatus } from '../../shared/contracts/ipc';
import { FilesystemService, isBinaryBuffer, isSafeExternalPath, languageForPath, MAX_FILE_PREVIEW_BYTES } from '../files/FilesystemService';

const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_CHANGES = 10_000;
const MAX_UNTRACKED_LINE_COUNTS = 1_000;

type ExecFailure = Error & { code?: string | number; killed?: boolean };

function execute(root: string, args: string[], maxBuffer = MAX_GIT_OUTPUT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, encoding: 'buffer', maxBuffer, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

function outputTooLarge(error: unknown): boolean {
  const candidate = error as ExecFailure;
  return candidate?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || candidate?.message?.includes('maxBuffer') === true;
}

interface Numstat { additions: number | null; deletions: number | null; binary: boolean }

async function mapLimited<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

export function parseNumstat(output: string): Map<string, Numstat> {
  const records = output.split('\0');
  const result = new Map<string, Numstat>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    let filePath = record.slice(secondTab + 1);
    if (!filePath) {
      // With -z, rename records are: counts + NUL + old path + NUL + new path.
      index += 2;
      filePath = records[index] ?? '';
    }
    if (!filePath) continue;
    const binary = added === '-' || deleted === '-';
    result.set(filePath, {
      additions: binary ? null : Number.parseInt(added, 10) || 0,
      deletions: binary ? null : Number.parseInt(deleted, 10) || 0,
      binary,
    });
  }
  return result;
}

interface ParsedStatus { branch: string; ahead: number; behind: number; changes: Array<Omit<GitChange, 'additions' | 'deletions' | 'binary'>> }

export function parsePorcelainStatus(output: string): ParsedStatus {
  const records = output.split('\0');
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const changes: ParsedStatus['changes'] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('## ')) {
      const branchText = record.slice(3);
      branch = branchText.split('...')[0]?.replace('No commits yet on ', '') ?? '';
      ahead = Number.parseInt(/ahead (\d+)/.exec(branchText)?.[1] ?? '0', 10);
      behind = Number.parseInt(/behind (\d+)/.exec(branchText)?.[1] ?? '0', 10);
      continue;
    }
    if (record.length < 4) continue;
    const indexStatus = record[0] ?? ' ';
    const workTreeStatus = record[1] ?? ' ';
    const currentPath = record.slice(3);
    if (!currentPath) continue;
    if (indexStatus === 'R' || indexStatus === 'C' || workTreeStatus === 'R' || workTreeStatus === 'C') {
      const oldPath = records[index + 1];
      index += 1;
      changes.push({ path: currentPath, ...(oldPath ? { oldPath } : {}), indexStatus, workTreeStatus });
    } else {
      changes.push({ path: currentPath, indexStatus, workTreeStatus });
    }
  }
  return { branch, ahead, behind, changes };
}

export class GitService {
  constructor(private readonly files: FilesystemService) {}

  async status(): Promise<GitStatus> {
    const root = this.files.getRoot();
    let statusOutput: string;
    try {
      statusOutput = (await execute(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])).toString('utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      if (message.includes('not a git repository')) {
        return { repository: false, branch: '', ahead: 0, behind: 0, changes: [], additions: 0, deletions: 0, truncated: false };
      }
      throw error;
    }
    const parsed = parsePorcelainStatus(statusOutput);
    let stats = new Map<string, Numstat>();
    try {
      const output = await execute(root, ['diff', '--numstat', '-z', 'HEAD', '--']);
      stats = parseNumstat(output.toString('utf8'));
    } catch {
      // A repository without a first commit has no HEAD; its files remain honest untracked entries.
    }
    const truncated = parsed.changes.length > MAX_CHANGES;
    const projected = parsed.changes.slice(0, MAX_CHANGES);
    const changes = await mapLimited(projected, 16, async (change, index): Promise<GitChange> => {
      let numstat = stats.get(change.path);
      const untracked = change.indexStatus === '?' && change.workTreeStatus === '?';
      if (!numstat && untracked && index < MAX_UNTRACKED_LINE_COUNTS) {
        try {
          const preview = await this.files.read(change.path);
          if (preview.state === 'text') {
            const content = preview.content ?? '';
            const lines = content.length === 0 ? [] : content.split(/\r?\n/);
            if (lines.at(-1) === '') lines.pop();
            numstat = { additions: lines.length, deletions: 0, binary: false };
          } else if (preview.state === 'binary') numstat = { additions: null, deletions: null, binary: true };
        } catch {
          // The file may disappear while status is being projected; retain unknown counts.
        }
      }
      return {
        ...change,
        additions: numstat?.additions ?? null,
        deletions: numstat?.deletions ?? null,
        binary: numstat?.binary ?? false,
      };
    });
    return {
      repository: true,
      branch: parsed.branch,
      ahead: parsed.ahead,
      behind: parsed.behind,
      changes,
      additions: changes.reduce((sum, change) => sum + (change.additions ?? 0), 0),
      deletions: changes.reduce((sum, change) => sum + (change.deletions ?? 0), 0),
      truncated,
    };
  }

  async diff(relativePath: string): Promise<GitDiff> {
    await this.files.confinePath(relativePath);
    const root = this.files.getRoot();
    const language = languageForPath(relativePath);
    const openable = isSafeExternalPath(relativePath);
    let modified: Buffer | null = null;
    try {
      const kind = await this.files.pathKind(relativePath);
      if (kind === 'directory') {
        return { path: relativePath, state: 'unavailable', language, openable: false, message: 'Submodule and directory changes do not have a text-file preview.' };
      }
      if (kind === 'symlink') {
        return { path: relativePath, state: 'unavailable', language, openable: false, message: 'Symbolic-link changes are not dereferenced for safety.' };
      }
      const absolute = await this.files.resolvePath(relativePath);
      const stat = await fs.stat(absolute);
      if (stat.size > MAX_FILE_PREVIEW_BYTES) {
        return { path: relativePath, state: 'large', language, openable, message: 'The working file is larger than the 1 MiB diff preview limit.' };
      }
      modified = await fs.readFile(absolute);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const normalizedCode = (error as { normalized?: { code?: string; message?: string } }).normalized?.code;
      const normalizedMessage = (error as { normalized?: { message?: string } }).normalized?.message;
      if (code !== 'ENOENT' && !(normalizedCode === 'INVALID_REQUEST' && normalizedMessage?.includes('no longer exists'))) throw error;
    }

    let original: Buffer | null = null;
    let headPath = relativePath;
    try {
      const change = (await this.status()).changes.find((entry) => entry.path === relativePath);
      if (change?.oldPath) {
        await this.files.confinePath(change.oldPath);
        headPath = change.oldPath;
      }
    } catch {
      // Status metadata is an enhancement for rename previews; direct lookup remains valid.
    }
    try {
      original = await execute(root, ['show', `HEAD:${headPath.split(path.sep).join('/')}`], MAX_FILE_PREVIEW_BYTES + 1);
      if (original.length > MAX_FILE_PREVIEW_BYTES) {
        return { path: relativePath, state: 'large', language, openable, message: 'The committed file is larger than the 1 MiB diff preview limit.' };
      }
    } catch (error) {
      if (outputTooLarge(error)) {
        return { path: relativePath, state: 'large', language, openable, message: 'The committed file is larger than the 1 MiB diff preview limit.' };
      }
      const code = (error as ExecFailure).code;
      if (typeof code !== 'number' || code === 0) throw error;
      // Exit 128 is expected for untracked files and repositories without HEAD.
    }

    const originalValue = original ?? Buffer.alloc(0);
    const modifiedValue = modified ?? Buffer.alloc(0);
    if (isBinaryBuffer(originalValue.subarray(0, 8_192)) || isBinaryBuffer(modifiedValue.subarray(0, 8_192))) {
      return { path: relativePath, state: 'binary', language, openable, message: 'Binary files cannot be displayed as text.' };
    }
    return {
      path: relativePath,
      state: 'text',
      original: originalValue.toString('utf8'),
      modified: modifiedValue.toString('utf8'),
      language,
      openable,
    };
  }
}
