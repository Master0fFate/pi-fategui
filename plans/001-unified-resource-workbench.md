# Plan 001: Make Fate UI a unified resource workbench without collapsing security boundaries

> **Implementation note**: The product owner approved the sidebar-first concept after this plan was drafted: persistent **Sessions / Automations / Resources** tabs in the left pane plus a universal command center. The approved increment was implemented without resetting or committing the substantial pre-existing Browser working tree. Continue to preserve that work; arbitrary OS computer control and scheduled/background automation still require separate approval.
>
> **Drift check**: `git status --short && git diff --stat && git diff --stat b1ecc95..HEAD -- src/main src/preload src/renderer src/shared tests/e2e`

## Status

- **Priority**: P1
- **Effort**: XL, delivered as several gated increments
- **Risk**: HIGH overall; MED for the first Resource Hub increment
- **Depends on**: preserving the current in-progress Browser implementation and its permission boundaries
- **Category**: direction / architecture / UX
- **Planned at**: commit `b1ecc95`, 2026-08-06, plus an uncommitted Browser working tree
- **Plan state**: IN PROGRESS — approved sidebar-first resource/automation increment implemented; later scheduling and computer-use tracks remain deferred

## Why this matters

The beta feedback is directionally correct: Fate UI already contains many useful resources, but users must know where each one lives. Files are under **Work**, Pi skills/prompts/extensions are under **System**, tools and agent workflows are under **Run**, Browser is a center-workspace toggle, and Terminal is a bottom drawer. The product behaves like several capable panes rather than one coherent workbench.

The right response is **one discovery and launch point with shared context**, not one giant panel and not one master permission switch. Files, browser tabs, Pi resources, goals, workflows, automations, and later computer targets should be findable together while their privileged operations remain isolated behind existing typed services and distinct grants.

## Confirmed product decisions

1. **Computer use**: arbitrary desktop/window observation and control is not implemented. The UI labels Computer as unavailable and directs users to the real permission-scoped Browser capability.
2. **Automation lifetime**: the shipped increment saves reusable project prompts and prepares them manually in a fresh session for user review. It has no schedule, daemon, background run, or auto-send behavior.
3. **Filesystem scope**: resource search and file navigation remain confined to the active project through the existing Filesystem service.
4. **Automation authority**: saved automations accept only Read only or project-confined Edit access. Main-process session preparation applies and persists that boundary before publishing the new session.

## Recommended interpretation of “one place”

### Vocabulary

- **Resource**: something the user can find, open, attach, inspect, or run.
- **Pi Library**: the existing extensions, prompt templates, and skills currently called “Resources.”
- **Capability**: a privileged action such as reading a file, interacting with an origin, or controlling a desktop target.
- **Automation**: a user-owned reusable definition plus its run history; GoalMax and subagent DAGs are execution primitives, not themselves an automation catalog.

### UX thesis

Use the approved two-layer solution:

1. A persistent tabbed left sidebar with **Sessions**, **Automations**, and **Resources**, visually aligned with the understated inspector tabs.
2. **Cmd/Ctrl+K** as a universal command center that combines app actions with project files, browser tabs, Pi Library items, sessions, and saved automations.

The left sidebar owns discovery and navigation, the center owns active work, and the right inspector owns context. Resource types remain grouped inside Resources rather than becoming additional top-level horizontal tabs.

Selecting an item deep-links into the existing purpose-built surface:

- file → **Work / Files** and select the file;
- changed file → **Work / Changes**;
- browser tab → open Browser and activate the tab;
- skill/prompt/extension → insert the correct invocation into Composer and focus it;
- goal/workflow → **Run / Goal** or **Run / Agents**;
- terminal → open the manual terminal;
- automation → open its definition or run detail.

Do not cram Monaco, native Chromium, run history, and permissions into one inspector pane. “One place” means one mental map and one launch surface, while rich work remains in the correct editor or viewport.

## Current state and evidence

