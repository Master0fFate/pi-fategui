import { execFile, execFileSync } from 'node:child_process';
import { existsSync, promises as fs, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type {
  GitChange,
  GitCombinedDiff,
  GitCommitDetails,
  GitCommitFile,
  GitCommitSummary,
  GitHistory,
  GitOperation,
  GitOperationResult,
  GitRef,
  GitStatus,
  GitDiff,
  GitWorktree,
} from '../../shared/contracts/ipc';
import { FilesystemService, isBinaryBuffer, isSafeExternalPath, languageForPath, MAX_FILE_PREVIEW_BYTES, rasterImageMimeType } from '../files/FilesystemService';
import { worktreeBranchName } from './GitBranchNames';

const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_GIT_RUNTIME_MS = 20_000;
const MAX_GIT_NETWORK_RUNTIME_MS = 60_000;
const MAX_CHANGES = 10_000;
const MAX_UNTRACKED_LINE_COUNTS = 16;
const MAX_ATTRIBUTE_PATHS = 256;
const MAX_ATTRIBUTE_FILE_BYTES = 1_048_576;
const MAX_ATTRIBUTE_TOTAL_BYTES = 2 * 1_048_576;
const MAX_FILTER_DRIVERS = 64;
const MAX_WORKTREES = 500;
const MAX_HISTORY_COMMITS = 500;
const MAX_COMMIT_FILES = 500;
const MAX_COMBINED_DIFF_BYTES = 4_000_000;
const MAX_GIT_OPERATION_OUTPUT = 2_000;
const SAFE_GIT_CONFIG = [
  '-c', 'core.fsmonitor=false',
  '-c', 'diff.external=',
  '-c', 'core.attributesFile=',
  '-c', 'submodule.recurse=false',
] as const;

type ExecFailure = Error & { code?: string | number; killed?: boolean };

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
  };
}

let resolvedGitExecutable: string | null = null;

function trustedGitExecutable(): string {
  if (resolvedGitExecutable) return resolvedGitExecutable;
  const configured = process.env.FATE_UI_GIT_PATH?.trim();
  const candidates = configured && path.isAbsolute(configured) ? [configured] : [];
  if (process.platform === 'win32') {
    const locator = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
    try {
      candidates.push(...execFileSync(locator, ['git'], { cwd: homedir(), encoding: 'utf8', windowsHide: true }).split(/\r?\n/u));
    } catch { /* Report the stable error below. */ }
  } else {
    candidates.push('/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git');
    try {
      candidates.push(...execFileSync('/usr/bin/which', ['git'], { cwd: homedir(), encoding: 'utf8' }).split(/\r?\n/u));
    } catch { /* Conventional absolute paths are still checked. */ }
  }
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate) || !existsSync(candidate)) continue;
    resolvedGitExecutable = realpathSync(candidate);
    return resolvedGitExecutable;
  }
  throw new Error('A trusted Git executable could not be located outside the project directory.');
}

function execute(root: string, args: string[], maxBuffer = MAX_GIT_OUTPUT, additionalConfig: readonly string[] = []): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const executable = trustedGitExecutable();
    const executableRelative = path.relative(root, executable);
    if (executableRelative === '' || (executableRelative !== '..' && !executableRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(executableRelative))) {
      reject(new Error('Refusing to execute Git from inside the untrusted project directory.'));
      return;
    }
    execFile(executable, [`--work-tree=${root}`, ...SAFE_GIT_CONFIG, '-c', `core.worktree=${root}`, ...additionalConfig, ...args], { cwd: root, env: gitEnvironment(), encoding: 'buffer', maxBuffer, timeout: MAX_GIT_RUNTIME_MS, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

let resolvedSshExecutable: string | null | undefined;

function trustedSshExecutable(): string | null {
  if (resolvedSshExecutable !== undefined) return resolvedSshExecutable;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    candidates.push(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'));
    try {
      const locator = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
      candidates.push(...execFileSync(locator, ['ssh'], { cwd: homedir(), encoding: 'utf8', windowsHide: true }).split(/\r?\n/u));
    } catch { /* HTTPS remotes remain available. */ }
  } else {
    candidates.push('/usr/bin/ssh', '/opt/homebrew/bin/ssh', '/usr/local/bin/ssh');
  }
  const selected = candidates.find((candidate) => candidate && path.isAbsolute(candidate) && existsSync(candidate));
  resolvedSshExecutable = selected ? realpathSync(selected) : null;
  return resolvedSshExecutable;
}

function executeConfigScope(root: string, scope: '--system' | '--global'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const environment = gitEnvironment();
    if (scope === '--system') delete environment.GIT_CONFIG_NOSYSTEM;
    execFile(
      trustedGitExecutable(),
      ['config', scope, '-z', '--get-regexp', '^credential\\.'],
      { cwd: root, env: environment, encoding: 'buffer', maxBuffer: 64_000, timeout: MAX_GIT_RUNTIME_MS, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''));
      },
    );
  });
}

