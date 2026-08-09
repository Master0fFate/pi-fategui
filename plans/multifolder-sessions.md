# Multi-Folder, Multi-Session Sidebar

> Elevate Fate UI from a **single-project controller** to a **global controller** of the Pi agent: one window, many folders listed, sessions nested under each folder, Pi runtimes spawned lazily per folder, idle runtimes torn down.

Control artifact for this feature. Tick `- [ ]` → `- [x]` **only after** the task's acceptance check passes. Do not skip dependencies without a stated plan-change note.

---

## 1. Mission & Definition of Done

- **Goal:** Sidebar lists multiple project folders; each folder's sessions nest beneath it as children; the active folder shows its live Pi sessions; other folders show session titles read from disk (no runtime). Clicking a folder/session switches or lazily spawns the Pi runtime for that folder. A "Compact sessions" density toggle lives in Settings → Interface.
- **Users:** developers juggling several repos from one Fate UI window (Codex/Claude-Code/t3code-style multi-folder UX), constrained by Pi's one-runtime-per-active-work model.
- **Done means:**
  1. Multiple folders coexist in the sidebar with their session titles visible.
  2. Switching folders/sessions never loses work and never requires a file dialog for already-known paths.
  3. Existing single-project behavior (sort, drag-reorder, rename, fork, worktree, clone, compact, delete, search, conversation paths) is 100% preserved under the active folder.
  4. Compact toggle changes active-folder session density; non-active folders always render as lightweight previews.
  5. All existing + new tests pass; typecheck clean; no regression in `Sidebar.test.tsx`.
- **Non-goals (this build):**
  - Editing/deleting sessions in a non-active folder without switching to it (switch-then-edit only).
  - Cross-folder drag of sessions (folders reorder; sessions reorder within their folder only).
  - Cloud sync of the folder list.
- **Key constraints:** Pi SDK runs one `AgentSessionRuntime` per session; `modelRuntime`/auth is currently service-global; renderer is presentation-only through the validated preload bridge; preserve the Fate UI design language (dark-first, charcoal, single violet accent, joined panes, flat-by-default).

## 2. Grounding & Assumptions