| Area | What exists now | Planning implication |
|---|---|---|
| Shell | `src/renderer/app/AppShell.tsx:15` implements a resizable left sidebar, center workspace, and right inspector. | Preserve the focused three-pane workbench; avoid a shell rewrite. |
| Navigation | `src/renderer/features/shell/Inspector.tsx:26-54` splits views into Work, Run, and System. Browser and Terminal live outside this structure. | Add shared discovery/deep links rather than another disconnected destination. |
| Pi resources | `src/renderer/features/resources/ResourcesPanel.tsx:34-61` only lists extensions, prompt templates, and skills. It has no search or actions. | Rename this concept to Pi Library and make it one provider in a broader hub. |
| Files | `src/renderer/features/files/FilesPanel.tsx:59-115` provides a virtualized tree, fuzzy search, Monaco/image preview, and safe external open. `src/main/files/FilesystemService.ts:250` owns project-root confinement. | Reuse its on-demand search. Never materialize every file into a global registry. |
| Resource insertion | `src/renderer/features/chat/Composer.tsx:385-464` already searches slash commands and project file tags. | Extract reusable query/ranking/navigation behavior instead of duplicating it. |
| Command palette | `src/renderer/features/commands/CommandPalette.tsx:11-75` searches app commands, models, and thinking levels only. | This is the lowest-risk first “one place” entry point. |
| Browser | The working tree adds `src/main/browser/*`, `src/main/pi/BrowserRuntimeBridge.ts`, `src/main/pi/PiBrowserTools.ts`, `src/renderer/features/browser/*`, and `src/shared/contracts/browser.ts`. | Stabilize and land it first. Treat it as browser use, not OS computer use. |
| Browser composition | `src/renderer/stores/uiStore.ts:148-149` collapses the inspector whenever Browser opens; `src/renderer/features/shell/Workspace.tsx:128-141` uses a chat/browser split. | Stop automatically hiding the very resources the tester wants available. Use width-aware composition instead. |
| Browser authority | `src/main/browser/BrowserPolicy.ts:153` keeps `off/observe/interact` and per-origin grants; `src/main/browser/BrowserHost.ts:38` binds ownership and confirmations. | Show permissions together, but keep browser grants independent from file/shell permission. |
| Browser tools | `src/main/pi/PiBrowserTools.ts:42-202` provides navigate, snapshot, click, type, press, scroll, and tabs. | Add work-log/grant UX before expanding to upload/download/select/submit. |
| Project permission | `src/main/pi/PiToolPolicy.ts:14-25` separates Read only, Edit files, and Full access. Composer explicitly warns that Full access is unsandboxed. | Never create a universal “allow everything” control for the hub or automations. |
| Terminal | `src/renderer/features/terminal/TerminalPanel.tsx:108-110` visibly labels the manual terminal as separate from Pi tools. | Keep that distinction in the Hub and run provenance. |
| Goal/workflows | GoalMax persistence/scheduling and model-created subagent DAGs exist under `src/main/pi/goalmaxxing/*` and `src/main/pi/SubagentWorkflow.ts`. | Reuse lifecycle ideas, but do not market these as user-scheduled automations. |
| Automations | No user automation definition, catalog, trigger schema, scheduler, or run-history surface exists. | Build manual reusable recipes before time-based or background execution. |
| Computer use | No Fate UI desktop capture, window inventory, OS input service, computer-use contract, or packaging dependency exists. | Require an isolated security/platform spike before implementation. |

### Verification record

Baseline while planning:

- `pnpm typecheck` passed.
- `pnpm test` passed: 108 test files, 848 tests.

Implemented sidebar-first increment:

- `pnpm typecheck` passed.
- `pnpm test` passed: 112 test files, 888 tests.
- `pnpm test:e2e` passed: 3 tests, including the resource/automation workflow and the existing Browser flow.
- `pnpm build` passed independently and as part of the E2E build gate.
- `pnpm smoke` and `pnpm package` passed on Windows x64, including a real manual-terminal PTY spawn/data/exit check from the packaged app.
- `.github/workflows/cross-platform.yml` runs verification, packaging, installation, and the same PTY smoke marker on Windows x64, macOS arm64/x64, and Linux x64.

Re-run all four gates after any subsequent repair; these recorded results are evidence for the implementation state, not a substitute for final verification.

## Chosen architecture

### 1. Federated catalog, not a giant array

Create `src/shared/contracts/resources.ts` with Zod schemas and inferred types. Keep this separate from the already-large `src/shared/contracts/ipc.ts`.

The contract should define at least:

- `ResourceKind`: `project-file`, `project-folder`, `change`, `browser-tab`, `browser-origin`, `pi-extension`, `prompt-template`, `skill`, `goal`, `agent-workflow`, `terminal`, `automation`, `automation-run`;
- `ResourceScope`: project/session/task/global plus a redacted display label;
- `ResourceDescriptor`: stable ID, kind, title, subtitle, status, scope, provenance, updated time, access summary, and supported **navigation** targets;
- `ResourceQuery`: text, kinds, project/session identity, bounded limit, optional cursor;
- `ResourceQueryResult`: bounded items, optional continuation cursor, and provider-level unavailable states;
- `ResourceEvent`: invalidate or upsert/remove only for small dynamic providers.

