# Sessions and processes

Fate UI distinguishes **one runtime seen through multiple windows** from the intended **separate-process runtime** mode. The current V2 candidate has an unresolved shared-data ownership limit for the latter; knowing the difference avoids accidental double work.

## Open a project from the terminal

With the Windows PATH option, a macOS PKG, or a Linux DEB installed:

```bash
cd /path/to/project
fate
```

You can also provide a directory explicitly:

```bash
fate /path/to/project
```

Fate UI opens the canonical directory and displays its normal trust prompt. Fate UI is **single-instance by default**: the first launch holds the primary lock and runs the app. A later `fate` (or `fate /path/to/project`) launch fails that lock, hands its folder to the already-running app, and exits — so it opens or focuses that folder inside the live app instead of spawning a second window or process.

`--new-instance` or `FATE_NEW_INSTANCE=1` selects a separate process with its own persistent Chromium profile slot. **In the current V2 candidate, this does not guarantee successful startup alongside an existing owner.** Both resolve to the same canonical Fate data root, normally `~/.pi/fateGUI/`, and the core refuses competing ownership. Pi session paths remain shared. The Chromium slot does not isolate the core's data or satisfy the intended independent-runtime/shared-session contract. See [V2 candidate status](v2/current-status.md).

## Multiple windows vs. multiple processes

- **Multiple windows on one session** — use **File → New Window** (`Ctrl/Cmd+Shift+N`). Windows share one live Pi runtime and stay in sync: no second process, no stale chat. This is the right choice when you want two views of the same conversation. Because the runtime is shared, this is **not** the way to run two separate sessions at once.
- **Forwarding a folder to the running app** — a later `fate /path/to/project` (the default single-instance behavior) opens or focuses that folder in the already-running app and exits. Use this to switch the live app to another project from the terminal.
- **Separate `fate` processes** — requested with `--new-instance` or `FATE_NEW_INSTANCE=1`, but blocked when another core holds the same data-root owner. A compatible shared-data ownership implementation and installed-product verification are still required. Do not delete locks or silently change to an empty data profile to bypass this limit.

## Session references and direct session messages

- **Session references** attach a saved session as read-only context inside your current conversation, so the agent can read prior work without you switching projects.
- **Direct session messages** let you message a saved session without leaving your current one.

Both keep your active session focused while still reaching history you have already saved.
