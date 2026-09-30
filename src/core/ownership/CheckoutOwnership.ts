import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { executeGitInWorktree } from '../../main/git/GitService';
import { OwnerLock, OwnershipConflict } from './OwnerLock';

/** Process-start user namespace, independent of profile lockRoot/custom profileRoot. */
const userCheckoutRoot = path.join(os.homedir(), '.pi', 'fate-v2-checkouts');
export function hostCheckoutLockRoot(): string { return userCheckoutRoot; }
export class CheckoutOwnership {
  constructor(readonly namespace: string) {}

  async checkout(root: string): Promise<OwnerLock> {
    const canonical = path.normalize(await fs.realpath(root));
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('Checkout must be a directory.');
    return OwnerLock.acquire(this.namespace, 'checkout', canonical);
  }

  async commonGitDirectory(root: string): Promise<string> {
    const canonical = path.normalize(await fs.realpath(root));
    const output = (await executeGitInWorktree(canonical, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 16_384)).toString('utf8').trim();
    if (!path.isAbsolute(output)) throw new Error('Git returned a non-absolute common directory.');
    return path.normalize(await fs.realpath(output));
  }

  /** Acquire checkout(s) first, then short common-Git lock. Never wait for checkout while holding this lock. */
  async mutation<T>(root: string, work: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
    const common = await this.commonGitDirectory(root);
    const until = performance.now() + timeoutMs;
    let lock: OwnerLock;
    for (;;) {
      try { lock = await OwnerLock.acquire(this.namespace, 'git', common); break; }
      catch (error) {
        if (!(error instanceof OwnershipConflict) || performance.now() >= until) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
      }
    }
    try { return await work(); }
    finally { await lock.release(); }
  }
}

const sharedHostOwnership = new CheckoutOwnership(userCheckoutRoot);
export function hostCheckoutOwnership(): CheckoutOwnership { return sharedHostOwnership; }
