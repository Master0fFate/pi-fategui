# V2 candidate status

**Status: source candidate, not an accepted V2 release. Updated 2026-10-02.** Read this page before following the [candidate setup guide](quickstart.md). Source support, an individual test result, a packaged target and release acceptance are different claims.

## Source and version

The published implementation checkpoint is [`v2-native-pi-durable` commit `4238ee090e6a2bb06d6447ae54dc0d5bdf25e0af`](https://github.com/Master0fFate/pi-fategui/commit/4238ee090e6a2bb06d6447ae54dc0d5bdf25e0af). It contains the search-focus repair and its parent [Files/Changes splitter repair `3ca0c00bcb05f6f2591d68cade9b21940301276b`](https://github.com/Master0fFate/pi-fategui/commit/3ca0c00bcb05f6f2591d68cade9b21940301276b), both above [baseline `0e8bcadda9e84a8e844a5c7cff9c3849f4a194a1`](https://github.com/Master0fFate/pi-fategui/commit/0e8bcadda9e84a8e844a5c7cff9c3849f4a194a1). Later documentation-only commits do not refresh its execution evidence.

The combined presentation increment passed 61 focused tests, full TypeScript checking and a web build; 143 emitted JavaScript files had no unresolved local modules. These local checks cover the repaired presentation scope. No browser/native/application run or hosted check/run result was recorded for that increment, and it does not supply full V2, backend or platform acceptance.

`package.json` and `PRODVER` still identify the application as **1.1.0**. That does not identify a newly accepted V2 artifact, prove compatibility with another 1.1.0 binary, or mean these changes are in `main`. The retained branches are `main`, `backup/main-before-m4-02518314500b`, and `v2-native-pi-durable`. The old `windows-m5-verification` and `v2-preparation-linux` branches were intentionally deleted. Use exact published commits when comparing evidence.

The [M5 Linux handoff](M5-linux-handoff.md), [Windows prompt](M5-Windows-verification-prompt.md), and [preparation record](M5-linux-preparation.md) preserve historical source bindings, counts and artifact receipts. Their commands, branch names, limits and acceptance statements are not current instructions. Missing older unpublished source has not been recovered and contributes no current acceptance evidence.

## Pi 1.0 and Durable rollout

The selected upstream packages are pinned to **1.0.0**. See [SDK compatibility](../sdk-compatibility.md) for the integration and carried patches.

| Area | Current implementation and boundary |
| :-- | :-- |
| Provider, model and conversation execution | Pi SDK owns provider/model/session execution and original JSONL transcripts. |
| Queue, task and GoalMax document storage | When `native-durable` is selected, one profile-owned Pi Durable/Chord store supplies these repositories. Mixed ownership and fallback over retained native evidence are refused. |
| New native workflow graphs | Native Tasks and receipts own DAG admission and dependencies; the existing Team/SDK child path still executes the work. Legacy graph history remains separate. |
| Retained Fate responsibilities | Project trust, host permissions, control, checkout/worktree review, Team mailbox/capacity, GoalMax evidence, bounded client data and explicit uncertainty review. |
| Fresh unspecified profile | Defaults to `legacy-json`. Installing native packages does not change this default. |
| Explicit or migrated native profile | Desktop startup accepts `FATE_STATE_PERSISTENCE=native-durable`; trusted core/server composition accepts `statePersistence`. Successful migration activates a namespace that later ordinary startup selects automatically. These selectors do not migrate existing data. The standard host CLI has no native-selection switch. |
| Native transport | `pi-client`, `pi-server` and `pi-protocol` are pinned dependencies, but production `src` does not import them. Fate still uses its version 1 JSON HTTP/WebSocket contract. Installing packages is not adoption of Pi's native transport. A compatible transport change requires separate design and validation. |

Use the [migration guide](migration.md) and [host-local migration procedure](migration-cli.md) for existing state. A corrupt, incompatible or incomplete native namespace blocks startup rather than selecting legacy state. No selector authorizes automatic replay of uncertain work. See [workflow review](native-workflow-review.md).

## Capability matrix

These are source-backed availability boundaries, **not a matrix of accepted platform tests**. A feature also needs a supported client, advertised host capability, workspace membership, current control where required, and permission. See [security and limits](security-and-limits.md).

| Feature | Local desktop | Local web / remote desktop connection |
| :-- | :-- | :-- |
| Chat, model selection, sessions, queues | Existing native route | Scoped network route implemented; final native-backed end-to-end acceptance pending |
| GoalMax, tasks, agent/Team controls | Existing runtime | Bounded shared operations implemented; saved Agents/Routines and Memory Learning network parity deferred |
| Monitor | Existing scoped view | Requires host/workspace monitoring support; unsupported is not an empty healthy view |
| Files and text context | Native files and attachments | Registered-root tree/text preview and bounded text context; remote paths stay on the host |
| Git | Native reads and actions | Status, diff and history reads; reviewed managed child-worktree operations are separately typed. Ordinary commit, revert, cleanup, fetch, pull and push remain unsupported |
| Conversation history | Original Pi session history | Current snapshots are paged; the separate older-history paging service is not connected to a production client |
| Permission changes | Host-owned grants and limits | Approval path exists, but the selector offers reductions that the challenge route rejects. Do not rely on it to lower authority until repaired and verified |
| Manual terminal | Native unsandboxed human shell | No advertised network terminal route. Host composition has an opt-in policy seam, but CLI profiles keep it disabled; including `node-pty` does not enable it |
| Built-in browser, native file reveal | Local desktop only | Unavailable; remote browser automation deferred |
| Voice, hotkeys, ambient audio, native updates | Local desktop capabilities | Unavailable on the network workspace adapter; desktop updates do not update the remote host |
| Raster/image/media features | Existing local capabilities | Rich network media deferred |
| Themes, layout and clipboard text | Native presentation | Client-owned presentation and browser clipboard where available; no host settings/secret administration |
| Provider login, MCP configuration, credential import | Native host flow | Host-local administration only; no browser provider-key editor |

WSL management, automatic remote deployment, public/TLS or cross-user hosting, independent selected sessions per client, and a new TUI/provider engine remain deferred. Native upstream features do not automatically enable these product surfaces.

## Platform and validation matrix

| Target or gate | Current evidence boundary | What remains |
| :-- | :-- | :-- |
| Windows x64 desktop | Existing desktop CI target and historical native receipts | Exact candidate installed launcher, forwarding, ACL/TTY/ConPTY, picker/replacement, renderer/input and human walkthrough |
| Linux x64 desktop | Existing desktop CI target; source/renderer evidence is narrower than installed use | Exact candidate desktop package and native walkthrough |
| macOS arm64/x64 desktop | Existing desktop CI targets | Exact candidate native package and behavior evidence; Linux builds cannot certify macOS |
| Linux x64 Node companion | Only enabled server package target | Clean target-native candidate package, complete runtime/data/license closure, optional Node PTY, checksums and extracted-artifact smoke |
| Other Node companion targets | Not enabled by the current package builder | Implementation/target decision and separate native package/PTY evidence before advertising support |
| Browser/headless workflows | Test sources exist; fresh-profile fixtures default to legacy storage | Current native-Durable-backed startup, browser, reconnect and restart matrix |
| SSH and host service | Tunnel/lifecycle source and historical narrower checks exist | Approved preinstalled host, real host-key/auth/port/cancel cases, active work through tunnel/client loss, actual non-root user service and logout policy |
| Windows verification supervisor | Direct-child exit deliberately leaves ownership unconfirmed | Implement and validate whole-tree Windows Job Object supervision; a Windows test run cannot supply missing code |
| Native server CI | Manual Linux source-only workflow exists | Independent Node artifact/PTY jobs and exact-SHA platform results; existing desktop CI is a separate workflow |
| Release acceptance | No final accepted V2 candidate/artifact matrix | Current independent security review, migration/rollback rehearsal, human acceptance, versioned artifacts and maintainer release decision |

See [verification](verification.md), [Node package instructions](../../build/server-package/README.md), and [host service requirements](remote-host-service.md). Source presence and old test counts do not pass these cells.

## Open implementation and evidence gates

- **Shared-instance ownership:** `--new-instance` selects another Chromium slot, but the core still owns the same canonical data root. A second live owner is refused. Preserving the promised independent-runtime/shared-session behavior needs an ownership design and implementation before installed-product verification. Another window is useful for synced viewing but does not implement independent runtimes.
- **History, permissions and parity:** connect older-history paging, repair permission reduction semantics, and run a common positive/negative IPC-versus-HTTP contract matrix. These are not Windows-only acceptance tasks.
- **Rollout:** decide and validate release defaults and stopped-owner transitions. Focused native storage/scheduler tests do not prove every fresh desktop, server or browser flow uses Durable.
- **Performance and security:** current synthetic bounds do not establish sustained real terminal/socket/client bounds or matched desktop before/after performance. Final-candidate independent security review remains required.
- **Distribution:** `react-remove-scroll-bar@2.3.8` has been removed from the current dependency graph. Older artifacts containing it retain their unresolved attribution issue. Current emitted web assets and complete notices still need exact-artifact verification. The historical narrow-tab defect has a current source repair; that is separate from full native UI acceptance.

## Documentation acceptance

This update checks documentation against source and checks local text/links only. **T56 command-example execution and acceptance remain pending.** Every example must be exercised in a clean fixture against the final candidate, with actual command, source identity, environment, exit code and limitations recorded. Required `pnpm typecheck`, `pnpm test:v2` and `pnpm verify:v2` results must be bound to that candidate; they were not run for this documentation update. T55 rollout acceptance and later release/human gates remain open.
