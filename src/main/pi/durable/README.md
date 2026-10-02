# Native Pi execution boundary

Pinned upstream: `@earendil-works/pi-{ai,coding-agent,durable}` and Chord 1.0.0;
source reference `a13d35a` (exact 1.0.0). No experimental coding-agent source imports.

## Status and actual ownership

This is an implemented, synthetic-tested **native execution factory**, not a full
replacement of `PiRuntimeService` or a claim that all M5/M6 product behavior is done.
The existing renderer/IPC service remains SDK-backed until its session-type branch
and native event projection are composed and verified. Do not expose a UI switch
that silently removes the remaining capabilities below.

`openComposedPiExecution` makes a discriminated choice:

- `legacy-sdk`: invokes exactly the existing SDK runtime factory and retains its
  real SDK object and JSONL history
- `native-durable`: opens exactly one `NativeDurableExecution` / upstream Harness
  using `OwnedDurableStorage` (WAL, synchronous FULL, exclusive profile owner)
- Neither branch falls back to the other after a failure. Existing session JSONL
  files are not imported, rewritten, renamed, or deleted by this adapter

Native Pi owns generation, tool validation/execution scheduling, task ownership,
child conversation identity, inbox placement, request-ID deduplication, abort/join,
usage receipts, structural history, events, and compaction. There is no Fate mirror
of native task/submission state and no custom provider/agent loop here.

Fate owns profile isolation, authority, confined tools, provider configuration,
resource/skill selection, extension UI, worktree capabilities, evidence policy,
external process containment, IPC schema, and renderer projection. `Models` is the
existing `ModelRuntime`, so provider auth and credential refresh remain native SDK
behavior. Production callers must use the owned factory, never `MemoryStorage`.

## Unknown outcome contract

The session-scoped native document `fate.execution.fence` is policy evidence, not an
execution scheduler. Host submissions persist `active` before native admission;
quiescent native receipts permit `idle`. A thrown/aborted effectful tool or any uncertain
storage commit closes the in-memory gate immediately. Unknown tool evidence is
persisted as `UNKNOWN`; a failed evidence write leaves the earlier durable active
fence in place. No generation/compaction provider call, tool invocation, submit,
wait/abort operation that could resume scheduling, or new admission passes a
closed gate. Fence-aware waits reject even when a failed native storage line
cannot settle the task: rejection does not fabricate a terminal task receipt.

Before **Harness.open**, the owned storage is scanned for active fences,
nonterminal tasks, and unsettled submissions. These are persistently quarantined
as UNKNOWN, even if upstream marked a tool replay-safe. The existing task/history
records are not rewritten. Historical UNKNOWN never becomes success or idle. The
only next step is human evidence review and an explicitly requested **new** native
session/new request; there is no automatic retry, resume, migration, or recovery
button in this adapter. Conservative ambiguity can include an interrupted model
request or admission, even when no external effect can later be proven.

Bootstrap performs its fence write directly through the owned Storage before the
Harness exists. The Harness is the sole mutation owner thereafter. No concurrent
kernel is opened over the same storage.

## Tool and child contract

`bridgeFateTool` calls the original confined SDK ToolDefinition with the host's
real context factory, live permission closures, abort signal, and update callback.
Text/images, JSON evidence, structured content and usage are retained. SDK details
are under `details.fate.details`; structured content is under
`details.fate.structuredContent`. Progress is replacement-content evidence under
`details.fate`, because treating replacement text as append-only output duplicates
it. A native-to-Fate event projector must unwrap that envelope. No fake SDK
AgentSession or ExtensionToolContext is constructed. Unsupported JSON evidence is
rejected instead of silently stringified/dropped.

The native child tool creates a task-owned native conversation and uses its native
submission/wait. A host policy must provide explicit tools and the complete trusted
child prompt. Children do not receive the root's resolved resource prompt. Different
worktree checkout paths are currently rejected: root confined tools capture their
checkout and changing `agent.cwd` cannot rebind them. Same-checkout delegation with
an explicit narrower tool allowlist is tested. Existing Agent Team worktrees must
remain on the legacy path until per-child capability rebinding is implemented and
verified. Native child ownership is not a filesystem sandbox.

Native tools are sequential and unsafe-replay by policy. Trusted host code can
explicitly declare an entire bound tool/context `knownNoEffectFailures`, or throw
`NativeEffectNotStartedError` strictly before entering an effect. Those ordinary
known failures do not poison the session. Tool names, replay flags and annotations
never grant this classification; storage/ownership uncertainty always wins. Model-facing constrained
sampling and argument preparation are preserved. SDK dynamic loadout/codemode and
non-direct exposure are rejected. SDK `terminate` maps to native `control.terminate`: exact 1.0.0 uses
all-call termination in both runtimes. Mixed/terminating batches are tested.

## PiRuntimeService method map and exact retirement boundary

Methods are grouped exhaustively by public service responsibility; private helpers
follow the same owner. `SubagentWorkflowEngine` is in `SubagentWorkflow.ts`, not a
separate `SubagentWorkflowEngine.ts` file.