function executeNetwork(root: string, args: string[], additionalConfig: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const executable = trustedGitExecutable();
    const executableRelative = path.relative(root, executable);
    if (executableRelative === '' || (executableRelative !== '..' && !executableRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(executableRelative))) {
      reject(new Error('Refusing to execute Git from inside the untrusted project directory.'));
      return;
    }
    const environment = gitEnvironment();
    environment.GIT_ALLOW_PROTOCOL = 'https:http:ssh:git';
    const ssh = trustedSshExecutable();
    if (ssh) environment.GIT_SSH = ssh;
    execFile(
      executable,
      [`--work-tree=${root}`, ...SAFE_GIT_CONFIG, '-c', `core.worktree=${root}`, ...additionalConfig, ...args],
      { cwd: root, env: environment, encoding: 'buffer', maxBuffer: MAX_GIT_OUTPUT, timeout: MAX_GIT_NETWORK_RUNTIME_MS, windowsHide: true },
      (error, stdout, stderr) => {
        const stdoutText = (Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '')).toString('utf8');
        const stderrText = (Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '')).toString('utf8');
        if (error) {
          const message = stderrText.trim() || error.message;
          const failure = Object.assign(new Error(message), { code: (error as ExecFailure).code, killed: (error as ExecFailure).killed });
          reject(failure);
        } else resolve({ stdout: stdoutText, stderr: stderrText });
      },
    );
  });
}

interface AttributeBudget { bytes: number }

function gitAttributeTokens(line: string): string[] {
  const trimmed = line.trimStart();
  if (!trimmed || trimmed.startsWith('#')) return [];
  let pattern = '';
  let remainder = '';
  if (trimmed.startsWith('"')) {
    let escaped = false;
    let closedAt = -1;
    for (let index = 1; index < trimmed.length; index += 1) {
      const character = trimmed[index]!;
      if (escaped) { pattern += character; escaped = false; }
      else if (character === '\\') escaped = true;
      else if (character === '"') { closedAt = index; break; }
      else pattern += character;
    }
    if (escaped || closedAt < 0) throw new Error('Git attributes contain malformed pattern quoting.');
    remainder = trimmed.slice(closedAt + 1);
  } else {
    const separator = trimmed.search(/\s/u);
    pattern = separator < 0 ? trimmed : trimmed.slice(0, separator);
    remainder = separator < 0 ? '' : trimmed.slice(separator);
  }
  return [pattern, ...remainder.trim().split(/\s+/u).filter(Boolean)];
}

function addFilterDriver(driver: string, drivers: Set<string>): void {
  if (!/^[^\u0000-\u001f\u007f=]{1,128}$/u.test(driver)) throw new Error('Git attributes contain an unsupported filter driver.');
  drivers.add(driver);
  if (drivers.size > MAX_FILTER_DRIVERS) throw new Error('Git attributes define too many filter drivers.');
}

function collectFilterDrivers(content: string, drivers: Set<string>): void {
  for (const line of content.split(/\r?\n/u)) {
    for (const token of gitAttributeTokens(line).slice(1)) {
      if (token.startsWith('filter=')) addFilterDriver(token.slice('filter='.length), drivers);
    }
  }
}

async function readAttributeFile(attributePath: string, drivers: Set<string>, budget: AttributeBudget): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(attributePath);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ATTRIBUTE_FILE_BYTES || budget.bytes + stat.size > MAX_ATTRIBUTE_TOTAL_BYTES) {
    throw new Error('Git attributes are too large or linked for safe automatic inspection.');
  }
  const content = await fs.readFile(attributePath, 'utf8');
  budget.bytes += Buffer.byteLength(content);
  collectFilterDrivers(content, drivers);
}

async function safeFilterConfig(root: string): Promise<string[]> {
  const drivers = new Set<string>();
  const budget: AttributeBudget = { bytes: 0 };
  const output = await execute(root, ['ls-files', '-z', '--cached', '--others', '--', '.gitattributes', ':(glob)**/.gitattributes'], 512_000);
  const attributePaths = [...new Set(output.toString('utf8').split('\0').filter(Boolean))];
  if (attributePaths.length > MAX_ATTRIBUTE_PATHS) throw new Error('The repository contains too many Git attribute files for safe automatic inspection.');
  for (const attributePath of attributePaths) {
    const segments = attributePath.split('/');
    if (path.isAbsolute(attributePath) || segments.some((segment) => segment === '..' || segment === '.')) {
      throw new Error('Git reported an invalid attributes path.');
    }
    await readAttributeFile(path.join(root, ...segments), drivers, budget);
    try {
      const indexed = await execute(root, ['show', `:${attributePath}`], MAX_ATTRIBUTE_FILE_BYTES + 1);
      if (indexed.length > MAX_ATTRIBUTE_FILE_BYTES || budget.bytes + indexed.length > MAX_ATTRIBUTE_TOTAL_BYTES) throw new Error('Git attributes are too large for safe automatic inspection.');
      budget.bytes += indexed.length;
      collectFilterDrivers(indexed.toString('utf8'), drivers);
    } catch (error) {
      if (outputTooLarge(error)) throw error;
      const code = (error as ExecFailure).code;
      if (typeof code !== 'number' || code === 0) throw error;
    }
  }
  const configured = (await execute(root, ['config', '--includes', '--name-only', '--list'], 256_000)).toString('utf8');
  for (const name of configured.split(/\r?\n/u).filter(Boolean)) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/iu.exec(name);
    if (match?.[1]) addFilterDriver(match[1], drivers);
  }
  try {
    const gitAttributePath = (await execute(root, ['rev-parse', '--git-path', 'info/attributes'], 16_384)).toString('utf8').trim();
    if (gitAttributePath) await readAttributeFile(path.isAbsolute(gitAttributePath) ? gitAttributePath : path.join(root, gitAttributePath), drivers, budget);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  return [...drivers].flatMap((driver) => [
    '-c', `filter.${driver}.clean=`,
    '-c', `filter.${driver}.smudge=`,
    '-c', `filter.${driver}.process=`,
    '-c', `filter.${driver}.required=false`,
  ]);
}

