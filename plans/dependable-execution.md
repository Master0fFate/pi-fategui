# Dependable execution: five-principles validation

## Objective and constraints

Owner: the requesting maintainer. Reduce lost instructions, duplicate work, unsupported delegations, and supervision. Measure delivery/recovery failures, task acceptance success, regressions, elapsed time, and provider cost separately. Preserve project trust, explicit models, permission ceilings, existing edits, and reversibility. No paid evaluations, deployment, destructive integration, or unattended execution is authorized by this change.

## Current system map

- Ordinary prompts and GoalMax user input enter `PiRuntimeService.prompt`; Pi owns the live message queue. GoalMax owns durable goals, continuation reservations, and evidence gates.
- Agent Teams own persistent task/envelope snapshots, operation receipts, retained child sessions, and a project-wide writer lease. An SDK handoff is not necessarily a message recorded in a session.
- Model-pinned agent profiles and exact authenticated model selectors already exist. Spawn preflight owns capability checks.
- The automation repository stores definitions and launch metadata. It is not a durable workflow execution service.
- Existing unit/Electron tests demonstrate runtime/UI contracts, not comparative live-provider task quality.

## 1. Challenge requirements

| Requirement | Decision | Testable rewrite |
| --- | --- | --- |
| One shared execution system | Keep outcome, narrow mechanism | Share delivery invariants; do not replace distinct SDK, goal, and team state machines with a speculative universal scheduler. |
| No duplicate execution after restart | Rewrite | Never automatically replay a dispatch with uncertain outcome. Exactly-once external effects require tool-level idempotency, not a UI status. |
| Evidence-backed Done | Keep | Separate process settlement, model claims, executed checks, and independently verified acceptance. Missing evidence stays visible. |
| Terra/Astra routing | Keep configurable preference | Reuse model-pinned profiles. Human nicknames are not authenticated provider/model IDs. Explicit choices must fail visibly rather than fall back. |
| Parallel implementation worktrees | Keep, gate | Require immutable base/branch identity, conflict review, dirty-file protection, ownership and crash-safe cleanup before relaxing writer limits. Worktrees are not sandboxes. |
| Run now and schedules | Split | First a scoped, cancellable, durable manual workflow. Scheduling requires proven recovery and approval handling. |

## 2. Delete before optimizing

- Delete the false equivalence between SDK acceptance and recorded delivery. Introduce a dispatching receipt and acknowledge only the recipient session message.
- Do not add a second model/profile catalog or another completion dashboard.
- Do not add automatic retries for uncertain messages, cron, silent model fallbacks, or permission escalation.
- Keep the shared-directory single-writer lease until managed worktrees and integration checks exist. Removing a safety control is not simplification.

## 3. Simplify the surviving path

### Implemented slice (verification below)

- Root and GoalMax queued/compaction-held drafts use one bounded atomic outbox, scoped to canonical project, session, and application instance slot. Persistence precedes SDK queue admission.
- Queue consumption removes the matching stable identity; merely shrinking SDK queue counts is not acknowledgement. Unacknowledged snapshots reopen as recovered drafts, never executable tasks.
- Recovery copies the draft and validated original model/reasoning into the composer. The saved copy remains until explicit discard, avoiding loss during a session switch or renderer failure. Attachments remain local. Expanded transport context is not stored as draft text.
- Stop fences admissions already awaiting persistence, clears pending SDK/held queues, and persists cancellation. Compaction release is single-flight and generation-bound.
- Team envelope delivery records dispatching before handoff. Only the recipient's recorded custom message acknowledges delivery. Interrupted unacknowledged dispatches become failed/uncertain, not replay candidates.
- Spawn preflight rejects malformed explicit models, unsupported tools/permissions/reasoning, profile-denied tools, and model-incompatible explicit thinking. Existing exact/profile selection remains the routing mechanism.

### Not yet implemented

