import { describe, expect, it, vi } from 'vitest';
import { sanitizeWorktreeBranchFragment, worktreeBranchName } from './GitBranchNames';

describe('Git worktree branch names', () => {
  it('creates bounded safe semantic branches from long prompts', () => {
    expect(worktreeBranchName('  Fix push / pull workflow!!!  ')).toBe('fate/fix-push/pull-workflow');
    expect(sanitizeWorktreeBranchFragment('"../../"')).toBe('update');
    expect(sanitizeWorktreeBranchFragment('refs/heads/Feature.Valid_name')).toBe('feature-valid_name');
    expect(sanitizeWorktreeBranchFragment('A'.repeat(100))).toHaveLength(64);
  });

  it('does not consult the host locale while normalizing branch names', () => {
    const localized = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(() => { throw new Error('locale-dependent'); });
    expect(worktreeBranchName('REPAIR')).toBe('fate/repair');
    expect(localized).not.toHaveBeenCalled();
    localized.mockRestore();
  });
});