Do **not** include arbitrary action names plus arbitrary payloads. A generic `executeResourceAction(name, args)` would bypass the narrow IPC boundary. Descriptors may identify a typed navigation target; actual operations continue through domain-specific IPC such as `readFile`, `activateBrowserTab`, or future `runAutomation`.

### 2. Main-process provider registry

Add `src/main/resources/ResourceCatalogService.ts` and focused providers under `src/main/resources/providers/`.

Provider behavior:

- **Files** delegates to `FilesystemService.search()` and `list()` on demand; results are bounded and generation-checked.
- **Changes** projects the current bounded `GitStatus` rather than rescanning Git per keystroke.
- **Pi Library** projects `PiRuntimeService.getState(false).commands` and `.skills`; do not expose private SDK objects.
- **Browser** projects current tabs and sanitized origin/grant state from `BrowserHost.current()`; strip URL credentials, query, and fragment from catalog metadata.
- **Run** projects the active goal and bounded workflow summaries already present in runtime state.
- **Terminal** advertises availability only; it never exposes PTY contents through the catalog.
- **Automations** is added only after its repository exists.

The service must merge, rank, de-duplicate, cap, and cancel stale requests without retaining a full filesystem index in renderer memory. Start with a global result cap of 100 and a per-provider cap of 25; change these only with a performance test.

### 3. Narrow IPC and preload

Extend:

- `src/shared/contracts/ipc.ts` with named resource query/event channels and `PiDesktopApi` methods that reference schemas from `resources.ts`;
- `src/main/ipc/registerIpc.ts` with renderer-policy-checked handlers;
- `src/preload/api.ts` with input and output parsing;
- `src/main/index.ts` with service construction.

Initial API:

- `queryResources(input): Promise<ResourceQueryResult>`;
- optional `onResourceEvents(listener)` for small dynamic invalidations.

Do not add file contents, browser snapshots, terminal output, raw credentials, or OS handles to this API.

### 4. Renderer navigation, not renderer authority

Add a small `resourceNavigation.ts` adapter and a bounded `resourceHubStore.ts`.

Navigation maps typed targets to existing store/API calls. It must revalidate current project/session identity before acting and show an honest stale/unavailable toast when the resource moved.

Required mappings:

- file: open inspector Work/Files, initialize Files, select the path;
- change: open Work/Changes and select the change;
- browser tab: require a trusted project, open Browser, then activate the tab;
- Pi Library item: insert its invocation into the active session draft without auto-sending;
- goal/workflow: open the corresponding Run view;
- terminal: toggle the manual terminal only for a trusted project;
- automation/run: navigate only after that feature exists.

### 5. Keep permission dimensions separate

Present access together in the Hub, but retain separate policies:

- Project/Pi: Read only, Edit files, Full access;
- Browser: off, observe, interact plus origin grants;
- Future Computer: off, observe, interact plus display/window grants;
- Automation: immutable permission snapshot plus bound resources for each run.

A run must never infer computer or browser authority from Full access. Scheduled automations must not use Full access in the first release.

## Scope

### Immediate MVP — in scope

- `src/shared/contracts/resources.ts` and tests (new)
- `src/main/resources/**` and tests (new)
- `src/renderer/features/resources/ResourceHubPanel.tsx` and tests (new)
- rename/reframe the current Pi-only Resources panel as `PiLibraryPanel`
- `src/renderer/features/commands/CommandPalette.tsx`
- `src/renderer/features/shell/Inspector.tsx`
- `src/renderer/features/shell/Workspace.tsx`
- `src/renderer/stores/uiStore.ts`
- `src/renderer/stores/workspaceStore.ts`
- `src/renderer/app/App.tsx`
- `src/shared/contracts/ipc.ts`
- `src/main/ipc/registerIpc.ts`
- `src/preload/api.ts`
- `src/main/index.ts`
- focused CSS in `src/renderer/styles/global.css`
- unit/integration tests beside changed modules and essential Playwright coverage
- documentation updates in `README.md`, `PRODUCT.md`, `DESIGN.md`, and `BUILD_NOTES.md`

### Later gated increments — in scope only after MVP passes