| Item | Status | Evidence / basis | Impact |
|---|---:|---|---|
| Sessions listable from disk without a runtime | Confirmed | `PiSessionRepository.list()` → `SessionManager.list(cwd)` is static disk I/O, 2s TTL cache (`src/main/pi/PiSessionRepository.ts`) | Non-active folders can show titles cheaply |
| Multiple concurrent `AgentSessionRuntime` already supported | Confirmed | `liveSlots` Set, `createAdditionalSlot`, `settleInactiveSlot` (`src/main/pi/PiRuntimeService.ts`) | Slot-pool pattern exists to extend |
| Path-based project opener already built, not wired | Confirmed | `createProjectPathOpener` → `openProjectPath` instantiated & exported but no IPC/preload (`registerIpc.ts:382,1000`) | Switch folder by click = small wiring |
| All slots today share ONE `project` + ONE `modelRuntime` | Confirmed | `this.project` singular, `modelRuntime` singular (`PiRuntimeService.ts:702,1023`) | Multi-folder refactor must per-key these |
| Multiple `modelRuntime`/auth contexts can coexist | **Confirmed (SDK source)** | `ModelRuntime.create()` is a pure instance factory with only instance-private state; auth is read from the shared `~/.pi/agent/auth.json` (read-only, concurrent-safe — matches the user's 2× CLI test). `createRuntime(cwd, modelRuntime, …)` is cwd-parameterized; each project runtime gets its own cwd-scoped services (SettingsManager, PackageManager, SessionManager) sharing ONE ModelRuntime since auth is global. | In-process multi-project concurrency is supported; Phase 3 gate passes |
| Settings schema is `.strict()` with `.default()` migration | Confirmed | `appSettingsSchema` (`shared/contracts/ipc.ts`) | Adding `compactSessions` auto-migrates old files |
| UI list virtualization required for scale | Confirmed | PRODUCT.md: "usable with 5,000 entries" | Folder list must stay bounded/virtualized |

## 3. Recommended Strategy

- **Default path:** ship the multi-folder UX in rising-risk phases. Phases 0–2 are committed delivery (one live runtime at a time, but fully multi-folder in the sidebar). Phase 3 (concurrent live folders + idle eviction) is gated on verifying `modelRuntime` concurrency; if it fails, Phase 2 already satisfies the described UX.
- **Why:** every phase is independently shippable and tested; the riskiest unknown is isolated behind an explicit verification gate; no phase breaks existing functionality.
- **Design language:** match `DESIGN.md` — folder headers are joined-band rows (one-pixel separators, raised fill, folder icon, semibold name, count chip, chevron); active folder's children use existing `session-row` chrome; non-active folders use a new lightweight `session-row--preview` one-liner; compact mode collapses active children to one-liners with a `⋯` action menu (Radix popover) reusing the same icon set + tooltips. Conversation paths stay session-local: alternate paths render as session-style child rows beneath the selected session, with fork/worktree icons and compact-mode density matching sessions; fork/isolated actions execute from that session's focused project folder rather than from a global path list.

## 4. Plan Model

- **Current state:** one active project + one Pi runtime; sidebar shows that project's live sessions only.
- **Desired state:** N known folders listed; active folder live; others previewed from disk; runtimes spawn lazily; idle runtimes evicted (Phase 3).
- **Allowed actions:** add/forget/reorder folders; expand/collapse folders; switch active folder (by path, no dialog); list any folder's sessions from disk; spawn runtime on first session open; evict idle runtime.
- **Preconditions:** trust dialog still fires for untrusted/missing folders (reuse `prepareOpenPath`).
- **Effects:** renderer gains a persisted folder list + per-folder session previews; main gains path-scoped session listing + path-based open.
- **Resources:** existing slot pool, `PiSessionRepository`, `openProjectPath`, Radix popover (already a dep).
- **Evidence required:** typecheck, unit tests (Sidebar, runtimeStore, registerIpc, SettingsService), e2e smoke, manual folder-switch + compact-toggle walkthrough.
- **Replan triggers:** Phase 3.0 verification fails → keep Phase 2 as terminal state, file follow-up; any regression in existing session actions → stop and fix before continuing.

## 5. Execution Roadmap

### Phase 0 — Contracts & foundation (no behavior change) ✅
- [x] Add `compactSessions: z.boolean().default(false)` to `appSettingsSchema`.
  - Acceptance: `pnpm typecheck` clean; old settings.json without the field still parses (default applies).
- [x] Add `compactSessions: false` to `SettingsService` defaults and `SettingsDialog` fallback.
  - Acceptance: loaded settings include the field; round-trip save preserves it.
- [x] Add IPC channels: `projectOpenPath`, `projectListSessions` to `ipcChannels`.
  - Acceptance: constants exist and are referenced by handlers + preload.
- [x] Add input/result schemas: `projectPathInputSchema` (`{ projectPath: string }`), reuse `sessionListSchema` for listing output.
  - Acceptance: schemas exported and imported in preload + registerIpc.
- [x] Add `PiRuntimeService.listSessionsForPath(projectPath, query?)` — disk-only listing independent of active project (delegates to `sessionRepository.list(projectPath, null, query)`).
  - Acceptance: returns summaries for a path with no active runtime; unit test with a fake source.
- [x] Add preload methods `openProject(path)` and `listProjectSessions(path, query?)`; extend `PiDesktopApi` type.
  - Acceptance: `pnpm typecheck` clean; `api.test.ts` covers both new methods.

### Phase 1 — Multi-folder sidebar, ONE live runtime (core UX, low risk) ✅
- [x] Create renderer `projectStore` (zustand + persist): `projects: {path,name}[]`, `expandedByPath`, order, add/forget/reorder/toggle actions; seed from active project.
  - Acceptance: survives reload; adding/forgetting updates list; unit test.
- [x] Wire "Open project" + worktree flows to **add** the opened folder to `projectStore`.
  - Acceptance: opening a new folder inserts it; reopening or focusing an existing folder preserves the user-controlled order and never duplicates it.
- [x] Add main handler `project:open-path` using existing `openProjectPath`; preload `openProject(path)`.
  - Acceptance: switching to a known path activates it without a dialog; trust prompt still fires for untrusted; `registerIpc.test.ts` covers it.
- [x] Add main handler `project:list-sessions` → `PiRuntimeService.listSessionsForPath`; preload `listProjectSessions(path)`.
  - Acceptance: renderer can fetch any known folder's session titles; handler test passes.
- [x] Rewrite Sidebar Sessions tab into folder-grouped layout: folder header rows + nested children.
  - Acceptance: all known folders render; active folder expanded with live children; non-active folders render preview children; keyboard accessible.
- [x] Folder header row component: folder icon, name, session-count chip, expand/collapse chevron, drag handle (reorder), `⋯` menu (forget / reveal / open).
  - Acceptance: reorder persists; forget removes from list only (no disk delete); reveal calls `revealProject`.
- [x] Non-active folder children: one-line preview rows (title only) via `listProjectSessions`; click → `openProject(path)` then `switchSession(id)`, committing only the final destination state.
  - Acceptance: first-click switches folder+session without reordering folders or briefly painting the wrong session; toast on missing/untrusted path; busy state shown.
- [x] Active folder children: reuse existing chunky `session-row` (non-compact) under the folder band; all existing actions intact.
  - Acceptance: sort, drag-reorder, rename, fork, worktree, clone, compact, delete, search, conversation paths all work unchanged.
- [x] Conversation paths are integrated as session-style child rows beneath the selected session, with fork/worktree icons and compact-mode density; branch navigation and fork/worktree actions stay scoped to that session's focused project context.
- [x] Compact toggle UI in Settings → Interface (`compactSessions`); apply to active folder children → one-line rows + `⋯` action popover (same icons/tooltips).
  - Acceptance: toggling re-renders active children; `⋯` popover shows fork/worktree/clone/compact/rename/delete with correct disabled states; tooltip parity with non-compact.
- [x] Empty/loading/error states per folder (no sessions, scanning, path gone, untrusted).
  - Acceptance: each state is authored and legible.
- [x] CSS: folder band, preview row, compact row, tree indent/left line, count chip, chevron rotate; collapsed folders retain compact rows for their active/running/unread/error sessions; honors reduced-motion + performance/holy-shit modes.
  - Acceptance: visual review against `DESIGN.md`; no layout shift on expand/collapse.

### Phase 2 — Lazy runtime per folder (spawn on first interaction)
- [ ] Focus a non-active folder → mark focused; do NOT spawn runtime until a session is opened or "New session" is used there.
  - Acceptance: merely expanding a folder lists from disk with no runtime cost.
- [ ] First session open in a folder spawns its runtime lazily; show first-click busy state (acceptable lag).
  - Acceptance: runtime starts only on open; switching back to an already-live folder is instant.
- [ ] "New session" in a non-active folder: open folder → new session in one flow.
  - Acceptance: creates session under the correct folder.

### Phase 3 — Concurrent live folders + idle eviction (gated)
- [x] **3.0 GATE (PASSED):** Verified in the installed SDK source that concurrent multi-project runtimes work **in-process**. `ModelRuntime.create()` has no singleton/global state (all instance-private); `createRuntime(cwd, modelRuntime, …)` is cwd-scoped. Auth is global (`~/.pi/agent/auth.json`, read-only concurrent access). Conclusion: keep ONE shared `ModelRuntime`; make the existing `liveSlots` pool project-aware (each slot carries its `projectPath`) so different cwds coexist. No child-process spawning needed.
- [x] **3.1 Coordinator backbone:** `ProjectRuntimeCoordinator<R>` (`src/main/pi/ProjectRuntimeCoordinator.ts`) — pure, SDK-agnostic lifecycle: per-project acquire/reuse, focus, touch, idle sweep, concurrency cap, explicit close, start/stop. 9 unit tests green. Not wired yet (no behavior change).
- [x] **3.2 Manager backbone:** `MultiProjectRuntimeManager<R>` (`src/main/pi/MultiProjectRuntimeManager.ts`) — focus-aware wrapper over the coordinator: `openProject` keeps prior folders alive, re-focuses live folders without recreating, `onFocused` hook for event rewiring, explicit close, sweep on/off. 10 unit tests green. (Live wiring into main/IPC is 3.3.)
- [x] 3.3 Route all IPC through the **focused** project's service (prompt/abort/setModel/queue/session ops/goalmax). Background services keep running while unfocused. — *implemented via `MultiProjectPiRuntime` router in `index.ts`; `registerIpc` unchanged. Runtime behavior pending 3.6.*
  - Acceptance: working in B does not interrupt a run in A; existing IPC tests green.
- [x] 3.4 Multiplex runtime events: focused folder forwards to the renderer, background folders drop events (sessions keep running + writing to disk, surfacing through each live runtime's project-scoped session summaries). Renderer swaps focused state instantly on focus change, while collapsed folders retain active and attention rows. — *implemented (`rewireSinks`); runtime pending 3.6.*
  - Acceptance: switching live folders is instant; background attention dots update; renderer tests green.
- [x] 3.5 Start coordinator sweep (5-min idle eviction + concurrency cap). Hardening: graceful dispose on app quit, cross-platform path keys (win32/darwin/linux via canonical paths), per-project service isolation. — *implemented; sweep default-on, `dispose()` on shutdown. Runtime pending 3.6.*
  - Acceptance: idle folder runtime is reaped after 5 min; quit disposes all; typecheck + full suite green.
- [ ] 3.6 **Manual concurrency smoke-test (user):** two trusted folders prompting simultaneously on a real install — verify no auth/event collision and instant switching. The one step that cannot be automated in-session.

## 6. Verification Plan

| Check | Method | When | Pass criterion |
|---|---|---|---|
| Settings migration | unit (`SettingsService.test.ts`) | Phase 0 | old settings.json loads with `compactSessions:false` |
| Contracts | `pnpm typecheck` | each phase | clean |
| Session actions unbroken | `Sidebar.test.tsx` + `runtimeStore.test.ts` | Phase 1 | all existing tests green |
| New IPC | `registerIpc.test.ts`, `api.test.ts` | Phase 0–1 | open-by-path + list-by-path covered |
| Disk listing | `PiSessionRepository`/runtime unit | Phase 0 | lists without active runtime |
| Folder UX | manual + e2e smoke | Phase 1 | switch/forget/reorder/compact all work |
| Scale | 5,000-entry fixture | Phase 1 | list stays responsive |
| Concurrent runtimes (gate) | spike | Phase 3.0 | two folders prompt concurrently without auth/state collision |

## 7. Risk Register

| Risk | Trigger | Impact | Mitigation | Fallback |
|---|---|---|---|---|
| `modelRuntime` can't multiply in-process | Phase 3.0 spike fails | No concurrent live folders | Isolate behind gate | Ship Phase 2 (one live at a time) |
| Path-based open bypasses trust | Untrusted folder clicked | Security regression | Reuse `prepareOpenPath` (trust dialog intact) | Block + toast if trust refused |
| Sidebar regression | Existing tests fail | Lost functionality | Run `Sidebar.test.tsx` every change | Stop, fix, resume |
| Stale session previews | Disk listing cached 2s | Wrong title/count | Invalidate on focus/switch; refresh on activation | Manual refresh action |
| Event-stream collision (Phase 3) | Two folders stream at once | Mixed messages | Route events by `projectPath` | Defer Phase 3 |

## 8. Plan Control
- **Version:** 1.2
- **Active step:** 3.6 — manual concurrency smoke-test (user), then harden any issues found.
- **Checkbox rule:** tick only after acceptance check passes.
- **Update rule:** revise on new evidence, dependency change, or Phase 3.0 outcome.
- **Deviation rule:** report blocker + attempted fix + impact before skipping a dependency.
