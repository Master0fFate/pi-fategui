# Features

What Fate UI adds beyond the terminal Pi agent: transparent observability, first-class Git and files, a manual terminal and browser, native media, and themeable presentation.

## Flight Deck: see what your agents are doing

The Flight Deck is Fate UI's observability surface. It shows real Pi runtime state, not inferred or mocked activity.

- **Activity Pulse** — the live current-execution summary: runtime status, queue depth, context usage, changed files, and what is running right now (a tool, a writer node, a blocked agent).
- **Activity** — one merged chronology in the Run destination. It joins **live, bounded** session events (root, legacy, and Agent Team activity; 256-row window, **not durable**) with the current project's **direct-write ledger** rows. When a ledger record matches a retained `write`/`edit` tool row (same actor, path, operation, and a bounded time window), the two render as one row tagged `ledger`; ledger rows with no retained tool row still appear after a restart. A single row of toggles narrows the list — **Writes** (write/edit rows only) plus one of **Root / Legacy / Team** — and no toggle selected shows everything.
- **Review Runway** — pairs working-tree diffs with review status (reviewed/unreviewed, navigate, mark, explain, test, revise).

### Honest about file attribution

When a diff shows a link to agent activity, that link is **related direct-file activity (path correlation)**, not causal provenance. It records the tool that *declared* an affected path. Keep these limits in mind:

- A failed `edit` can still be listed as related activity.
- A later manual edit to the same path can be attributed to an earlier tool.
- Two agents touching the same path are ambiguous.
- Shell commands, formatters, scripts, external editors, and manual terminal mutations are generally invisible.
- Commit history has no automatic causal link to recorded tool events.

So read these links as "related activity to investigate," never as proof of who caused the current file state.

### Direct-write ledger rows (limited)

Activity's ledger rows list only successful direct `write`/`edit` tool calls for the current project: each row records the project-relative path, the actor (main agent, legacy subagent, or team node), the permission level at write time, and a prior→post SHA-256 transition (or `new file` / `oversize prior` when no prior hash was captured). The list is virtualized and bounded to the most recent 1,000 rows shown.

It is deliberately narrow. It does **not** cover shell commands, formatters, scripts, external editor edits, manual terminal mutations, the current working-tree diff, or commit history. It records that a controlled write completed and produced the recorded written-content hash — not authorship, not causality, and not a durable audit log.

The SHA-256 values fingerprint the file content Fate supplied to the tool; they are **not** a signature, and the local JSONL ledger is **not tamper-evident** — a stored row can be edited or removed on disk without detection. Retention is bounded to 4,096 records, 16 MiB, and 90 days per project, and rows are local to the current process/profile slot: each `--new-instance` process keeps its own ledger and rows are not merged across processes.

## First-class Git and files

Status, history, commits, Monaco diffs, and project-confined file browsing without leaving the app. Worktrees are switchable; the working-tree diff and branch history are both reachable.

## Manual terminal and embedded browser

A manual terminal and an embedded browser sit alongside agent activity. The manual terminal is labeled and kept visibly **separate from Pi-generated tool activity**.

## Session references and direct session messages

Attach saved sessions as read-only context, or message a saved session without switching away from your current one. See [Sessions and processes](sessions-and-processes.md).

## Native media (optional)

- **Voice transcription** — local, settings-controlled models with bounded and verified downloads.
- **Ambient audio** — disabled by default; resolved through a bundled, pinned `yt-dlp` runtime and streamed without saving media into the project.
- **Generated images** — select an image model independently of the active chat model. Fate UI supports authenticated OpenAI, Google, OpenRouter, and ChatGPT OAuth routes, plus compatible custom Pi providers. Custom endpoints require HTTPS except on loopback addresses. Generated raster output is validated, rendered inline, and stored under `~/.pi/agent/generated-images/<session-id>/`.

See [FONT_LICENSES.md](../FONT_LICENSES.md) for bundled font redistribution notices.