- `src/shared/contracts/automations.ts` (new)
- `src/main/automations/**` (new)
- `src/renderer/features/automations/**` and store/tests (new)
- optional explicit granted-folder service after the filesystem decision is confirmed
- computer-use ADR/threat-model/prototype only; production computer control requires a separate approved execution plan

### Out of scope

- replacing Electron, React, Zustand, or the three-pane workbench;
- turning Fate UI into a general-purpose file manager;
- exposing raw Node/Electron/filesystem/shell APIs to renderer;
- a generic resource action RPC;
- a universal permission switch;
- silent host-wide filesystem browsing;
- hidden or remote desktop control;
- scheduled Full access;
- running automations after Fate UI quits in the first release;
- styling unrelated surfaces while touching global CSS.

## Execution roadmap

### Phase 0 — Stabilize the current Browser tranche

- [ ] Move the existing browser working tree to a dedicated branch/commit without mixing Resource Hub work.
- [ ] Verify the typed browser contracts, native `WebContentsView`, origin/private-network policy, action confirmations, annotation flow, session lease, project switching, and packaged behavior.
- [ ] Render the bounded browser work log and grant management, or explicitly defer both with a tracked limitation.
- [ ] Update this plan’s `Planned at` SHA if the Browser tranche is later checkpointed independently; do not mix or reset it as part of this increment.

**Verify**:

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Expected: all commands exit 0. Manually verify navigation, tab switching, pause/takeover, site grants, a confirmed consequential action, a blocked private-network action, project switch cleanup, and app-dialog overlay behavior.

**Gate**: the product owner explicitly approved the sidebar-first increment on the existing dirty tree. Preserve and verify the Browser work; do not reset, overwrite, or silently include it in an unrelated commit.

### Phase 1 — Lock vocabulary, IA, and success criteria

- [ ] Update `PRODUCT.md` to define Resources, Pi Library, Capabilities, and Automations using the vocabulary above.
- [ ] Update `DESIGN.md` with the Resource Hub + universal switcher topology. Preserve “Focused Workbench,” joined panes, one-signal color, keyboard operation, and honest unavailable states.
- [ ] Create two low-cost interaction prototypes: (A) searchable inspector Hub and (B) universal switcher results grouped by provider.
- [ ] Test five tasks with at least three beta users: open a file, activate a browser tab, invoke a skill, inspect a running workflow, and find an automation placeholder/definition.

**Acceptance**:

- At least 80% of tasks complete without coaching.
- A user can reach each existing resource type from one entry point in at most two actions.
- No tester interprets the Hub as granting authority by itself.
- The product owner has confirmed the implementation decisions near the top of this plan.

### Phase 2 — Add the read-only federated resource catalog

- [ ] Define and test schemas in `src/shared/contracts/resources.ts` with strict objects, bounded strings/arrays, stable IDs, and provider unavailable states.
- [ ] Implement `ResourceCatalogService` and providers for files, changes, Pi Library, browser, run state, and terminal availability.
- [ ] Add named query IPC/preload methods with parsing on both sides and trusted-renderer enforcement.
- [ ] Add cancellation/generation logic so project or session changes invalidate stale responses.
- [ ] Add bounded ranking tests with 50,000 file candidates, 5,000 Pi commands, browser tabs, duplicate labels, and unavailable providers.

**Verify**:

```bash
pnpm exec vitest run src/shared/contracts/resources.test.ts src/main/resources src/preload/api.test.ts src/main/ipc/registerIpc.test.ts
pnpm typecheck
```

Expected: all tests pass; no resource query returns more than its contract limit; no path escapes the active project provider.

### Phase 3 — Ship the Resource Hub and universal switcher

- [ ] Convert the current Pi-only Resources UI into `PiLibraryPanel`; render it inside a searchable `ResourceHubPanel` that replaces the existing System/Resources tab content and groups Project, Web, Agent, and Automations without nested-card clutter.
- [ ] Upgrade Cmd/Ctrl+K to combine local commands with asynchronous resource results, provider loading/unavailable states, stale-query cancellation, full keyboard navigation, and type-specific icons.
- [ ] Add typed deep-link navigation for files, changes, browser tabs, Pi Library items, goals/workflows, and terminal availability.
- [ ] Keep Composer text intact when inserting a Pi Library invocation; never auto-send.
- [ ] Remove unconditional inspector collapse from `setBrowserOpen`. If narrow-window layout cannot show chat, browser, and inspector, use a deterministic compact mode that preserves a visible way back and remembers the user’s prior state.
- [ ] Add empty/loading/error/truncated/stale states and screen-reader announcements.

