export const WORKTREE_BRANCH_PREFIX = 'fate';
const MAX_BRANCH_FRAGMENT_LENGTH = 64;

export function sanitizeWorktreeBranchFragment(raw: string): string {
  const normalized = raw
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//u, '')
    .replace(/['"`]/gu, '')
    .replace(/[^a-z0-9/_-]+/gu, '-')
    .replace(/\/+|-+/gu, (separator) => separator[0]!)
    .replace(/-*\/-*/gu, '/')
    .replace(/^[./_-]+|[./_-]+$/gu, '')
    .slice(0, MAX_BRANCH_FRAGMENT_LENGTH)
    .replace(/[./_-]+$/gu, '');
  return normalized || 'update';
}

export function worktreeBranchName(seed: string): string {
  return `${WORKTREE_BRANCH_PREFIX}/${sanitizeWorktreeBranchFragment(seed)}`;
}

