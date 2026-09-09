# Agent orchestration

Choose one orchestration surface under **Settings → Agent**, then reopen the project. A model sees only the selected surface.

## Agent Teams V2 (beta)

Agent Teams V2 is the recursive, provider-neutral option. A root can create children and children can create grandchildren. The **Agents** inspector shows the tree, task state, profile/model, usage, messages, and writer ownership. It also lets you message, follow up with, interrupt, or close agents. Conversations and events persist under `~/.pi/fateGUI/agent-teams/`; after restart, in-flight work is marked interrupted and retained context can be resumed with a follow-up.

Teams limit depth to 2, non-root nodes to 16, and concurrent non-root turns to 3 per team. Writer leases are **per checkout**: shared-checkout writers serialize, while agents in separate worktrees can write concurrently. Descendant permissions and ordinary tools can only narrow the direct caller's authority.

### Optional local worktrees

Shared checkout remains the default. A parent can override the workspace for each `spawn_agent` call:

```json
{
  "task": "Implement the change and report your test results for review.",
  "name": "implementation",
  "permission": "edit",
  "workspace": {
    "mode": "worktree",
    "baseRef": "HEAD",
    "branch": "agents/implementation"
  }
}
```

`mode: "shared"` inherits the **direct parent's** checkout, including when that parent is already in a worktree. An omitted workspace uses the team's defaults, initially shared. Worktree `baseRef` defaults to `HEAD` and is resolved to a fixed commit; uncommitted parent changes are not copied. Omit `branch` for a unique generated name. Explicit branches must be new, valid Git branch names. No arbitrary output paths are accepted: worktrees live under `~/.pi/fateGUI/agent-team-worktrees/`.

Under **Run → Agents**, expand a team's **Workspace defaults** to choose shared/new worktree, base ref, and branch prefix for future children. The parent can also set these with `configure_agent_workspace({ teamId, workspace: { mode, baseRef?, branchPrefix? } })`. Explicit spawn settings take precedence. Existing agents never move when defaults change; model, thinking, tools, skills, and permission controls remain independent.

Select an agent's **Isolated worktree** row to open the workspace dialog. It shows the checkout, branch, base, parent target, bounded diff, and commit list. The parent model uses the same lifecycle through `agent_workspace`:

1. **Review** with `{ target, operation: "review" }` after the agent settles.
2. If it has uncommitted work, explicitly **checkpoint** with `{ target, operation: "checkpoint", message: "Describe the change" }`, then review again. This commits locally in the child checkout; it does not change the parent. Edit-only children do not need shell access.
3. **Integrate** with `operation: "integrate"`, `strategy: "ff-only"` or `"cherry-pick"`, and the exact `expectedSourceHead` / `expectedTargetHead` from the retained review. Cherry-pick also requires `commits: ["full-commit-hash", ...]`; selected commits apply in source history order. Dirty checkouts, incomplete reviews, changed HEADs or parent branches, and conflicting active agents are refused. A conflicting cherry-pick sequence is aborted; existing Git operations must be resolved separately.
4. **Close or release** the agent to stop future work. Its worktree and branch remain available. Only explicit `operation: "cleanup"` removes a clean, inactive worktree; its branch is retained. Dirty or ignored files and retained descendant worktrees prevent cleanup. Resetting or deleting a team also refuses to orphan retained worktrees.

Mutations are direct-parent-owned and require edit/full-access authority. The UI can review descendants and clean up closed descendants, but checkpointing/integration of a grandchild remains its direct parent's responsibility. UI mutations wait until the root session is idle. Nothing commits, integrates, pushes, or removes a worktree merely because a task finishes.

On resume, Fate validates checkout ownership, canonical parent paths, Git registration, repository identity, branch, and original base. Removed or mismatched worktrees never fall back to the original checkout. Worktree sessions inherit the approved root's settings and skill catalog rather than automatically loading another ref's project context.

**A Git worktree is not a security sandbox.** Project-confined edit tools stay in the assigned checkout; Full access can still reach other host paths, processes, databases, and services. Git object storage is shared. Leases coordinate this Fate UI runtime, not unrelated shells or other application processes.

## Legacy subagents

Legacy mode keeps `subagent`, `subagent_start`, `subagent_manage`, `subagent_workflow`, and `subagent_catalog`. Each child uses an isolated Pi SDK session with its own model, thinking level, profile, permissions, tools, skills, and limits. It cannot launch child agents. Historical snapshots stay readable as direct root children. Per-child Git worktrees are available in Agent Teams V2, not legacy mode.

## Reusable agent profiles

Reusable Markdown profiles load from `~/.pi/agent/agents/*.md` and, in trusted projects, `.pi/agents/*.md`. Their frontmatter can define fields such as name, description, role, tools, and model.

## Permissions and authority

What an agent can do is governed by the active [permission level](architecture.md#permission-model): **Read only**, **Edit files** (default, project-confined), or **Full access** (unsandboxed, explicit confirmation). In Agent Teams, descendant authority can only narrow the caller's — it never exceeds it.