**Verify**:

```bash
pnpm exec vitest run src/renderer/features/resources src/renderer/features/commands src/renderer/stores/uiStore.test.ts src/renderer/features/shell/WorkspaceBrowserModes.test.tsx
pnpm typecheck
pnpm test:e2e
```

Expected: all tests pass. Playwright proves keyboard-only open/search/activate flows for a file, browser tab, and skill; browser opening no longer destroys access to the inspector on a wide viewport.

### Phase 4 — Add explicit filesystem locations only if confirmed

- [ ] If “filesystem” means more than the active project, create a separate `GrantedLocationService`; do not convert `FilesystemService` into a multi-root authority because Git and Terminal depend on its single active project root.
- [ ] Add native folder selection, canonicalization, persisted display metadata, explicit read-only/edit grant, revoke, missing-volume, and symlink-escape handling.
- [ ] Default to read-only; require a separate confirmation before edit access. Never infer this grant from session Full access.
- [ ] Add a Location provider to the Hub and show scope on every result.

**Gate**: skip this phase if the tester only meant project files.

### Phase 5 — Add reusable automations before scheduling

- [ ] Define strict `AutomationDefinition` and `AutomationRun` schemas in `src/shared/contracts/automations.ts`.
- [ ] Persist versioned, atomic data under `FATE_GUI_DATA_DIR/automations/v1` or `~/.pi/fateGUI/automations/v1`, following existing repository/logging patterns.
- [ ] First ship **Save as automation** and **Open in new session**: name, prompt, project binding, model, thinking level, requested permission, and explicit browser origins/resources. The prompt is loaded into Composer for review and is not auto-sent.
- [ ] Add definition list/detail, duplicate, disable, delete, manual launch, and bounded run history.
- [ ] Spike whether `PiRuntimeService` can safely execute a non-selected automation session. If selection, browser lease, event routing, or working-tree state leaks, STOP and design a separate `AutomationRuntimeHost` around the real Pi SDK instead of forcing it through selected UI state.
- [ ] For true **Run now**, allow only Read only or project-confined Edit files initially; one mutating automation per project at a time; browser origins must be explicitly bound; computer use is unavailable.
- [ ] Record trigger, permission snapshot, bound resources, session ID, timestamps, status, approvals, result, and failure in each run.

**Verify**:

```bash
pnpm exec vitest run src/shared/contracts/automations.test.ts src/main/automations src/renderer/features/automations
pnpm typecheck
pnpm test:e2e
```

Expected: repository recovery, atomic-write interruption, duplicate launch, project lock, permission drift, cancellation, and app restart fixtures pass. No run can elevate its captured authority.

### Phase 6 — Add open-app scheduling and restart recovery

- [ ] Add one-time and simple daily/weekly triggers with explicit timezone and missed-run policy. Defer arbitrary cron syntax until user demand proves it is needed.
- [ ] Implement a main-process scheduler with persisted `nextRunAt`, clock/sleep recovery, idempotency keys, per-project concurrency, cancellation, and bounded event delivery.
- [ ] On startup, mark interrupted runs honestly and apply the selected missed-run policy; never silently replay a mutating run.
- [ ] When Fate UI is closed, show “Runs while Fate UI is open.” Do not imply daemon behavior.
- [ ] Pause runs waiting for approval; they must not auto-approve because the UI is unavailable.

**Acceptance**: deterministic fake-clock tests cover DST, timezone change, sleep/wake, clock rollback, duplicate startup, missed runs, and restart during mutation. Full access remains rejected by schema/service policy.

### Phase 7 — Computer-use go/no-go spike

- [ ] Confirm whether users need arbitrary desktop control or only the built-in browser.
- [ ] Write a threat model and platform capability matrix for Windows, macOS, Linux X11, and Linux Wayland.
- [ ] Prototype **observe only** first: explicit display/window selection, OS permission guidance, bounded screenshots, visible capture indicator, redaction, and immediate stop.
- [ ] Separately evaluate input control. Require window identity binding, coordinate/version checks, human-input takeover, emergency stop, action classification, confirmations, audit log, and fail-closed behavior.
- [ ] Keep contracts/services separate (`src/shared/contracts/computer.ts`, `src/main/computer/*`) and expose no raw OS handles to renderer or model.
- [ ] Decide supported platforms honestly; an unavailable Wayland state is better than a misleading control.

**Go criteria**:

