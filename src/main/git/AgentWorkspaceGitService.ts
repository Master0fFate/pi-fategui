import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { executeGitInWorktree, inheritedLineEndingConfig, parseGitWorktrees, safeFilterConfig, validateSelectedRoot } from './GitService';

const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_DIFF_BYTES = 1_000_000;
const MAX_OUTPUT = 8 * 1024 * 1024;

export interface WorkspaceStatus {
  head: string;
  dirty: boolean;
  branch: string | null;
}

export interface WorkspaceReview {
  sourceHead: string;
  targetHead: string;
  targetBranch: string | null;
  dirty: boolean;
  targetDirty: boolean;
  commits: Array<{ hash: string; subject: string }>;
  diff: string;
  truncated: boolean;
}

export interface CreatedWorkspace {
  path: string;
  branch: string;
  baseCommit: string;
  commonDirectory: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function tooLarge(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

function ownerPrefix(owner: string): string {
  return `agent-${createHash('sha256').update(owner).digest('hex').slice(0, 24)}-`;
}

function bounded(value: string): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= MAX_DIFF_BYTES) return { value, truncated: false };
  let end = MAX_DIFF_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { value: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

export class AgentWorkspaceGitService {
  constructor(private readonly managedRoot = path.join(homedir(), '.pi', 'fateGUI', 'agent-team-worktrees')) {}

  private async withConfig<T>(root: string, work: (config: string[]) => Promise<T>): Promise<T> {
    const hooks = await fs.mkdtemp(path.join(tmpdir(), 'fate-ui-agent-hooks-'));
    try {
      const names = await this.run(root, ['config', '--includes', '--null', '--name-only', '--list'], [], 256_000);
      const mergeConfig: string[] = [];
      for (const name of names.split('\0')) {
        if (!/^merge\..+\.driver$/iu.test(name)) continue;
        if (/[\u0000-\u001f\u007f=]/u.test(name) || name.length > 256) throw new Error('Unsupported custom Git merge driver.');
        mergeConfig.push('-c', `${name}=false`);
      }
      return await work([
        ...await inheritedLineEndingConfig(root),
        ...await safeFilterConfig(root),
        '-c', `core.hooksPath=${hooks}`,
        '-c', 'protocol.allow=never',
        '-c', 'protocol.file.allow=never',
        '-c', 'protocol.ext.allow=never',
        '-c', 'commit.gpgSign=false',
        '-c', 'tag.gpgSign=false',
        '-c', 'merge.verifySignatures=false',
        '-c', 'merge.default=text',
        '-c', 'core.editor=false',
        '-c', 'sequence.editor=false',
        '-c', 'maintenance.auto=false',
        '-c', 'gc.auto=0',
        ...mergeConfig,
      ]);
    } finally {
      await fs.rm(hooks, { recursive: true, force: true });
    }
  }

  private async run(root: string, args: string[], config: readonly string[] = [], maxBuffer = MAX_OUTPUT): Promise<string> {
    return (await executeGitInWorktree(root, args, maxBuffer, config)).toString('utf8');
  }

  private async canonicalRoot(root: string): Promise<string> {
    const canonical = path.normalize(await fs.realpath(root));
    await validateSelectedRoot(canonical);
    return canonical;
  }

  private async commonDirectory(root: string): Promise<string> {
    const value = (await this.run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    return path.normalize(await fs.realpath(value));
  }

  private async assertSameRepository(source: string, target: string): Promise<string> {
    const [sourceDirectory, targetDirectory] = await Promise.all([this.commonDirectory(source), this.commonDirectory(target)]);
    if (sourceDirectory !== targetDirectory) throw new Error('Agent workspace and parent belong to different Git repositories.');
    return sourceDirectory;
  }

  private async assertNoOperation(root: string, config: readonly string[]): Promise<void> {
    const gitDirectory = (await this.run(root, ['rev-parse', '--path-format=absolute', '--git-dir'], config)).trim();
    await Promise.all(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock'].map(async (marker) => {
      try { await fs.lstat(path.join(gitDirectory, marker)); }
      catch (error) { if (isMissing(error)) return; throw error; }
      throw new Error(`Finish the existing Git operation (${marker}) before changing this workspace.`);
    }));
  }

  async status(root: string): Promise<WorkspaceStatus> {
    root = await this.canonicalRoot(root);
    return this.withConfig(root, async (config) => {
      await this.assertNoOperation(root, config);
      const [head, status, branch] = await Promise.all([
        this.run(root, ['rev-parse', '--verify', 'HEAD'], config).then((value) => value.trim()),
        this.run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], config),
        this.run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], config).then((value) => value.trim()).catch((error: unknown) => {
          if ((error as { code?: unknown }).code === 1) return '';
          throw error;
        }),
      ]);
      if (!HASH.test(head)) throw new Error('The workspace has no committed HEAD.');
      return { head, dirty: status.length > 0, branch: branch || null };
    });
  }

  async assertManagedWorkspace(workspace: string): Promise<string> {
    const [rootStat, workspaceStat] = await Promise.all([fs.lstat(this.managedRoot), fs.lstat(workspace)]);
    if (rootStat.isSymbolicLink() || workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) throw new Error('Linked agent workspace directories are not supported.');
    const managed = path.normalize(await fs.realpath(this.managedRoot));
    const canonical = path.normalize(await fs.realpath(workspace));
    if (canonical !== path.resolve(workspace) || path.dirname(canonical) !== managed) throw new Error('Workspace is not inside Fate UI managed storage.');
    await validateSelectedRoot(canonical);
    return canonical;
  }

  async validate(workspace: string, parentRoot: string, branch?: string, baseCommit?: string, commonDirectory?: string, owner?: string): Promise<string> {
    const source = await this.assertManagedWorkspace(workspace);
    if (owner && !path.basename(source).startsWith(ownerPrefix(owner))) throw new Error('Workspace belongs to a different agent owner.');
    const parent = await this.canonicalRoot(parentRoot);
    const common = await this.assertSameRepository(source, parent);
    if (commonDirectory && common !== path.normalize(commonDirectory)) throw new Error('Workspace Git repository identity changed.');
    const registered = parseGitWorktrees(await this.run(parent, ['worktree', 'list', '--porcelain', '-z']), parent)
      .find((item) => path.normalize(item.path) === source && !item.bare);
    if (!registered || !branch || registered.branch !== branch) throw new Error('Workspace registration or branch no longer matches its retained identity.');
    const actualBranch = (await this.run(source, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    if (actualBranch !== branch || !baseCommit || !HASH.test(baseCommit)) throw new Error('Workspace branch or base identity is invalid.');
    await this.run(source, ['merge-base', '--is-ancestor', baseCommit, 'HEAD']).catch(() => { throw new Error('Workspace history no longer contains its original base commit.'); });
    return source;
  }

  async create(parentRoot: string, branch: string, baseRef?: string, owner?: string): Promise<CreatedWorkspace> {
    if (!branch || branch.startsWith('-') || branch.startsWith('@') || /[\u0000-\u0020\u007f]/u.test(branch) || branch.length > 240) throw new Error('Workspace branch is invalid.');
    parentRoot = await this.canonicalRoot(parentRoot);
    const commonDirectory = await this.commonDirectory(parentRoot);
    return this.withConfig(parentRoot, async (config) => {
      const base = baseRef?.trim() || 'HEAD';
      if (base.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(base) || base.length > 500) throw new Error('Workspace base ref is invalid.');
      const baseCommit = (await this.run(parentRoot, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], config)).trim();
      if (!HASH.test(baseCommit)) throw new Error('Workspace base ref does not resolve to a commit.');
      await this.run(parentRoot, ['check-ref-format', '--branch', branch], config);
      await fs.mkdir(this.managedRoot, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(this.managedRoot)).isSymbolicLink()) throw new Error('Linked managed workspace storage is not supported.');
      const managed = path.normalize(await fs.realpath(this.managedRoot));
      const destination = path.normalize(await fs.mkdtemp(path.join(managed, owner ? ownerPrefix(owner) : 'agent-')));
      let branchCreated = false;
      let checkoutCreated = false;
      try {
        // Reserve the ref atomically before assuming ownership during rollback.
        await this.run(parentRoot, ['branch', '--no-track', '--', branch, baseCommit], config);
        branchCreated = true;
        await this.run(parentRoot, ['worktree', 'add', '--', destination, branch], config);
        checkoutCreated = true;
        await this.validate(destination, parentRoot, branch, baseCommit, commonDirectory, owner);
        return { path: destination, branch, baseCommit, commonDirectory };
      } catch (error) {
        const failures: unknown[] = [];
        if (checkoutCreated) {
          try { await this.run(parentRoot, ['worktree', 'remove', '--', destination], config); }
          catch (cleanupError) { failures.push(cleanupError); }
        } else {
          // Failed checkouts may be registered. Never recursively erase an unknown or dirty tree.
          const registered = parseGitWorktrees(await this.run(parentRoot, ['worktree', 'list', '--porcelain', '-z'], config), parentRoot).some((item) => path.normalize(item.path) === destination);
          if (registered) {
            try { await this.run(parentRoot, ['worktree', 'remove', '--', destination], config); }
            catch (cleanupError) { failures.push(cleanupError); }
          } else {
            try { await fs.rmdir(destination); }
            catch (cleanupError) { if (!isMissing(cleanupError)) failures.push(cleanupError); }
          }
        }
        if (branchCreated && failures.length === 0) {
          try { await this.run(parentRoot, ['update-ref', '-d', `refs/heads/${branch}`, baseCommit], config); }
          catch (cleanupError) { failures.push(cleanupError); }
        }
        if (failures.length) throw new AggregateError([error, ...failures], `Workspace creation failed; retained artifacts need manual review at ${destination} on ${branch}.`);
        throw error;
      }
    });
  }

  private async baseFor(source: string, targetHead: string, sourceHead: string, baseCommit?: string): Promise<string> {
    const base = baseCommit ?? (await this.run(source, ['merge-base', targetHead, sourceHead])).trim();
    if (!HASH.test(base)) throw new Error('Workspace review requires a common committed base.');
    await this.run(source, ['merge-base', '--is-ancestor', base, sourceHead]);
    return base;
  }

  async review(source: string, target: string, baseCommit?: string): Promise<WorkspaceReview> {
    await this.assertSameRepository(source, target);
    const [sourceStatus, targetStatus] = await Promise.all([this.status(source), this.status(target)]);
    const base = await this.baseFor(source, targetStatus.head, sourceStatus.head, baseCommit);
    return this.withConfig(source, async (config) => {
      const log = await this.run(source, ['log', '--reverse', '--topo-order', '--format=%H%x00%s', '-z', '--max-count=129', `${base}..${sourceStatus.head}`, '--not', targetStatus.head, '--'], config);
      const fields = log.split('\0');
      const commits: WorkspaceReview['commits'] = [];
      for (let index = 0; index + 1 < fields.length && commits.length < 128; index += 2) {
        if (!HASH.test(fields[index]!)) throw new Error('Git returned an invalid workspace commit.');
        commits.push({ hash: fields[index]!, subject: fields[index + 1]!.slice(0, 2_000) });
      }
      let truncated = fields.length > 257;
      const diff = async (args: string[]) => {
        try { return await this.run(source, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', ...args, '--'], config, MAX_DIFF_BYTES); }
        catch (error) {
          if (!tooLarge(error)) throw error;
          truncated = true;
          return '[Diff exceeds the review limit. Inspect it in the local checkout.]\n';
        }
      };
      const parts = [await diff([base, sourceStatus.head])];
      if (sourceStatus.dirty) {
        parts.push(await diff(['HEAD']));
        const untracked = await this.run(source, ['ls-files', '--others', '--exclude-standard', '-z'], config);
        if (untracked) {
          truncated = true;
          parts.push(`Untracked files (contents not shown; checkpoint then refresh review):\n${untracked.split('\0').filter(Boolean).map((file) => JSON.stringify(file)).join('\n')}\n`);
        }
      }
      const result = bounded(parts.filter(Boolean).join('\n'));
      const [latestSource, latestTarget] = await Promise.all([this.status(source), this.status(target)]);
      if (latestSource.head !== sourceStatus.head || latestTarget.head !== targetStatus.head) throw new Error('Workspace changed during review. Refresh the review.');
      return { sourceHead: sourceStatus.head, targetHead: targetStatus.head, targetBranch: targetStatus.branch, dirty: latestSource.dirty, targetDirty: latestTarget.dirty, commits, diff: result.value, truncated: truncated || result.truncated, };
    });
  }

  async checkpoint(root: string, message: string): Promise<string> {
    if (!message.trim() || message.length > 2_000 || message.includes('\0')) throw new Error('Checkpoint message is invalid.');
    const initial = await this.status(root);
    if (!initial.branch) throw new Error('Checkpoint requires a checked-out branch.');
    if (!initial.dirty) throw new Error('Workspace has no changes to checkpoint.');
    return this.withConfig(root, async (config) => {
      await this.run(root, ['add', '-A', '--'], config);
      await this.run(root, ['commit', '--no-verify', '--no-gpg-sign', '-m', message.trim()], config);
      return (await this.status(root)).head;
    });
  }

  async integrate(source: string, target: string, expectedSourceHead: string, expectedTargetHead: string, strategy: 'ff-only' | 'cherry-pick', commits?: string[], baseCommit?: string): Promise<string> {
    if (!HASH.test(expectedSourceHead) || !HASH.test(expectedTargetHead)) throw new Error('Integration requires full reviewed source and target heads.');
    await this.assertSameRepository(source, target);
    const [sourceStatus, targetStatus] = await Promise.all([this.status(source), this.status(target)]);
    if (!sourceStatus.branch || !targetStatus.branch) throw new Error('Integration requires checked-out source and target branches.');
    if (sourceStatus.dirty || targetStatus.dirty) throw new Error('Integration requires clean source and target worktrees.');
    if (sourceStatus.head !== expectedSourceHead || targetStatus.head !== expectedTargetHead) throw new Error('Workspace heads changed since review; review again before integrating.');
    return this.withConfig(target, async (config) => {
      if (strategy === 'ff-only') {
        await this.run(target, ['merge', '--ff-only', '--no-verify', '--no-gpg-sign', sourceStatus.head], config);
      } else if (strategy === 'cherry-pick') {
        if (!commits?.length || commits.length > 128 || commits.some((hash) => !HASH.test(hash)) || new Set(commits).size !== commits.length) throw new Error('Cherry-pick requires unique selected full commit hashes.');
        const base = await this.baseFor(source, targetStatus.head, sourceStatus.head, baseCommit);
        const ordered = (await this.run(source, ['rev-list', '--reverse', '--topo-order', `${base}..${sourceStatus.head}`, '--not', targetStatus.head, '--'], config)).trim().split(/\r?\n/u).filter(Boolean);
        const selected = new Set(commits);
        if (commits.some((hash) => !ordered.includes(hash))) throw new Error('Selected commits must belong to the reviewed child branch.');
        try {
          await this.run(target, ['cherry-pick', '--no-gpg-sign', ...ordered.filter((hash) => selected.has(hash))], config);
        } catch (error) {
          try {
            await this.run(target, ['cherry-pick', '--abort'], config);
          } catch (abortError) {
            const current = await this.status(target).catch(() => null);
            if (!current || current.head !== expectedTargetHead || current.dirty) throw new AggregateError([error, abortError], 'Cherry-pick failed and could not be aborted. Inspect the parent checkout before continuing.');
          }
          throw new Error('Cherry-pick failed; the sequence was aborted and the parent checkout was preserved.', { cause: error });
        }
      } else throw new Error('Unknown workspace integration strategy.');
      return (await this.status(target)).head;
    });
  }

  async discardCreated(parentRoot: string, workspace: CreatedWorkspace, owner: string): Promise<void> {
    await this.validate(workspace.path, parentRoot, workspace.branch, workspace.baseCommit, workspace.commonDirectory, owner);
    const status = await this.status(workspace.path);
    if (status.head !== workspace.baseCommit || status.dirty) throw new Error('Failed-spawn workspace contains changes; retained for review.');
    await this.cleanup(parentRoot, workspace.path);
    await this.withConfig(parentRoot, (config) => this.run(parentRoot, ['update-ref', '-d', `refs/heads/${workspace.branch}`, workspace.baseCommit], config).then(() => undefined));
  }

  async cleanup(parentRoot: string, workspace: string): Promise<void> {
    const canonical = await this.assertManagedWorkspace(workspace);
    parentRoot = await this.canonicalRoot(parentRoot);
    await this.assertSameRepository(canonical, parentRoot);
    const registered = parseGitWorktrees(await this.run(parentRoot, ['worktree', 'list', '--porcelain', '-z']), parentRoot);
    if (!registered.some((item) => path.normalize(item.path) === canonical && !item.bare)) throw new Error('Workspace is not registered with its parent repository.');
    const current = await this.status(canonical);
    if (current.dirty) throw new Error('Workspace cleanup requires a clean worktree.');
    await this.withConfig(canonical, async (config) => {
      const ignored = await this.run(canonical, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], config);
      if (ignored) throw new Error('Workspace contains ignored files. Remove or preserve them explicitly before cleanup.');
      await this.run(parentRoot, ['worktree', 'remove', '--', canonical], config);
    });
  }
}
