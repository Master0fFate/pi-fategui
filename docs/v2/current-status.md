# V2 candidate status

**Status: source candidate, not an accepted V2 release. Updated 2026-10-04.** Read this page before following the [candidate setup guide](quickstart.md). Source support, an individual test result, a packaged target and release acceptance are different claims.

## Source and version

The published baseline is [`v2-native-pi-durable` commit `dcfadfc83c6be7f654f5fe8013f67eeedff1fc69`](https://github.com/Master0fFate/pi-fategui/commit/dcfadfc83c6be7f654f5fe8013f67eeedff1fc69). The consumer continuation is committed on that branch and proposed for `main` in [pull request 49](https://github.com/Master0fFate/pi-fategui/pull/49). Its hosted runs name the exact commit they checked; local verification reports identify their source by a source-byte manifest. No release or deployment has been made from it.

Two defects were found only when the hosted runners packaged V2 for the first time, and both are repaired in source. The installers omitted 165 runtime libraries: pnpm installs two peer variants of one Pi package version and lists the shared subtree under only one of them, and the packager remembered visited packages by name and version alone (`patches/app-builder-lib@26.15.3.patch`). The standard Pi themes were missing on a clean profile: Pi 1.0 writes its bundled themes with `okhsl()` colors, which the theme reader rejected. A developer profile with its own Pi themes hid that defect from the local packaged smoke, so the smoke now requires the two bundled themes by name.

The hosted macOS Intel runner then exposed an application that did not quit. Quitting loaded and started the global keyboard hook only to stop it, and that native start (`uiohook-napi`) can block the main thread for good. The hook is now stopped only when push-to-talk started it. A user who turns on push-to-talk still starts that hook once, so the library defect remains reachable there.

A profile or checkout lock left by a crash, a forced quit or a power loss is recovered at the next start; see [ownership and operator recovery](security-and-limits.md#ownership-and-operator-recovery).

Historical presentation evidence below belongs to [`4238ee090e6a2bb06d6447ae54dc0d5bdf25e0af`](https://github.com/Master0fFate/pi-fategui/commit/4238ee090e6a2bb06d6447ae54dc0d5bdf25e0af) and its parents. It does not refresh execution evidence for later working-tree changes.

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
| Explicit or migrated native profile | Desktop startup accepts `FATE_STATE_PERSISTENCE=native-durable`; trusted core/server composition accepts `statePersistence`. Successful migration activates a namespace that later ordinary startup selects automatically. These selectors do not migrate existing data. New host profiles can explicitly select `init --state-persistence native-durable`; init never overwrites an existing profile. Unspecified profiles retain the legacy default. |
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
| Conversation history | Original Pi session history | Named `session.history` paging is connected to web and remote-desktop clients. Workspace controls provide an on-demand saved-text reader, retaining one bounded page; current selection, cursor lifetime and client authority are checked |
| Permission changes | Host-owned grants and limits | Both reductions and elevations use the scoped one-use confirmation transaction. No-ops, stale authority and destinations above the host cap are denied. Focused backend tests pass; final native walkthrough remains pending |
| Manual terminal | Native unsandboxed human shell | Browser path implemented with explicit host opt-in, current control and pre-create warning. Real browser/PTY fixtures exercised both storage backends through a guarded host and separate owned native-I/O driver. Defaults remain off/read-only; native remote-desktop terminal remains unsupported. Same-process/package-native proof is a separate gate |
| Built-in browser, native file reveal | Local desktop only | Unavailable; remote browser automation deferred |
| Voice, hotkeys, ambient audio, native updates | Local desktop capabilities | Unavailable on the network workspace adapter; desktop updates do not update the remote host |
| Raster/image/media features | Existing local capabilities | Rich network media deferred |
| Themes, layout and clipboard text | Native presentation | Client-owned presentation and browser clipboard where available; no host settings/secret administration |
| Provider login, MCP configuration, credential import | Native host flow | Host-local administration only; no browser provider-key editor |

WSL management, automatic remote deployment, public/TLS or cross-user hosting, independent selected sessions per client, and a new TUI/provider engine remain deferred. Native upstream features do not automatically enable these product surfaces.

## Platform and validation matrix

| Target or gate | Current evidence boundary | What remains |
| :-- | :-- | :-- |
| Windows x64 desktop | Production Electron startup, second-window/one-owner, ordinary restart and scoped IPC exercised for legacy and native-Durable profiles (4 focused cases) | Complete candidate and installed artifacts, foreground-pointer, native picker/replacement and human walkthrough evidence remain separate |
| Linux x64 desktop | Existing desktop CI target; source/renderer evidence is narrower than installed use | Exact candidate desktop package and native walkthrough |
| macOS arm64/x64 desktop | Existing desktop CI targets | Exact candidate native package and behavior evidence; Linux builds cannot certify macOS |
| Linux x64 Node companion | Only enabled server package target | Clean target-native candidate package, complete runtime/data/license closure, optional Node PTY, checksums and extracted-artifact smoke |
| Other Node companion targets | Not enabled by the current package builder | Implementation/target decision and separate native package/PTY evidence before advertising support |
| Browser/headless workflows | Local plain-Node smoke passed legacy and native-Durable startup, turn, disconnect and ordinary restart. Complete legacy-backed browser E2E passed 10/10 | Same scenarios now run under both storage projects. Native crash/restart/no-replay, history, busy reductions and terminal cases have focused evidence. Use exact-candidate reports for complete-suite results; release gates remain separate |
| SSH and host service | Tunnel/lifecycle source and historical narrower checks exist | Approved preinstalled host, real host-key/auth/port/cancel cases, active work through tunnel/client loss, actual non-root user service and logout policy |
| Windows verification supervisor | Job Object supervision is implemented. Historical exact-baseline standalone run: 21 passed, 0 failed, 1 POSIX-only skip; all 17 Windows-specific cases passed | Application/process-tree and final-candidate native evidence remain separate from synthetic supervisor tests |
| Native server CI | Manual source workflow includes optional separate Linux x64 artifact jobs with and without PTY; successful archives carry source-byte identity and checksums | Run the hosted jobs on the final candidate. Workflow source is not artifact acceptance; desktop CI remains separate |
| Release acceptance | No final accepted V2 candidate/artifact matrix | Current independent security review, migration/rollback rehearsal, human acceptance, versioned artifacts and maintainer release decision |

See [verification](verification.md), [Node package instructions](../../build/server-package/README.md), and [host service requirements](remote-host-service.md). Source presence and old test counts do not pass these cells.

## Open implementation and evidence gates

- **Shared-instance ownership:** `--new-instance` selects another Chromium slot, but the core still owns the same canonical data root. A second live owner is refused. Preserving the promised independent-runtime/shared-session behavior needs an ownership design and implementation before installed-product verification. Another window is useful for synced viewing but does not implement independent runtimes.
- **History, permissions and parity:** saved-history paging, idle and active permission reductions, and common IPC/HTTP positive/negative fixtures are implemented. Saved-session headers are bound to the actual project even when Pi directory encodings collide. Admitted HTTP grant/journal writes and runtime permission transactions now participate in shutdown settlement; real-store barrier tests cover both backends. A debounced snapshot reload is now skipped when a newer refresh already started after the last invalidation, so a current saved-history page or Git view is not discarded for no new data. A Git status request that arrives during a read shares one following read and never receives the read already in flight, which could predate an agent edit. Source/route tests are not installed-product acceptance.
- **Rollout:** decide and validate release defaults and stopped-owner transitions. Focused native storage/scheduler tests do not prove every fresh desktop, server or browser flow uses Durable.
- **Performance and security:** same-stage Windows ACL batching avoids repeated process launches without caching decisions. Local three-path measurements: median 6,918 ms sequential versus 2,376 ms batched. The real-native migration case now passes in 15.881 seconds within its unchanged 90-second budget; all 30 migration cases passed locally after a Windows backup-flush repair. Operation-scoped ACL transport reuses process startup, not ACL decisions. It now also covers native workflow review (startup inspection, graph admission and the offline review and migration commands), the server-profile and authentication/tree startup preflight, and the workspace-identity lookup; every query stays live. Matched single local samples of production host start in the private test environment: `legacy-json` 10.3 s to 2.7 s (first start) and 12.6 s to 5.3 s (restart); `native-durable` 18.6 s to 10.4 s. Each remaining helper process costs about 2.6 s there. This is Windows host startup latency on one machine, not application runtime speed. One refused query ends a shared helper, so read-only workflow diagnosis repeats with independent queries and still reports one unsafe item as retained uncertain evidence. VSEC-0003 is repaired: if the ACL helper fails to finish after SQLite opened, the acquired store is closed before the failure escapes, and an unconfirmed close retains profile ownership; five real-SQLite cases cover this. Full final-candidate and independent review remain separate. The bounded load fixture also exercises 8 seconds of real sockets and 4 seconds of real native PTY output, with explicit refusal/recovery and confirmed cleanup. Its native I/O uses an owned test driver; it does not measure unqualified same-process PTY latency or establish matched desktop before/after performance. Final independent review and platform evidence remain required.
- **Distribution:** `react-remove-scroll-bar@2.3.8` has been removed from the current dependency graph. Older artifacts containing it retain their unresolved attribution issue. Current emitted web assets and complete notices still need exact-artifact verification. The historical narrow-tab defect has a current source repair; that is separate from full native UI acceptance. The Windows launcher now starts the first `node.exe` and companion shim on `PATH`; on hosts with several Node installs it previously joined every match into one nonexistent file name and failed. It also runs on stock Windows clients, whose default script policy refuses every script file: `fate.cmd` allows only its own installed launcher script, for that one process, and the launcher does not pass that policy to the application or host it starts. A Group Policy setting still takes precedence. Tooltips now open from keyboard focus only: a pointer-closed dialog that returns focus to its opener no longer raises a tooltip over neighboring controls.

## Documentation acceptance

The built CLI native-profile/explicit-terminal initialization example and its missing-acknowledgement refusal have been exercised in private fixtures without starting a provider. **This does not accept every T56 example.** Remaining examples need clean candidate-specific command, source, environment, exit and limitation records. Required `pnpm typecheck`, `pnpm test:v2` and `pnpm verify:v2` results must be bound to that candidate; they were not run for this documentation update. T55 rollout acceptance and later release/human gates remain open.