function outputTooLarge(error: unknown): boolean {
  const candidate = error as ExecFailure;
  return candidate?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || candidate?.message?.includes('maxBuffer') === true;
}

interface Numstat { additions: number | null; deletions: number | null; binary: boolean }

async function mapLimited<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = Array<R>(items.length);
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

function countTextLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) if (content.charCodeAt(index) === 10) lines += 1;
  return content.charCodeAt(content.length - 1) === 10 ? lines - 1 : lines;
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

interface ParsedStatus { branch: string; upstream: string | null; ahead: number; behind: number; changes: Array<Omit<GitChange, 'additions' | 'deletions' | 'binary'>> }

export function parsePorcelainStatus(output: string): ParsedStatus {
  const records = output.split('\0');
  let branch = '';
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const changes: ParsedStatus['changes'] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('## ')) {
      const branchText = record.slice(3);
      const relation = branchText.indexOf('...');
      const local = (relation >= 0 ? branchText.slice(0, relation) : branchText).replace('No commits yet on ', '').trim();
      branch = local === 'HEAD (no branch)' ? '' : local;
      if (relation >= 0) upstream = branchText.slice(relation + 3).split(/[ []/u)[0] || null;
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
  return { branch, upstream, ahead, behind, changes };
}

export function parseGitDecorations(value: string): GitRef[] {
  const refs: GitRef[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: GitRef['kind']) => {
    const key = `${kind}\0${name}`;
    if (!name || seen.has(key) || refs.length >= 64) return;
    seen.add(key);
    refs.push({ name: name.slice(0, 1_000), kind });
  };
  for (const raw of value.split(', ')) {
    const ref = raw.trim();
    if (!ref) continue;
    if (ref.startsWith('HEAD -> refs/heads/')) add(ref.slice('HEAD -> refs/heads/'.length), 'head');
    else if (ref === 'HEAD') add('HEAD', 'head');
    else if (ref.startsWith('refs/heads/')) add(ref.slice('refs/heads/'.length), 'local');
    else if (ref.startsWith('refs/remotes/')) add(ref.slice('refs/remotes/'.length), 'remote');
    else if (ref.startsWith('tag: refs/tags/')) add(ref.slice('tag: refs/tags/'.length), 'tag');
    else if (ref.startsWith('refs/tags/')) add(ref.slice('refs/tags/'.length), 'tag');
    else add(ref.replace(/^refs\//u, ''), 'other');
  }
  return refs;
}

export function parseGitHistory(output: string, limit = MAX_HISTORY_COMMITS): GitHistory {
  const fields = output.split('\0');
  const commits: GitCommitSummary[] = [];
  for (let index = 0; index + 6 < fields.length && commits.length < limit; index += 7) {
    const hash = fields[index] ?? '';
    if (!/^[0-9a-f]{40,64}$/u.test(hash)) break;
    commits.push({
      hash,
      parents: (fields[index + 1] ?? '').split(' ').filter((parent) => /^[0-9a-f]{40,64}$/u.test(parent)).slice(0, 64),
      authorName: (fields[index + 2] || 'Unknown author').slice(0, 500),
      authorEmail: (fields[index + 3] ?? '').slice(0, 500),
      authoredAt: fields[index + 4] ?? new Date(0).toISOString(),
      subject: (fields[index + 5] ?? '').slice(0, 2_000),
      refs: parseGitDecorations(fields[index + 6] ?? ''),
    });
  }
  return { head: commits.find((commit) => commit.refs.some((ref) => ref.kind === 'head'))?.hash ?? commits[0]?.hash ?? null, commits, truncated: false };
}

export function parseGitWorktrees(output: string, currentRoot: string): GitWorktree[] {
  const result: GitWorktree[] = [];
  let candidate: Partial<GitWorktree> = {};
  const flush = () => {
    if (!candidate.path || result.length >= MAX_WORKTREES) { candidate = {}; return; }
    const normalized = path.normalize(candidate.path);
    result.push({
      path: normalized,
      branch: candidate.branch ?? null,
      head: candidate.head ?? null,
      detached: candidate.detached ?? false,
      bare: candidate.bare ?? false,
      current: path.normalize(currentRoot) === normalized,
    });
    candidate = {};
  };
  for (const field of output.split('\0')) {
    if (!field) { flush(); continue; }
    if (field.startsWith('worktree ')) candidate.path = field.slice('worktree '.length);
    else if (field.startsWith('HEAD ')) {
      const head = field.slice('HEAD '.length);
      candidate.head = /^[0-9a-f]{40,64}$/u.test(head) ? head : null;
    } else if (field.startsWith('branch refs/heads/')) candidate.branch = field.slice('branch refs/heads/'.length);
    else if (field === 'detached') candidate.detached = true;
    else if (field === 'bare') candidate.bare = true;
  }
  flush();
  return result;
}

export function parseCommitFiles(nameStatusOutput: string, stats: Map<string, Numstat>, limit = MAX_COMMIT_FILES): { files: GitCommitFile[]; total: number; truncated: boolean } {
  const fields = nameStatusOutput.split('\0');
  const files: GitCommitFile[] = [];
  let total = 0;
  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? '';
    if (!status) continue;
    const renamed = status.startsWith('R') || status.startsWith('C');
    const oldPath = renamed ? fields[index++] : undefined;
    const filePath = fields[index++] ?? '';
    if (!filePath) continue;
    total += 1;
    if (files.length >= limit) continue;
    const stat = stats.get(filePath);
    files.push({
      path: filePath.slice(0, 4_096),
      ...(oldPath ? { oldPath: oldPath.slice(0, 4_096) } : {}),
      status: status.slice(0, 10),
      additions: stat?.additions ?? null,
      deletions: stat?.deletions ?? null,
      binary: stat?.binary ?? false,
    });
  }
  return { files, total, truncated: total > files.length };
}

export function githubRepositoryUrl(remote: string): string | null {
  const value = remote.trim();
  let match = /^https:\/\/github\.com\/([^/\s]+)\/([^\s]+?)(?:\.git)?\/?$/iu.exec(value);
  if (!match) match = /^git@github\.com:([^/\s]+)\/([^\s]+?)(?:\.git)?$/iu.exec(value);
  if (!match) match = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^\s]+?)(?:\.git)?\/?$/iu.exec(value);
  return match?.[1] && match[2] ? `https://github.com/${match[1]}/${match[2]}` : null;
}