- OS permissions can be detected and explained reliably.
- Input can be bound to the selected current target and cancelled safely.
- Human input pauses control.
- Sensitive text, password fields, payments, destructive actions, and cross-app data transfer have explicit policy.
- Packaging and native CI can support the chosen implementation.

**No-go**: if any criterion fails, ship Browser + manual takeover and do not label it computer use.

### Phase 8 — Beta validation and release gates

- [ ] Run the original five discovery tasks plus save/run an automation with new and returning beta users.
- [ ] Verify large-state performance: 50,000 searched files, 5,000 Pi commands, maximum browser tabs, 500 automation definitions, and 5,000 run-history rows using bounded/virtualized presentation.
- [ ] Perform a permission review that traces every Hub action to a named IPC handler and domain policy.
- [ ] Update README capabilities and limitations without claiming background automation or computer control that is not shipped.
- [ ] Capture release screenshots and test keyboard-only, reduced-motion, narrow-window, offline, auth-required, untrusted-project, stale-resource, and provider-unavailable states.

## Test plan

### Contracts and main process

- strict schema rejection for extra keys, overlong values, invalid cursor/kind, and oversized result sets;
- provider isolation: one failure returns an unavailable provider without failing all results;
- path confinement, symlink escape, project switch, and stale query generation;
- browser URL redaction and grant/status projection;
- no terminal output or raw SDK/credential object in descriptors;
- automation atomic persistence, permission snapshot, locking, cancellation, restart, and scheduler fake-clock cases.

### Renderer

- universal switcher ranking, sections, async cancellation, arrow keys, Enter, Escape, focus return, and screen-reader active descendant;
- Resource Hub empty/loading/error/truncated/unavailable states;
- deep links to Files, Changes, Browser, Goal, Agents, Composer, and Terminal;
- browser plus inspector behavior at wide and narrow viewport sizes;
- no auto-send when selecting a skill/prompt/automation;
- stale project/session descriptor shows recovery instead of acting on the new project.

### E2E/manual

- open trusted project → Cmd/Ctrl+K → file → Files preview;
- Browser tab result → native view activates while inspector remains recoverable;
- skill result → invocation inserted but not sent;
- saved automation → new session draft → manual confirmation;
- later Run now → run history/status/cancel/restart;
- permission downgrade invalidates or pauses affected actions;
- packaged Windows/macOS/Linux checks for any native browser/computer additions.

## Done criteria

### Unified-resource MVP

- [ ] Every existing resource class is discoverable from Resource Hub or Cmd/Ctrl+K.
- [ ] A file, changed file, browser tab, Pi Library item, goal/workflow, and terminal can be reached through typed deep links.
- [ ] Browser opening does not unconditionally hide the inspector.
- [ ] Resource queries are bounded, cancellable, project/session-safe, and do not expose privileged content.
- [ ] No generic action RPC or universal permission switch exists.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, and `pnpm build` exit 0.

### Automation increment

- [ ] Users can save, inspect, duplicate, disable, delete, and manually launch a reusable definition.
- [ ] Run history is bounded and records authority/resource provenance.
- [ ] Scheduled runs are honest about app-open lifetime and cannot use Full access.
- [ ] Restart/clock/concurrency/approval tests pass.

### Computer-use increment

- [ ] Only applicable if Phase 7 receives go approval and a separate implementation plan is accepted.

## STOP conditions

Stop and report back if:

- the current Browser working tree would need to be reset, overwritten, or weakened to continue;
- “computer use” turns out to mean only browser use;
- “filesystem” turns out to mean only active-project files;
- a proposed catalog design requires materializing every project file in renderer state;
- an implementation requires generic action IPC, renderer Node/Electron access, or weakening trusted-renderer/path policies;
- a scheduled automation requires Full access, implicit browser/computer grants, raw credentials, or silent approval;
- the current Pi runtime cannot execute non-selected automation sessions without cross-session side effects;
- OS computer input cannot be target-bound, interrupted, and packaged consistently;
- a phase’s verification fails twice after a focused repair;
- the active phase requires unrelated redesign or files outside its declared scope.

## Maintenance notes

- Keep provider contracts versioned and bounded; new resource kinds should not force existing providers or UI sections to load.
- Keep resource descriptors metadata-only. Rich content belongs to Files, Browser, Tools, or the run detail surface.
- Permission summaries are projections, never authority. Domain services remain the source of truth.
- Review any change to browser/computer/automation grants as a security-sensitive change.
- If background-after-quit automation becomes a real requirement, create a separate lifecycle/daemon/update plan rather than extending the in-app timer opportunistically.