| Existing service methods / responsibility | Native disposition |
| --- | --- |
| prompt, sendSessionMessage | Native submit/input + whenBusy steer/followUp + required requestId; host must keep image validation, prompt commands, browser references, resource expansion and permission admission before submit |
| mutateQueuedMessage | Native queued submission withdrawal works; edit/reorder/resend needs a renderer contract for withdraw-plus-explicit-new-request; no old queue replay against a native session |
| abort, compact | Implemented native conversation abort and compaction with fence-aware waits; adapter compaction receipt is native, not a fake runtime state |
| setModel, setThinkingLevel | Native configure; host retains model-disabled checks, catalog validation, pending-setting UI and thinking clamping |
| setPermissionLevel, agentAuthority, setExecutionAdmissionGuard | Fate policy persists/revokes first; host rebuilds/selects allowed native tools. Original live tool closures remain enforced. No native authority override |
| getState, getHydrationState, captureSnapshotView, flushSnapshotEvents | Native entries/events/usage/inspect implemented; complete Fate RuntimeState/PiEvent projector not wired |
| setEventSink, setScopedPiSink, setSessionSettledListener, setSelectionListener, subscribeSelection, setGoalEventSink, setTaskEventSink | Host projection/subscription infrastructure; native event stream is available but IPC adapter remains |
| openProject, closeProject, setProjectPreview, newSession, switchSession, openAgentSavedSession, listSessions, listSessionsForPath | Host session catalog must discriminate native IDs vs legacy JSONL. New/resume native owned factory implemented; no transparent conversion |
| renameSession, deleteSession, deleteSessionsForPath | Host catalog/retention policy; native history has no implemented destructive UI path; never call legacy JSONL deletion for native IDs |
| forkSession, forkPrompt, navigateSessionBranch, deleteSessionBranch, cloneSession, importSession | Native public fork exists upstream but not equivalent to SDK branch mutation/import; remain explicit legacy-only until reviewed projection/import/export is implemented |
| answerQuestion | Host QuestionnaireCoordinator + actual ExtensionToolContext UI binding required; not silently replaced |
| optimizePrompt | Existing shared ModelRuntime can remain; advanced read-only SDK child path stays until its separate capability binding is native |
| initializeProviderLogin, startProviderLogin, respondProviderLogin, cancelProviderLogin, hasProviderLoginOwnership, logoutProvider | Keep existing native SDK ModelRuntime auth host; no new credential store or OAuth loop |
| setModelCatalogListener, synchronizeModelCatalog, listModelsDevProviders, getModelsDevProvider, addModelsDevProvider, removeModelsDevProvider, refreshManagedModelsDevProviders, setDisabledModelsSource | Keep provider/catalog policy and shared ModelRuntime; independent of execution backend |
| agentResources, agentModelRuntime, setLearningService, learningOrigin, learningProvider | Host resource/context/model services retained; trusted resolved prompt fed into native factory |
| getGoalMax, createGoalMax, controlGoalMax, updateGoalMax, clearGoalMax, editGoalMaxSteering, removeGoalMaxSteering | Product-specific GoalMax policy remains; its generic scheduling can become native task definitions, but has not been ported here |
| getTaskList, createTask, updateTask, reorderTasks, deleteTask, clearTasks | Product task-list semantics remain distinct from native execution Task records; core durable-state adapter owns storage, not this Harness |
| controlSubagent, controlAgentTeam, createAgentForegroundExecution, setAgentWorkspacePolicySource | Native task-owned foreground child slice implemented. Full team mailbox/follow-up/caller IDs/worktree ownership/budgets need a policy-preserving adapter; no dual scheduler |
| setMonitorRunsSource, getMonitorDashboard, hasEvictionBlockingWork | Host dashboard must project native inspect/task graph + Fate external process state; full cross-backend monitor integration remains |
| beginHostShutdown, dispose | Seal host admission then close native Harness/storage; active durable fence survives shutdown and is not interpreted as successful cancellation |

For a native slot, retire/bypass `RuntimeSlot.queuedMessages` replay,
`persistQueue`/`reconcileQueuedMessagesForSlot`, SDK AgentSession prompt/retry/turn
loops, `SubagentCoordinator` child execution promises, and
`SubagentWorkflowEngine` scheduling once the equivalent workflow definition is
ported. Keep these only for the explicitly selected legacy slot. Do not maintain
both a Fate workflow state machine and a native task machine for the same run.

## SDK extension gap, specifically

Public native hooks cover generation before-request/after-response/on-yield,
tool before/after execution, prompt sections, and compaction decisions. They offer
native document/task IDs, not the full SDK ExtensionContext. A policy-specific
adapter can map hooks that need only those surfaces. The general SDK runner also
expects AgentSession lifecycle, UI dialogs, session manager branches,
commands, resource reload, nested executeTool/codemode, and custom messages.
Blindly casting the two contexts is incorrect. `requiredSdkFeatures` currently
rejects those requirements before opening the Harness. Full arbitrary SDK
extension compatibility has not been implemented or claimed.

## Verification

Run `node scripts/run-v2-tests.mjs tests/v2/nativeDurable*.test.ts` and
`pnpm typecheck`. Tests use the real installed 1.0.0 Harness and faux provider;
production-owned tests use actual SQLite. No credentials, paid providers, service
installations, executable builds, publication, or deployment are needed.
