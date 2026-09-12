# Memory Learning internals

## Grounding and decisions

The implementation originated at commit `32d9dd2b4e2ac720b7ccce63c77140b6a6486146` with Pi SDK / Pi AI `0.85.1`. This document describes its boundaries and internal integration; current release verification is defined in [Development and release](development.md).

The master switch defaults off. Settings has independent **GLOBAL / PROJECT** layer toggles: GLOBAL holds one reviewed user profile, while PROJECT holds a briefing and reusable notes/procedures. Automatic mode can attach both cores; their stores are not copied or merged. This is reviewed context memory, not a psychological diagnosis or model training.

The integration uses the supported public SDK interfaces and preserves the application's existing runtime, queue, and provider boundaries. See [Pi SDK compatibility](sdk-compatibility.md) for the current upstream check.

## Integration map

- `src/shared/contracts/learning.ts`: strict schemas, limits, binding/turn references, store records, generation contract, Settings schema and narrow API types.
- `src/main/learning/LearningRepository.ts`: namespace identity, bounded validated handles, schema/integrity checks, per-store queue, cross-process writer lock, disk revision/epoch checks, durable atomic replacement and explicit recovery.
- `LearningEvidence.ts`: exact current/saved-session branch reconstruction through `parseSessionEntries` and `SessionManager.inMemory`, cycle/parent validation, visible-text-only extraction, confined selected files, Git identity observations and preview redaction. It never calls writable `SessionManager.open` or the summary-oriented session-reference adapter.
- `LearningGenerator.ts`: versioned prompt and `ModelRuntime.completeSimple(model, context, { maxTokens, maxRetries: 0, timeoutMs, signal })`. Credentials stay in ModelRuntime. No tools, coding session, research agent, fallback model or repair pass is created.
- `LearningService.ts`: project/session/generation-bound captures, exact approval transactions, lifecycle controls, separate generation usage, selection, dispatch manifests and small changed events.
- `LearningSelection.ts`: deterministic relevance, hard eligibility filters, evidence freshness, stable ordering, whole-item byte budgets and JSON advisory rendering.
- `LearningContext.ts`: root-only ephemeral context adapter using the installed public `Agent.streamFunction` signature, which permits an async stream factory. It preserves the existing stream function and never rewrites historical messages, system prompts or signed reasoning.
- `PiRuntimeService.learningOrigin`, `learningProvider`, `prompt`, `installModelBoundary`, `invalidateSession`, `handleSessionEvent`: binding, configured model access, queued revision references, awaited user-message boundary, model routing, dispatch, recovery and disposal. Existing `agent.subscribe` listeners are awaited by the installed SDK. The learning wrapper composes with the existing staged-model wrapper, which still removes the previous provider's API key when changing models.
- `MultiProjectPiRuntime.createService`: injects the shared main-process service into each project runtime. IPC captures the concrete origin before awaiting; completion does not resolve through whichever project is focused later.
- `registerLearningIpc.ts`, `registerIpc.ts`, `src/preload/learningApi.ts`: named guarded IPC, strict request/response/event validation. Events broadcast identity/revision only. The renderer cannot submit an arbitrary source root or obtain credentials.
- `SettingsDialog.tsx`, `features/learning/*`, composer and message actions: master toggle, explicit scope, three views, source preview, manual/provider drafts, frozen review token, lifecycle, managed Markdown procedures, next-turn pins, removal and actual-use records. Radix dialogs provide focus management and keyboard dismissal.

Queue transport remains learning-free. Immediate turns use the app run UUID; queued turns use the existing queue UUID. The SDK's awaited user-message event identifies the root request, and the stream adapter validates under store ownership before returning the augmented context to the configured runtime. An explicit stale selection stops dispatch and leaves the draft in the existing recovered queue. Restore it, review/change the selection, or clear learning and resend. Automatic unavailable items do not block the coding request.

Provider retries and the same logical turn's tool/length continuations reuse a single prepared block and manifest. `agent_settled` clears the active adapter context before later child-triggered work. Compaction-held prompts retain references and validate when released; restart/fork/replacement do not replay historical messages. Queued recovery preserves pinned references, including stale ones that the user must deliberately refresh or clear.

## Delivered phases

Contracts/persistence, manual note approval/reuse, evidence/model drafting, revision/lifecycle controls, deterministic automatic selection, managed procedures, offline evaluation fixtures and documentation are implemented. Production uses the real Pi AI provider adapter; deterministic providers/runtimes exist only in tests. No agent-facing approval/enable/delete tool was added.

## Deliberate limits and handoff deviations

