# Build Notes

## Completed phases

- **Phase 1:** strict Electron/Vite/React shell, secure preload, Zod IPC, resizable/collapsible three-pane UI, private GitHub repository.
- **Phase 2:** trusted project selection and real project-bound Pi `AgentSessionRuntime`; authentication/model/thinking state, prompt preflight, streaming, stop, normalized errors.
- **Phase 3:** entity-indexed and virtualized conversation/tool timelines, reasoning, compaction/error notices, bounded output, composer queues, slash templates, file references, and image gates.
- **Phase 4:** persistent session list/search/new/switch/fork/clone/import/compact, branch display, serialized replacement, generation-safe subscription/extension rebinding.
- **Phase 5:** confined file tree/search/read/open, Git status/diff/line counts, lazy Monaco file/diff views, explicit binary/large/submodule/symlink/truncation states, integrated xterm/node-pty terminal.
- **Phase 6:** command palette, native menus, settings, diagnostics/logs, keyboard shortcuts, reduced motion, Vitest/RTL/integration tests, Playwright Electron coverage, and current-OS packaging.
- **Phase 7:** full-height row-action session browser; composer-aware scrollbar endpoint; typed, bounded Git worktree/global-diff/history/details/Fetch/Pull/Push IPC; runtime-safe worktree replacement; list/graph Changes views; and lazy commit detail cards.

## Important architecture decisions

- Main output is ESM for Pi’s ESM-only SDK; sandbox-compatible preload is bundled as CJS.
- Production uses `createAgentSessionRuntime()` with cwd-bound services. The deterministic adapter exists only under `tests/e2e` and is never packaged.
- Runtime replacement synchronously unsubscribes, increments a session generation, clears pending batches, rebinds extensions/listeners, and ignores old-generation events. Replacement operations are serialized and expose failure state.
- Pi credentials remain entirely inside Pi’s `ModelRuntime`. Renderer contracts contain no API-key field.
- Renderer state stores stable message/tool entities separately from order arrays. `react-virtuoso` keeps 5,000-entry timelines bounded.
- Event batches cap at 100 events / 256 KiB; adjacent text deltas cap at 32 KiB and live tool output at 64,000 characters.
- Filesystem and Git services accept project-relative paths only. Reads use one validated open handle for size/sample/content. Git uses `execFile`, NUL-delimited parsing, bounded output, and no destructive commands.
- Manual terminal PTYs are main-owned, renderer-owner scoped, output-batched, trust-gated, and separate from Pi tool events. xterm and Monaco are lazy chunks.
- Settings are atomically persisted under Electron user data. Diagnostics expose versions/status/paths but no credentials; logs redact token-like strings and retain 500 entries in memory.
- Queued messages use Pi 0.81.1's public queue APIs. A bounded main-process mirror adds stable UI IDs and original editable drafts; edit/cancel/behavior changes serialize `clearQueue()` plus public `steer()`/`followUp()` requeue operations and reconcile against authoritative queue counts.
- Git remains main-owned and library-free: trusted absolute Git/SSH executables run through `execFile` with bounded output, repository hooks disabled, project filter drivers neutralized, submodule recursion disabled, and network protocols explicitly allowlisted. A worktree switch reuses the project trust path and recreates the entire project-bound Pi runtime.

## Current limitations

- Extension commands execute when entered, but only SDK-exposed prompt templates can be suggested.
- GUI Git accept/revert is omitted because a safe review/apply transaction was not available in this scope.
- External editor launch cannot be atomic against a malicious concurrent local path swap; only canonical project paths and known text/source extensions are accepted.
- Native installers are unsigned and use Electron’s default icon.
- Live provider responses, image input, and real persisted fork/import/compact depend on the user’s Pi credentials and should be manually exercised with their provider/session data.

## Verification evidence

- Host Node: 22.22.2; Electron 43.2.0 embeds Node 24.18.0, satisfying Pi 0.81.1’s Node requirement.
- `pnpm typecheck` passes under strict TypeScript.
- `pnpm test` passes 38 unit/RTL/adapter integration files and 274 tests, including queue mutation races, schemas, errors, event normalization/batching, replacement races, 5,000 entries, session-row actions, files, hardened Git operations, worktrees/history/details, settings persistence/recovery, and terminal ownership/output batching.
- A fresh direct main/preload/renderer/E2E build plus `pnpm exec playwright test` passes the full Electron scenario, including default follow-up queueing, preview, Steer conversion, Edit restoration, stable composer focus border, prompt streaming, tool card, composer scrollbar masking, global diff, Git graph/card, real worktree round-trip, and session switch.
- `pnpm audit --prod` reports no known vulnerabilities; patched transitive versions are pinned through pnpm 11 workspace overrides.
- Real `node-pty` loaded under Electron and executed `cmd.exe` output `PI_PTY_OK`.
- `pnpm package` produces a target-native Fate UI unpacked application; `pnpm smoke:packaged` verifies renderer startup and unpacked node-pty binaries. CI currently repeats this on Windows; macOS and Linux packages must be built natively by their users or a future native build host.

## Manual verification steps

1. Run `pnpm install` and `pnpm dev`.
2. Select a repository and review the native trust decision.
3. Confirm real Pi model/thinking controls populate; if not, run Pi `/login`, then reopen the project.
4. Send a prompt, press Enter during streaming to queue a follow-up, then verify preview, Steer, Edit, Cancel, attachments, and Stop alongside streamed text, reasoning, and tool cards.
5. Create/switch/fork/clone/compact sessions from their row actions and restart to confirm persistence.
6. Browse/search files; inspect per-file and global Monaco diffs; switch List/Graph; hover/focus commits; test GitHub/hash actions; and round-trip a secondary worktree.
7. Open the manual terminal, run a harmless command, resize/close it, and confirm it is labeled separately from Pi tools.
8. Open `Ctrl/Cmd+K`, settings, diagnostics, and logs; verify keyboard focus and reduced-motion preference.
9. Run `pnpm verify`, `pnpm smoke`, and `pnpm package`.

## Pi API discrepancies

- SDK 0.81.1 was checked against installed types and current `https://pi.dev/docs/latest/sdk` / `rpc` documentation.
- `prompt()` uses `preflightResult` because its promise resolves after the complete accepted run. Steering/follow-up use `prompt(..., { streamingBehavior })` so rejected queues are not falsely acknowledged and extension commands retain SDK behavior.
- Clone is the documented `runtime.fork(currentLeaf, { position: "at" })`; normal fork uses an SDK user-message entry.
- Project-bound services are created before checking model availability so trusted project extensions can register providers.
- The public `AgentSession` exposes prompt templates but not the complete bound extension-command registry, so autocomplete is limited honestly.
