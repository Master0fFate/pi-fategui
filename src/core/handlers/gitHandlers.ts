import type { GitService } from '../../main/git/GitService';
import {
  emptyInputSchema, filePathInputSchema, gitCombinedDiffSchema, gitCommitDetailsSchema,
  gitCommitInputSchema, gitDiffSchema, gitHistorySchema, gitOperationInputSchema,
  gitOperationResultSchema, gitRevertPathInputSchema, gitRevertPathResultSchema, gitStatusSchema,
  gitWorktreeListSchema,
} from '../../shared/contracts/ipc';
import { assertScopedRead } from './agentHandlers';
import type { AdmissionAuthority } from '../workspaces/WorkspaceAdmissionQueue';
import type { WorkspaceHandle } from '../workspaces/WorkspaceHandle';

/** Fixed existing Git operations only. No arguments array, shell, commit or worktree cleanup API. */
export function createGitHandlers(git: GitService) {
  return {
    async status(input: unknown) { emptyInputSchema.parse(input); return gitStatusSchema.parse(await git.status()); },
    async diff(input: unknown) { return gitDiffSchema.parse(await git.diff(filePathInputSchema.parse(input).path)); },
    async combinedDiff(input: unknown) { emptyInputSchema.parse(input); return gitCombinedDiffSchema.parse(await git.combinedDiff()); },
    async history(input: unknown) { emptyInputSchema.parse(input); return gitHistorySchema.parse(await git.history()); },
    async commitDetails(input: unknown) { return gitCommitDetailsSchema.parse(await git.commitDetails(gitCommitInputSchema.parse(input).hash)); },
    async worktrees(input: unknown) { emptyInputSchema.parse(input); return gitWorktreeListSchema.parse(await git.worktrees()); },
    async runOperation(input: unknown) { return gitOperationResultSchema.parse(await git.runOperation(gitOperationInputSchema.parse(input).operation)); },
    async revertPath(input: unknown) {
      const { path } = gitRevertPathInputSchema.parse(input);
      return gitRevertPathResultSchema.parse({ path, status: await git.revertPath(path) });
    },
  };
}

/** Network callers receive an authenticated handle, not a root path. Mutations enter the accepted admission lane. */
export function createScopedGitHandlers(handle: WorkspaceHandle, authorize: () => AdmissionAuthority) {
  const desktop = createGitHandlers(handle.git);
  const check = async () => {
    assertScopedRead(handle, authorize);
    if (handle.files.getRoot() !== handle.root) throw new Error('Git workspace root changed.');
    await handle.files.assertBoundRootIdentity();
    assertScopedRead(handle, authorize);
  };
  const read = async <T>(work: () => Promise<T>): Promise<T> => {
    await check(); const result = await work(); await check(); return result;
  };
  return {
    status: (input: unknown) => read(() => desktop.status(input)),
    diff: (input: unknown) => read(() => desktop.diff(input)),
    history: (input: unknown) => read(() => desktop.history(input)),
    commitDetails: (input: unknown) => read(() => desktop.commitDetails(input)),
    /** Existing native IPC only. These operations are absent from the portable wire catalog. */
    desktopCombinedDiff: (input: unknown) => read(() => desktop.combinedDiff(input)),
    desktopWorktrees: (input: unknown) => read(() => desktop.worktrees(input)),
    // No mutations. Legacy desktop revert/remote operations remain named local IPC only.
    // Future Git writes require expected-HEAD/review and safe filter/hook/path policy.
  };
}
