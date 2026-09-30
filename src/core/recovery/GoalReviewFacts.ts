import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { executeGitInWorktree, safeFilterConfig } from '../../main/git/GitService';
export const checkoutFactsSchema = z.object({
  root: z.string().min(1).max(32_768), commonDirectory: z.string().min(1).max(32_768),
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u), branch: z.string().min(1).max(240),
  clean: z.literal(true),
}).strict();
export type CheckoutFacts = z.infer<typeof checkoutFactsSchema>;

/** Operator review identity only, never proof of saved test/provider evidence.
 * No dirty checkout is eligible: porcelain alone cannot identify file contents.
 * Git optional locks, fsmonitor, hooks, protocols and attribute filters are disabled for this read. */
export async function readGoalReviewCheckout(projectPath: string): Promise<CheckoutFacts> {
  const root = path.normalize(await fs.realpath(projectPath));
  if (root !== path.normalize(path.resolve(projectPath))) throw new Error('Checkout root changed.');
  const hooks = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-review-hooks-'));
  try {
    // The shared Git reader finds both indexed and worktree attribute drivers with
    // bounded, fsmonitor-disabled reads before any status may invoke a filter.
    const config = ['-c', `core.hooksPath=${hooks}`, '-c', 'protocol.allow=never',
      '-c', 'core.untrackedCache=false', '-c', 'core.splitIndex=false', ...await safeFilterConfig(root)];
    const run = async (args: string[], maxBuffer = 2 * 1024 * 1024) =>
      (await executeGitInWorktree(root, args, maxBuffer, config)).toString('utf8');
    const identity = async () => {
      const [top, common, head, branch] = await Promise.all([
        run(['rev-parse', '--show-toplevel'], 32_768),
        run(['rev-parse', '--path-format=absolute', '--git-common-dir'], 32_768),
        run(['rev-parse', '--verify', 'HEAD'], 256),
        run(['symbolic-ref', '--quiet', '--short', 'HEAD'], 256),
      ]);
      if (path.normalize(await fs.realpath(top.trim())) !== root) throw new Error('Checkout no longer matches registered root.');
      return { root, commonDirectory: path.normalize(await fs.realpath(common.trim())), head: head.trim(), branch: branch.trim() };
    };
    const before = await identity();
    const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
    if (status !== '') throw new Error('Checkout is dirty; read-only recovery acknowledgement requires a clean checkout.');
    const after = await identity();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Checkout identity changed during review.');
    return checkoutFactsSchema.parse({ ...after, clean: true });
  } finally { await fs.rm(hooks, { recursive: true, force: true }); }
}