export function parseCredentialConfig(output: string): string[] {
  return output.split('\0').filter(Boolean).slice(0, 64).flatMap((entry) => {
    const separator = entry.indexOf('\n');
    if (separator < 1) return [];
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    return /^credential\.(?:helper|usehttppath|username)$/iu.test(key)
      || /^credential\.[^\u0000-\u0020=]{1,2048}\.(?:helper|usehttppath|username)$/iu.test(key)
      ? ['-c', `${key}=${value}`]
      : [];
  });
}

async function trustedCredentialConfig(root: string): Promise<string[]> {
  const readScope = async (scope: '--system' | '--global') => {
    try {
      return parseCredentialConfig((await executeConfigScope(root, scope)).toString('utf8'));
    } catch (error) {
      const code = (error as ExecFailure).code;
      if (typeof code === 'number' && code !== 0) return [];
      throw error;
    }
  };
  const [system, global] = await Promise.all([readScope('--system'), readScope('--global')]);
  return [...system, ...global];
}

interface GitUpstream { remote: string; branch: string; ref: string }
interface GitPushTarget { remote: string; branch: string }
interface RootScopedPreview { state: 'text' | 'binary' | 'image' | 'large' | 'unavailable'; content?: string; data?: Buffer; unavailableReason?: 'directory' | 'symlink' }

function parseGitUpstream(output: string): GitUpstream | null {
  const [remote = '', remoteRef = ''] = output.replace(/\r?\n$/u, '').split('\0');
  const prefix = 'refs/heads/';
  if (!remote || !remoteRef.startsWith(prefix)) return null;
  const branch = remoteRef.slice(prefix.length);
  return branch ? { remote, branch, ref: `${remote}/${branch}` } : null;
}