This is a foundation milestone, not completion of the five-feature roadmap. Root direct-turn receipts, a unified run-history/evidence bundle, full cross-process execution ownership, independent tool-effect idempotency, role-to-profile settings, budget-enforced fallback approvals, managed worktrees/integration, durable automation Run now, and scheduling remain open.

## 4. Accelerate feedback, not unsafe execution

Add offline component-task evaluations for delivery recovery and exact model routing. Each has a fixed brief, defective seed, external acceptance checks, bounded grader runtime/output, retained JSON, and same-case/version success-regression comparison. Grade duration is measured; total task time and provider cost are optional externally reported metrics. These fixtures are an initial evaluation harness, not live-provider or whole-application quality evidence.

## 5. Automate only behind acceptance gates

- [ ] Complete direct-turn/task lifecycle receipts and crash-injection tests, including cross-instance ownership. Gate: no silent loss/replay at every dispatch/ack/cancel boundary.
- [ ] Build an evidence bundle on existing GoalMax/task/provenance data. Gate: changed-file attribution, observed checks, application-flow evidence, stale evidence, and limitations are distinguishable; Done never implies unrun checks passed.
- [ ] Add opt-in live representative task evaluations. Gate: explicit cost authorization, fixed tasks/repetitions, provider/model identity, recorded runtime cost/time, and outcome/regression comparison. Do not claim quality gains from deterministic fixtures.
- [ ] Add role-to-profile preferences and explain routing decisions. Gate: exact choices survive; unavailable/budget-exceeding fallbacks stop for approval; permission/tool ceilings hold.
- [ ] Add managed worktrees with reviewable manifests. Gate: capture base HEAD and existing user edits; check conflicts without modifying the primary checkout; explicit integration; failed cleanup retains recoverable metadata. Only then broaden writer concurrency.
- [ ] Add manual automation runs on the proven execution boundary. Gate: immutable scope/model/permissions/budget, idempotent admission, retained outcomes, cancellation, restart reconciliation, and no interactive-session permission mutation.
- [ ] Add schedules only after manual run recovery is demonstrated. Gate: unattended approval requests pause, never grant themselves authority.

## Risks, rollback, and verification

Outbox snapshots are local plaintext, like existing sessions; they contain user drafts/attachments but not expanded transport context. Successful consumption/discard/deletion removes those drafts from the outbox. File sync plus atomic replacement protects ordinary process crashes, not every power-loss/filesystem failure. Corrupt snapshots fail visibly rather than being treated as empty. Application instances have separate outboxes; this is not an interprocess session execution lock.

Team snapshots still use existing Pi custom-entry persistence; this change does not claim transactional fsync across the SDK transcript and envelope snapshot. Observed delivery is not proof the model acted on the message. Work whose acknowledgement was lost requires transcript review.

Rollback: revert this branch's scoped changes while retaining pre-existing GoalMax edits. Preserve outbox files for manual recovery before returning to a version that cannot display them. Do not delete session/worktree data as part of rollback.

Verified on Windows with Node 22.22.2 and pnpm 11.17.0: `pnpm verify` passed (TypeScript, 166 Vitest files / 1,744 tests passed and one existing skip, production build, seven Electron E2E tests). `git diff --check` passed; the Composer design detector reported no findings. Independent read-only reviews identified admission cancellation, recovery-draft handoff, compaction reentrancy, and evaluator false-pass issues; regression tests cover the repairs. No live-provider, other-OS, packaging, or power-loss checks were performed. Unchecked roadmap gates above must not be marked complete based on this test run.

## Next three actions

1. Complete direct-turn durable receipts and cross-instance ownership before claiming shared recovery is finished.
2. Wire concise evidence bundles and run authorized representative provider evaluations.
3. Productize routing, then worktree integration, then manual workflow execution; schedule last.

Decision: **Pragmatic Partial** — the reduction and recovery slice is concrete; downstream autonomy stays gated rather than pretending prerequisites are solved.
