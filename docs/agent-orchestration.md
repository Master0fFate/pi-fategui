# Agent orchestration

Choose one orchestration surface under **Settings → Agent**, then reopen the project. A model sees only the selected surface.

## Agent Teams V2 (beta)

Agent Teams V2 is the recursive, provider-neutral option. A root can create children and children can create grandchildren. The **Agents** inspector shows the tree, task state, profile/model, usage, messages, and writer ownership. It also lets you message, follow up with, interrupt, or close agents. Conversations and events persist under `~/.pi/fateGUI/agent-teams/`; after restart, in-flight work is marked interrupted and retained context can be resumed with a follow-up.

Teams limit depth to 2, non-root nodes to 16, concurrent non-root turns to 3, and write-capable child turns to 1. All agents share the project working tree, so parallel writers are unavailable. Descendant permissions and ordinary tools can only narrow the direct caller's authority.

## Legacy subagents

Legacy mode keeps `subagent`, `subagent_start`, `subagent_manage`, `subagent_workflow`, and `subagent_catalog`. Each child uses an isolated Pi SDK session with its own model, thinking level, profile, permissions, tools, skills, and limits. It cannot launch child agents. Historical snapshots stay readable as direct root children.

## Reusable agent profiles

Reusable Markdown profiles load from `~/.pi/agent/agents/*.md` and, in trusted projects, `.pi/agents/*.md`. Their frontmatter can define fields such as name, description, role, tools, and model.

## Permissions and authority

What an agent can do is governed by the active [permission level](architecture.md#permission-model): **Read only**, **Edit files** (default, project-confined), or **Full access** (unsandboxed, explicit confirmation). In Agent Teams, descendant authority can only narrow the caller's — it never exceeds it.
