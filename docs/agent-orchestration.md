# Agent orchestration

Fate UI exposes one canonical agent lifecycle; there is no selectable Legacy/Agent Teams protocol mode. A root can create children, and children can create grandchildren within the same provider-neutral Team executor. The **Agents** inspector shows the tree, task state, profile/model, usage, messages, and writer ownership. It also lets you message, follow up with, interrupt, or close agents. Conversations and events persist under `~/.pi/fateGUI/agent-teams/`; after restart, in-flight work is marked interrupted and remains visible through the same lifecycle.

`agent_workflow` schedules dependency graphs through that same Team executor rather than a separate child-session engine. A paused saved workflow never resumes implicitly: explicitly resume it to admit its remaining work through the current executor. Saved standalone records from the former engine remain historical and read-only, except that their display names can still be renamed. Their persisted source identities and archive data are preserved.

A small dependency workflow looks like this:

```json
{
  "action": "start",
  "maxConcurrency": 2,
  "nodes": [
    {
      "id": "inspect",
      "task": "Inspect the affected code and return file and symbol references.",
      "permission": "read-only",
      "timeoutSeconds": 120
    },
    {
      "id": "implement",
      "task": "Implement and test the scoped change.",
      "dependsOn": ["inspect"],
      "includeDependencyResults": true,
      "permission": "edit",
      "mailboxTtlSeconds": 300
    }
  ]
}
```

`includeDependencyResults` transfers bounded result **text** as untrusted evidence; it does not copy files or integrate an isolated worktree. Files written in a shared checkout are already shared, while worktree changes require explicit review and integration as described below. Positive runtime and idle thresholds are advisory inspector checkpoints, not termination clocks. A positive workflow mailbox TTL keeps a successfully settled Team node available for `followup_task`; Team owns expiry and resets the idle deadline after an accepted follow-up. Zero disables retention and releases capacity after safe settlement.

Teams limit depth to 2, concurrent non-root turns to 3, and **live, unreleased** non-root nodes to 16 per team. The 16-node limit is live Team capacity, not a limit of 16 logical DAG steps; settled nodes can be released before later workflow steps are admitted. Writer leases are **per checkout**: shared-checkout writers serialize, while agents in separate worktrees can write concurrently. Descendant permissions and ordinary tools can only narrow the direct caller's authority.

### Global workspace preference

Set the workspace policy once in **Settings → Agent → Agents**. It applies across projects and newly created agents; there is no manual team setup in **Run → Agents**.

- **Prefer isolated worktrees** starts on. New agents use separate Git checkouts by default. Turn it off to prefer sharing the direct parent's checkout.
- **Strict mode** starts off. With it off, the parent can explicitly choose the other mode for a particular task. With it on, Fate refuses incompatible launches and resumed turns in the backend; an agent cannot change this policy through a team tool.

Saving applies the policy immediately to future admissions, including in existing and background teams. Running turns finish in their current checkout: a settings change never moves files or discards work. A retained agent in the wrong mode cannot start another turn while strict enforcement applies; relax the setting or spawn a compatible replacement. Review, integration, and cleanup of retained workspaces remain available.

Worktrees still require a Git repository with a commit and sufficient parent permissions. An unavailable worktree is an error, not a silent downgrade; with Strict mode off, the agent can retry with an explicit shared checkout. The policy applies to all newly created agents using the canonical executor. Changing workspace policy does not require reopening the project.

Automatic GoalMax verifiers and diagnostic agents explicitly share the current project when the policy is flexible, so they inspect delivered files rather than an older commit. With strict isolation selected, these reviews require a clean, committed project before launching an isolated verifier; they fail clearly instead of silently reviewing stale files.

The parent and children can call `get_agent_workspace_policy` to read the live preference and strict flag. `configure_agent_workspace` is no longer exposed. Older saved team defaults remain readable as historical data but no longer determine new workspace choices.

A parent can specify a workspace for each `spawn_agent` call, subject to that policy:

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

`mode: "shared"` inherits the **direct parent's** checkout, including when that parent is already in a worktree. An omitted workspace uses the current global preference. An explicit mode wins only when Strict mode is off or it matches the required mode. Worktree `baseRef` defaults to `HEAD` and is resolved to a fixed commit; uncommitted parent changes are not copied. Omit `branch` for a unique generated name. Explicit branches must be new, valid Git branch names. No arbitrary output paths are accepted: worktrees live under `~/.pi/fateGUI/agent-team-worktrees/`. Model, thinking, tools, skills, and permissions remain independent controls.

### Review and integrate agent work

Select an agent's **Isolated worktree** row to open the workspace dialog. It shows the checkout, branch, base, parent target, bounded diff, and commit list. The parent model uses the same lifecycle through `agent_workspace`:

1. **Review** with `{ target, operation: "review" }` after the agent settles.
2. If it has uncommitted work, explicitly **checkpoint** with `{ target, operation: "checkpoint", message: "Describe the change" }`, then review again. This commits locally in the child checkout; it does not change the parent. Edit-only children do not need shell access.
3. **Integrate** with `operation: "integrate"`, `strategy: "ff-only"` or `"cherry-pick"`, and the exact `expectedSourceHead` / `expectedTargetHead` from the retained review. Cherry-pick also requires `commits: ["full-commit-hash", ...]`; selected commits apply in source history order. Dirty checkouts, incomplete reviews, changed HEADs or parent branches, and conflicting active agents are refused. A conflicting cherry-pick sequence is aborted; existing Git operations must be resolved separately.
4. **Close or release** the agent to stop future work. Its worktree and branch remain available. Only explicit `operation: "cleanup"` removes a clean, inactive worktree; its branch is retained. Dirty or ignored files and retained descendant worktrees prevent cleanup. Resetting or deleting a team also refuses to orphan retained worktrees.

Mutations are direct-parent-owned and require edit/full-access authority. The UI can review descendants and clean up closed descendants, but checkpointing/integration of a grandchild remains its direct parent's responsibility. UI mutations wait until the root session is idle. Nothing commits, integrates, pushes, or removes a worktree merely because a task finishes.

On resume, Fate validates checkout ownership, canonical parent paths, Git registration, repository identity, branch, and original base. Removed or mismatched worktrees never fall back to the original checkout. Worktree sessions inherit the approved root's settings and skill catalog rather than automatically loading another ref's project context.

**A Git worktree is not a security sandbox.** Project-confined edit tools stay in the assigned checkout; Full access can still reach other host paths, processes, databases, and services. Git object storage is shared. Leases coordinate this Fate UI runtime, not unrelated shells or other application processes.

## Historical standalone records

Saved standalone agent records from earlier versions stay visible as historical direct-root entries. They are read-only except for display-name rename, and they do not become live Team nodes merely by being viewed. Their persisted identifiers and source markers remain unchanged for archive compatibility.

## Reusable agent profiles

Reusable Markdown profiles load from `~/.pi/agent/agents/*.md` and, in trusted projects, `.pi/agents/*.md`. Their frontmatter can define fields such as name, description, role, tools, and model.

## Permissions and authority

What an agent can do is governed by the active [permission level](architecture.md#permission-model): **Read only**, **Edit files** (default, project-confined), or **Full access** (unsandboxed, explicit confirmation). In agent teams, descendant authority can only narrow the caller's — it never exceeds it.