- GLOBAL is a user coding profile, not a dump of every project lesson. Automatic attachment layers the approved profile with the current project's briefing/notes. Legacy GLOBAL notes are not auto-attached until converted. Profile file evidence is provenance only and does not stale the profile when another project's file changes. Progress briefings expire after seven days. Fate UI does not infer personality, sensitive traits, or unspoken motives.
- The supported `streamFunction` boundary was chosen instead of prompt concatenation or an extension hook: queued text must not cache unchecked learning and signed history must remain untouched. Managed memory is ephemeral provider context, not a persisted historical custom message or native Pi skill.
- Extension/slash commands do not receive explicit learning; their immediate handling and arbitrary transformations do not provide a reliable app-owned user-dispatch identity. Use a plain user turn. Manual pins on a slash command are rejected rather than silently dropped.
- Source selection lists up to 100 visible durable entries in the open session. Select a saved session first; missing durable IDs use labelled manual text. No arbitrary saved-session file path is accepted from the renderer.
- File evidence uses whole-file hashes with a 1 MiB cap and at most 18 unique freshness reads for a selection. Freshness is dependency-based, not commit-wide. Symbol hints are lexical relevance hints, not semantic AST anchors. Preferences without file evidence remain explicitly user-asserted.
- No compatible exact tokenizer was established. The complete 6 KiB byte limit is enforced; reported tokens are an estimate, not a claim that the 1,500-token exact budget was measured.
- Test/command exit status and code-state association are not inferred from generic tool output. Unsupported observations remain unknown.
- State responses use the bounded snapshot (maximum 8 MiB), not detail pagination. This is a conservative first-release cap, but very full stores may need paginated detail fetching in a later performance pass.
- The store permits 100 **total retained** drafts, stricter than 100 pending drafts. Users can delete approved/rejected draft records without deleting immutable lesson revisions.
- Manifest expiry happens on the next store mutation; offline bytes are not promised to disappear exactly at the 30-day boundary. Captures are ephemeral, lazily expired, and never written unredacted.
- POSIX directory fsync is used; Windows uses file flush plus same-directory replacement. Incomplete locks and uncertain PID ownership require manual recovery. Only positively dead owners can be recovered in-app; age never authorizes takeover. Unknown schema versions are unavailable, not automatically downgraded.
- Failed delivery can leave a prepared manifest; the UI explicitly labels interrupted delivery uncertain. No automatic resend occurs. A delayed billing record can be dropped after deletion or a revision conflict instead of recreating data.
- Optional Markdown/native skill export is not implemented. Managed procedures already work through the learning context adapter, and no skill file or command is installed/executed.

## Implementation verification record

The original implementation's `pnpm verify` run passed: `pnpm typecheck`, **175 test files / 1,843 passing tests**, production main/preload/renderer builds and **10 Electron E2E tests**, including the new learning flow. Two tests were skipped: an existing test and the new file-symlink test because this Windows account lacks symlink creation privilege. The directory-junction and file-replacement-race checks ran and passed. `git diff --check` also passed.

Tests cover restart persistence; stale/cross-window transactions; independent writer locks and explicit dead-writer recovery; corrupt/oversized/newer/wrong-identity stores; interrupted replacement; safe file targets; exact source branches and unchanged session bytes; redaction; provider output authority rejection; no_lesson; no-provider manual drafts; deletion during generation; revision history; evidence removal; explicit conflicts; manual/automatic selection; byte/whole-procedure budgets; Unicode/false matches; root runtime immediate/queued boundaries; optional failure; signed-history preservation; continuation/fork non-replay; and Settings toggle/scope behavior.

Renderer tests preserve the old approval token through a second-window state refresh. The Electron test uses the production learning service with the test-only runtime and exercises Settings, manual review with keyboard approval, another session, next-turn use and actual manifests. Separate runtime tests use the real `PiRuntimeService` around its existing deterministic SDK adapter. These tests do not prove a remote provider received anything or followed a lesson.

Screenshots are generated at `test-results/memory-learning-settings.png` and `test-results/memory-learning-recent-use.png`. The final 100-note synthetic warm-ranking check measured **4.34 ms p95** over 50 measured runs after ten warm-ups on Windows x64 / AMD Ryzen 9 5900X (Node 22.22.2). It excludes file I/O/provider latency and is not a whole-dispatch benchmark or a model-quality measurement.

No live provider smoke, paid evaluation, other-OS packaging, or real held-out benefit study was performed. Live benefit remains **unmeasured**. A comprehensive cross-platform crash/hostile-filesystem stress campaign and full-store UI profiling remain follow-up verification, not claims made by the unit suite.

## Release note

Added opt-in Memory Learning with an off-by-default master switch, explicit GLOBAL/PROJECT stores, reviewed notes/procedures, manual and separately enabled automatic selection, and observable dispatch records. No model-training or coding-quality improvement claim is made.

## Offline evaluation workflow

Two new synthetic cases (`learning-process-boundary`, `learning-scope-isolation`) extend the existing external grader. They check actual bridge behavior, structural imports and eligibility rather than whether an agent repeats a lesson. Defective seeds must fail; deterministic corrected fixtures prove the harness can accept valid output. These are harness fixtures, not a representative set of real project corrections.

Before a benefit study, collect 10–20 authorized real corrections across at least two projects, freeze the lessons and baseline notes, create related held-out tasks, and predeclare success criteria and a total provider-cost ceiling. Compare A (normal context), B (manual notes) and C (managed learning), holding model, permissions, code state, task and stopping rules fixed. Use fresh sessions, repeated trials, randomized condition order and comparable additional-context budgets. Do not let a condition learn during the batch.

Prepare/grade with `scripts/agent-evals/run.mjs`. Record provenance, context hashes, condition/repeat, exact model/settings, attached revisions, independent acceptance and nullable metrics with `learning-report.mjs`. No command in this workflow invokes a provider. Human time and cost must be actually measured or left null. The grader is not a sandbox, candidate output is not evidence of acceptance, and live spending requires separate authorization.