async function currentUpstream(root: string, branch: string): Promise<GitUpstream | null> {
  try {
    const output = await execute(root, ['for-each-ref', '--count=1', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${branch}`], 16_384);
    return parseGitUpstream(output.toString('utf8'));
  } catch {
    return null;
  }
}

async function resolvePushTarget(root: string, branch: string, upstream: GitUpstream | null): Promise<GitPushTarget | null> {
  const remotes = (await execute(root, ['remote'], 64_000)).toString('utf8').split(/\r?\n/u).map((remote) => remote.trim()).filter(Boolean);
  if (remotes.length === 0) return null;
  const configured = async (key: string): Promise<string | null> => {
    try {
      const value = (await execute(root, ['config', '--get', key], 16_384)).toString('utf8').trim();
      return remotes.includes(value) ? value : null;
    } catch { return null; }
  };
  const remote = (await configured(`branch.${branch}.pushRemote`))
    ?? (await configured('remote.pushDefault'))
    ?? (upstream && remotes.includes(upstream.remote) ? upstream.remote : null)
    ?? (await configured(`branch.${branch}.remote`))
    ?? (remotes.includes('origin') ? 'origin' : null)
    ?? (remotes.length === 1 ? remotes[0]! : null);
  return remote ? { remote, branch: upstream?.branch ?? branch } : null;
}

function utf8Prefix(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) return { value, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && encoded[end] !== undefined && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return { value: encoded.subarray(0, end).toString('utf8'), truncated: true };
}

function boundedGitMessage(operation: GitOperation, stdout: string, stderr: string): string {
  const output = `${stdout}\n${stderr}`.replace(/\u001b\[[0-9;]*m/gu, '').replace(/\r/g, '').trim();
  if (output) return output.slice(0, MAX_GIT_OPERATION_OUTPUT);
  if (operation === 'fetch') return 'Fetched all configured remotes.';
  if (operation === 'pull') return 'Pull completed with a fast-forward update.';
  return 'Push completed.';
}

export class GitService {
  private statusRequest: { root: string; promise: Promise<GitStatus> } | null = null;
  private lastStatus: { root: string; value: GitStatus } | null = null;
  private statusGeneration = 0;
  private readonly diffRequests = new Map<string, Promise<GitDiff>>();
  private readonly diffCache = new Map<string, GitDiff>();
  private historyRequest: { root: string; promise: Promise<GitHistory> } | null = null;
  private readonly commitDetailsCache = new Map<string, GitCommitDetails>();

  constructor(
    private readonly files: FilesystemService,
    private readonly worktreesRoot = path.join(homedir(), '.pi', 'fateGUI', 'worktrees'),
  ) {}

  status(): Promise<GitStatus> {
    const root = this.files.getRoot();
    if (this.statusRequest?.root === root) return this.statusRequest.promise;
    const promise = this.readStatus(root)
      .then((value) => {
        try {
          if (this.files.getRoot() === root) {
            this.lastStatus = { root, value };
            this.statusGeneration += 1;
            this.diffRequests.clear();
            this.diffCache.clear();
          }
        } catch { /* The project closed while status was running. */ }
        return value;
      })
      .finally(() => {
        if (this.statusRequest?.promise === promise) this.statusRequest = null;
      });
    this.statusRequest = { root, promise };
    return promise;
  }

  private rootScopedCandidate(root: string, relativePath: string): string {
    if (
      !relativePath
      || relativePath.includes('\0')
      || relativePath.includes('\\')
      || path.isAbsolute(relativePath)
      || /^[A-Za-z]:[\\/]/u.test(relativePath)
      || /^[/\\]{2}/u.test(relativePath)
      || relativePath.split('/').some((segment) => segment === '.' || segment === '..')
    ) throw new Error('Git reported an invalid project path.');
    const candidate = path.resolve(root, ...relativePath.split('/'));
    const relative = path.relative(root, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Git reported a path outside the selected project root.');
    return candidate;
  }

  private async readRootScopedPreview(root: string, relativePath: string): Promise<RootScopedPreview> {
    const candidate = this.rootScopedCandidate(root, relativePath);
    const pathStat = await fs.lstat(candidate);
    if (pathStat.isSymbolicLink()) return { state: 'unavailable', unavailableReason: 'symlink' };
    if (!pathStat.isFile()) return { state: 'unavailable', unavailableReason: 'directory' };
    const canonical = path.normalize(await fs.realpath(candidate));
    const canonicalRelative = path.relative(root, canonical);
    if (!canonicalRelative || canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
      throw new Error('Git reported a path outside the selected project root.');
    }
    const handle = await fs.open(canonical, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { state: 'unavailable' };
      const sample = Buffer.alloc(Math.min(stat.size, 8_192));
      await handle.read(sample, 0, sample.length, 0);
      const imageMimeType = rasterImageMimeType(sample);
      if (stat.size > MAX_FILE_PREVIEW_BYTES) return { state: 'large' };
      const data = await handle.readFile();
      if (imageMimeType) return { state: 'image', data };
      if (isBinaryBuffer(sample)) return { state: 'binary', data };
      return { state: 'text', content: data.toString('utf8'), data };
    } finally {
      await handle.close();
    }
  }

  private async readStatus(root: string): Promise<GitStatus> {
    let statusOutput: string;
    let stats = new Map<string, Numstat>();
    try {
      const topLevel = (await execute(root, ['rev-parse', '--show-toplevel'], 32_768)).toString('utf8').trim();
      if (!topLevel || path.normalize(realpathSync(topLevel)) !== path.normalize(root)) throw new Error('Git worktree does not match the selected project root.');
      const filterConfig = await safeFilterConfig(root);
      statusOutput = (await execute(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=all'], MAX_GIT_OUTPUT, filterConfig)).toString('utf8');
      try {
        const numstat = await execute(root, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', 'HEAD', '--'], MAX_GIT_OUTPUT, filterConfig);
        stats = parseNumstat(numstat.toString('utf8'));
      } catch (error) {
        // Repositories without HEAD and oversized diff summaries still retain
        // useful status. Their directly-read untracked counts are filled below.
        const code = (error as ExecFailure).code;
        if (!outputTooLarge(error) && !(typeof code === 'number' && code !== 0)) throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      if (message.includes('not a git repository')) {
        return { repository: false, branch: '', upstream: null, pushTarget: null, ahead: 0, behind: 0, changes: [], additions: 0, deletions: 0, truncated: false };
      }
      throw error;
    }
    const parsed = parsePorcelainStatus(statusOutput);
    const upstream = parsed.branch ? await currentUpstream(root, parsed.branch) : null;
    const target = parsed.branch ? await resolvePushTarget(root, parsed.branch, upstream) : null;
    const pushTarget = target ? `${target.remote}/${target.branch}` : null;
    const truncated = parsed.changes.length > MAX_CHANGES;
    const projected = parsed.changes.slice(0, MAX_CHANGES);
    const changes = await mapLimited(projected, 16, async (change, index): Promise<GitChange> => {
      let numstat = stats.get(change.path);
      const untracked = change.indexStatus === '?' && change.workTreeStatus === '?';
      if (!numstat && untracked && index < MAX_UNTRACKED_LINE_COUNTS) {
        try {
          const preview = await this.readRootScopedPreview(root, change.path);
          if (preview.state === 'text') {
            const content = preview.content ?? '';
            numstat = { additions: countTextLines(content), deletions: 0, binary: false };
          } else if (preview.state === 'binary' || preview.state === 'image') numstat = { additions: null, deletions: null, binary: true };
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
      upstream: parsed.upstream,
      pushTarget,
      ahead: parsed.ahead,
      behind: parsed.behind,
      changes,
      additions: changes.reduce((sum, change) => sum + (change.additions ?? 0), 0),
      deletions: changes.reduce((sum, change) => sum + (change.deletions ?? 0), 0),
      truncated,
    };
  }

  async worktrees(): Promise<GitWorktree[]> {
    const root = this.files.getRoot();
    const output = await execute(root, ['worktree', 'list', '--porcelain', '-z'], 1_000_000);
    const parsed = parseGitWorktrees(output.toString('utf8'), root);
    const result: GitWorktree[] = [];
    for (const worktree of parsed) {
      if (result.length >= MAX_WORKTREES || worktree.bare) continue;
      try {
        const canonical = path.normalize(await fs.realpath(worktree.path));
        const stat = await fs.stat(canonical);
        if (!stat.isDirectory()) continue;
        result.push({ ...worktree, path: canonical, current: canonical === path.normalize(root) });
      } catch { /* Worktrees can be prunable or disappear while the menu opens. */ }
    }
    return result;
  }

  async resolveWorktree(candidatePath: string): Promise<string> {
    const canonical = path.normalize(await fs.realpath(candidatePath));
    const worktrees = await this.worktrees();
    const match = worktrees.find((worktree) => path.normalize(worktree.path) === canonical && !worktree.bare);
    if (!match) throw new Error('The selected directory is not a registered worktree for this repository.');
    return canonical;
  }

  async createWorktree(branchSeed: string): Promise<GitWorktree> {
    const root = this.files.getRoot();
    const status = await this.readStatus(root);
    if (!status.repository) throw new Error('An isolated session requires a Git repository.');
    const head = (await execute(root, ['rev-parse', '--verify', 'HEAD'], 16_384)).toString('utf8').trim();
    if (!/^[0-9a-f]{40,64}$/u.test(head)) throw new Error('Create the first commit before starting an isolated worktree session.');

    await fs.mkdir(this.worktreesRoot, { recursive: true });
    const managedRoot = path.normalize(await fs.realpath(this.worktreesRoot));
    const hooksDirectory = await fs.mkdtemp(path.join(tmpdir(), 'fate-ui-git-hooks-'));
    const filterConfig = await safeFilterConfig(root);
    const worktreeConfig = [
      ...filterConfig,
      '-c', `core.hooksPath=${hooksDirectory}`,
      '-c', 'protocol.allow=never',
      '-c', 'protocol.file.allow=never',
      '-c', 'protocol.ext.allow=never',
    ];
    const baseBranch = worktreeBranchName(branchSeed);
    let branch: string | null = null;
    let destination: string | null = null;
    try {
      for (let suffix = 1; suffix <= 100; suffix += 1) {
        const candidate = suffix === 1 ? baseBranch : `${baseBranch}-${suffix}`;
        try {
          await execute(root, ['branch', '--', candidate, 'HEAD'], 64_000, worktreeConfig);
          branch = candidate;
          break;
        } catch (error) {
          try {
            await execute(root, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], 16_384, worktreeConfig);
          } catch {
            throw error;
          }
        }
      }
      if (!branch) throw new Error(`Could not find an available branch name based on ${baseBranch}.`);
      const reserved = await fs.mkdtemp(path.join(managedRoot, 'fate-ui-worktree-'));
      const canonical = path.normalize(await fs.realpath(reserved));
      const relative = path.relative(managedRoot, canonical);
      if (!relative || relative.includes(path.sep) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Refusing to create a worktree outside Fate UI managed storage.');
      }
      destination = canonical;
      await execute(root, ['worktree', 'add', destination, branch], MAX_GIT_OUTPUT, worktreeConfig);
      this.statusRequest = null;
      this.lastStatus = null;
      this.historyRequest = null;
      return { path: canonical, branch, head, detached: false, bare: false, current: false };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (destination) {
        try {
          const listed = parseGitWorktrees((await execute(root, ['worktree', 'list', '--porcelain', '-z'], 1_000_000, worktreeConfig)).toString('utf8'), root);
          if (listed.some((worktree) => path.normalize(worktree.path) === path.normalize(destination!))) {
            await execute(root, ['worktree', 'remove', '--force', destination], MAX_GIT_OUTPUT, worktreeConfig);
          }
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          await fs.rm(destination, { recursive: true, force: true });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (branch) {
        try {
          await execute(root, ['branch', '-D', '--', branch], 64_000, worktreeConfig);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], 'Managed worktree creation failed and rollback was incomplete.');
      throw error;
    } finally {
      await fs.rm(hooksDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async discardCreatedWorktree(worktree: GitWorktree): Promise<void> {
    const root = this.files.getRoot();
    const canonical = await this.resolveWorktree(worktree.path);
    const managedRoot = path.normalize(await fs.realpath(this.worktreesRoot));
    const relative = path.relative(managedRoot, canonical);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Refusing to remove a worktree outside Fate UI managed storage.');
    }
    const hooksDirectory = await fs.mkdtemp(path.join(tmpdir(), 'fate-ui-git-hooks-'));
    const cleanupConfig = [
      '-c', `core.hooksPath=${hooksDirectory}`,
      '-c', 'protocol.allow=never',
      '-c', 'protocol.file.allow=never',
      '-c', 'protocol.ext.allow=never',
    ];
    try {
      await execute(root, ['worktree', 'remove', '--force', canonical], MAX_GIT_OUTPUT, cleanupConfig);
      if (worktree.branch) await execute(root, ['branch', '-D', '--', worktree.branch], 64_000, cleanupConfig);
      this.statusRequest = null;
      this.lastStatus = null;
      this.historyRequest = null;
    } finally {
      await fs.rm(hooksDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  history(): Promise<GitHistory> {
    const root = this.files.getRoot();
    if (this.historyRequest?.root === root) return this.historyRequest.promise;
    const promise = Promise.all([
      execute(root, ['log', '-z', '--all', '--topo-order', '--date-order', `-${MAX_HISTORY_COMMITS + 1}`, '--decorate=full', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%D'], MAX_GIT_OUTPUT),
      execute(root, ['rev-parse', '--verify', 'HEAD'], 16_384).catch(() => Buffer.alloc(0)),
    ]).then(([log, headOutput]) => {
      const parsed = parseGitHistory(log.toString('utf8'), MAX_HISTORY_COMMITS + 1);
      const head = headOutput.toString('utf8').trim();
      return {
        head: /^[0-9a-f]{40,64}$/u.test(head) ? head : parsed.head,
        commits: parsed.commits.slice(0, MAX_HISTORY_COMMITS),
        truncated: parsed.commits.length > MAX_HISTORY_COMMITS,
      };
    }).catch((error: unknown) => {
      const code = (error as ExecFailure).code;
      if (typeof code === 'number' && code !== 0) return { head: null, commits: [], truncated: false };
      throw error;
    }).finally(() => {
      if (this.historyRequest?.promise === promise) this.historyRequest = null;
    });
    this.historyRequest = { root, promise };
    return promise;
  }

  async commitDetails(hash: string): Promise<GitCommitDetails> {
    if (!/^[0-9a-f]{40,64}$/u.test(hash)) throw new Error('The commit hash is invalid.');
    const root = this.files.getRoot();
    const key = `${root}\0${hash}`;
    const cached = this.commitDetailsCache.get(key);
    if (cached) return cached;
    const [summaryOutput, numstatOutput, nameStatusOutput, remoteOutput] = await Promise.all([
      execute(root, ['show', '-s', '-z', '--decorate=full', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%D', hash], 256_000),
      execute(root, ['show', '--format=', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '-M', hash, '--'], MAX_GIT_OUTPUT),
      execute(root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '-M', hash, '--'], MAX_GIT_OUTPUT),
      execute(root, ['remote', 'get-url', 'origin'], 16_384).catch(() => Buffer.alloc(0)),
    ]);
    const summary = parseGitHistory(summaryOutput.toString('utf8'), 1).commits[0];
    if (!summary || summary.hash !== hash) throw new Error('The selected commit no longer exists.');
    const stats = parseNumstat(numstatOutput.toString('utf8'));
    const projected = parseCommitFiles(nameStatusOutput.toString('utf8'), stats);
    const repositoryUrl = githubRepositoryUrl(remoteOutput.toString('utf8'));
    const details: GitCommitDetails = {
      ...summary,
      filesChanged: projected.total,
      additions: [...stats.values()].reduce((total, stat) => total + (stat.additions ?? 0), 0),
      deletions: [...stats.values()].reduce((total, stat) => total + (stat.deletions ?? 0), 0),
      files: projected.files,
      filesTruncated: projected.truncated,
      githubUrl: repositoryUrl ? `${repositoryUrl}/commit/${hash}` : null,
    };
    this.commitDetailsCache.set(key, details);
    while (this.commitDetailsCache.size > 64) this.commitDetailsCache.delete(this.commitDetailsCache.keys().next().value!);
    return details;
  }

  async combinedDiff(): Promise<GitCombinedDiff> {
    const root = this.files.getRoot();
    const status = await this.readStatus(root);
    if (!status.repository) return { patch: '', truncated: false };
    const filterConfig = await safeFilterConfig(root);
    let tracked = '';
    let trackedOverflow = false;
    try {
      tracked = (await execute(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', 'HEAD', '--'], MAX_GIT_OUTPUT, filterConfig)).toString('utf8');
    } catch (error) {
      const code = (error as ExecFailure).code;
      trackedOverflow = outputTooLarge(error);
      if (!trackedOverflow && !(typeof code === 'number' && code !== 0)) throw error;
    }
    const boundedTracked = utf8Prefix(tracked, MAX_COMBINED_DIFF_BYTES);
    let patch = boundedTracked.value;
    let incomplete = status.truncated || trackedOverflow || boundedTracked.truncated;
    let capacityReached = boundedTracked.truncated;
    let patchBytes = Buffer.byteLength(patch, 'utf8');
    const append = (value: string) => {
      if (capacityReached || !value) return;
      const bounded = utf8Prefix(value, MAX_COMBINED_DIFF_BYTES - patchBytes);
      patch += bounded.value;
      patchBytes += Buffer.byteLength(bounded.value, 'utf8');
      if (bounded.truncated) {
        incomplete = true;
        capacityReached = true;
      }
    };
    for (const change of status.changes) {
      if (change.indexStatus !== '?' || change.workTreeStatus !== '?' || capacityReached) continue;
      const safePath = change.path.replace(/[\u0000-\u001f\u007f]/gu, '�');
      try {
        const preview = await this.readRootScopedPreview(root, change.path);
        if (preview.state === 'text') {
          const content = preview.content ?? '';
          const lines = content.split('\n');
          const body = lines.map((line, index) => index === lines.length - 1 && line === '' ? '' : `+${line}`).filter((line) => line !== '').join('\n');
          append(`${patch && !patch.endsWith('\n') ? '\n' : ''}diff --git a/${safePath} b/${safePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${safePath}\n@@ -0,0 +1,${Math.max(0, lines.length - (content.endsWith('\n') ? 1 : 0))} @@\n${body}${body ? '\n' : ''}`);
        } else if (preview.state === 'binary' || preview.state === 'image') {
          append(`${patch && !patch.endsWith('\n') ? '\n' : ''}diff --git a/${safePath} b/${safePath}\nnew file mode 100644\nBinary file added\n`);
        } else {
          incomplete = true;
        }
      } catch {
        incomplete = true;
      }
    }
    return { patch, truncated: incomplete };
  }

  async runOperation(operation: GitOperation): Promise<GitOperationResult> {
    const root = this.files.getRoot();
    const initial = await this.readStatus(root);
    if (!initial.repository) throw new Error('Git controls require a repository.');
    const hooksDirectory = await fs.mkdtemp(path.join(tmpdir(), 'fate-ui-git-hooks-'));
    try {
      const credentialConfig = await trustedCredentialConfig(root);
      const ssh = trustedSshExecutable();
      const networkConfig = [
        ...(await safeFilterConfig(root)),
        '-c', `core.hooksPath=${hooksDirectory}`,
        '-c', 'protocol.allow=never',
        '-c', 'protocol.https.allow=always',
        '-c', 'protocol.http.allow=always',
        '-c', 'protocol.ssh.allow=always',
        '-c', 'protocol.git.allow=always',
        '-c', 'protocol.file.allow=never',
        '-c', 'protocol.ext.allow=never',
        '-c', 'credential.helper=',
        ...credentialConfig,
        '-c', `core.sshCommand=${ssh ? `"${ssh.replace(/\\/g, '/')}"` : 'false'}`,
      ];
      let args: string[];
      if (operation === 'fetch') {
        const remotes = (await execute(root, ['remote'], 64_000)).toString('utf8').split(/\r?\n/u).map((remote) => remote.trim()).filter(Boolean);
        if (remotes.length === 0) throw new Error('Cannot fetch because no Git remote is configured. Add a remote, then try again.');
        args = ['fetch', '--all', '--prune', '--no-recurse-submodules'];
      } else {
        const branch = initial.branch;
        if (!branch) throw new Error(`Cannot ${operation} from detached HEAD. Check out a branch first.`);
        const upstream = await currentUpstream(root, branch);
        if (operation === 'pull') {
          if (!upstream) throw new Error('Current branch has no upstream configured. Push the branch first to publish it and set its upstream.');
          args = ['pull', '--ff-only', '--no-rebase', '--no-recurse-submodules', upstream.remote, upstream.branch];
        } else {
          const target = await resolvePushTarget(root, branch, upstream);
          if (!target) throw new Error('Cannot push because no Git remote is configured. Add a remote, then try again.');
          args = ['push', ...(upstream ? [] : ['--set-upstream']), '--recurse-submodules=no', target.remote, `HEAD:refs/heads/${target.branch}`];
        }
      }
      const output = await executeNetwork(root, args, networkConfig);
      if (this.files.getRoot() !== root) throw new Error('The active project changed before the Git operation completed.');
      this.files.invalidate(root);
      this.statusRequest = null;
      this.lastStatus = null;
      this.historyRequest = null;
      const status = await this.status();
      return { operation, message: boundedGitMessage(operation, output.stdout, output.stderr), status };
    } finally {
      await fs.rm(hooksDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async diff(relativePath: string): Promise<GitDiff> {
    await this.files.confinePath(relativePath);
    const root = this.files.getRoot();
    const generation = this.statusGeneration;
    const key = `${root}\0${generation}\0${relativePath}`;
    const cached = this.diffCache.get(key);
    if (cached) return cached;
    const pending = this.diffRequests.get(key);
    if (pending) return pending;
    const request = this.readDiff(relativePath, root).then((value) => {
      if (this.files.getRoot() !== root || this.statusGeneration !== generation) {
        throw new Error('The active project changed before the Git diff completed.');
      }
      this.diffCache.set(key, value);
      while (this.diffCache.size > 32) this.diffCache.delete(this.diffCache.keys().next().value!);
      return value;
    }).finally(() => {
      if (this.diffRequests.get(key) === request) this.diffRequests.delete(key);
    });
    this.diffRequests.set(key, request);
    return request;
  }

  private async readDiff(relativePath: string, root: string): Promise<GitDiff> {
    const language = languageForPath(relativePath);
    const openable = isSafeExternalPath(relativePath);
    let modified: Buffer | null = null;
    try {
      const preview = await this.readRootScopedPreview(root, relativePath);
      if (preview.state === 'unavailable') {
        return preview.unavailableReason === 'symlink'
          ? { path: relativePath, state: 'unavailable', language, openable: false, message: 'Symbolic-link changes are not dereferenced for safety.' }
          : { path: relativePath, state: 'unavailable', language, openable: false, message: 'Submodule and directory changes do not have a text-file preview.' };
      }
      if (preview.state === 'large') {
        return { path: relativePath, state: 'large', language, openable, message: 'The working file is larger than the 1 MiB diff preview limit.' };
      }
      modified = preview.data ?? Buffer.from(preview.content ?? '', 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const normalizedCode = (error as { normalized?: { code?: string; message?: string } }).normalized?.code;
      const normalizedMessage = (error as { normalized?: { message?: string } }).normalized?.message;
      if (code !== 'ENOENT' && !(normalizedCode === 'INVALID_REQUEST' && normalizedMessage?.includes('no longer exists'))) throw error;
    }

    let original: Buffer | null = null;
    let headPath = relativePath;
    try {
      const change = this.lastStatus?.root === root
        ? this.lastStatus.value.changes.find((entry) => entry.path === relativePath)
        : undefined;
      if (change?.oldPath) {
        this.rootScopedCandidate(root, change.oldPath);
        headPath = change.oldPath;
      }
    } catch {
      // Cached status metadata is an enhancement for rename previews.
    }
    try {
      original = await execute(root, ['show', '--no-ext-diff', '--no-textconv', `HEAD:${headPath.split(path.sep).join('/')}`], MAX_FILE_PREVIEW_BYTES + 1);
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
    const imageValue = modifiedValue.length > 0 ? modifiedValue : originalValue;
    const imageMimeType = rasterImageMimeType(imageValue.subarray(0, 8_192));
    if (imageMimeType) {
      return {
        path: relativePath,
        state: 'image',
        imageData: imageValue.toString('base64'),
        mimeType: imageMimeType,
        language,
        openable: false,
        message: modifiedValue.length > 0 ? 'Working-tree image preview' : 'Deleted image from HEAD',
      };
    }
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
