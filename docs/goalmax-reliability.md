# GoalMax reliability pass

## Reference and scope

Compared against public Codex commit [`553df1c691fe8bf7747e50da22f1342984495ae0`](https://github.com/openai/codex/tree/553df1c691fe8bf7747e50da22f1342984495ae0/codex-rs/ext/goal), retrieved September 8, 2026. This establishes public engine/CLI semantics, not proprietary Desktop UI parity.

Codex separates durable goals and idle-only internal continuations from ordinary user input. Its [pending-input UI](https://github.com/openai/codex/blob/553df1c691fe8bf7747e50da22f1342984495ae0/codex-rs/tui/src/bottom_pane/pending_input_preview.rs) distinguishes steering and queued follow-ups. Its [completion prompt](https://github.com/openai/codex/blob/553df1c691fe8bf7747e50da22f1342984495ae0/codex-rs/ext/goal/templates/goals/continuation.md) requires evidence-based self-audit; it does not establish mandatory independent verification for every goal.

## Five-principles decisions

1. **Challenge requirements.** A goal must not take ownership of every chat message. A task list need not require a goal. A terminal status must not substitute for completed, evidence-backed work.
2. **Delete the redundant path.** Ordinary GoalMax messages no longer bypass the session queue, force hidden steering, reject attachments, or become permanent pending-looking rows. Existing saved goal instructions remain available in a collapsed disclosure; they are not delivery receipts.
3. **Simplify.** Root sessions share `list_tasks`, `create_task`, `update_task`, and `delete_task`. GoalMax continues to own its managed criteria and verification. Both the goal status rail and task strip use a single 32px row, 24px in Compact mode; task details expand. The goal title opens the Flight Deck, replacing its duplicate info button; phase and repeated counts move to the tooltip. The goal marker belongs beside the Main agent title, not in an extra implicit grid cell.
4. **Improve reliability before speed.** User input fences completion and takes priority over scheduled continuation. Stale dispatch reservations recover by attempt identity. Required criteria must be satisfied and have current evidence. Independent review results are invalidated by new user input, changed task scope, or a changed workspace. Failed evidence writes retain their buffer for retry.
5. **Automate regression checks.** Tests cover normal queue editing/cancellation/conversion with GoalMax, attachments, compaction holds, budget preservation, continuation races, late-input completion rejection, recovery, and ordinary-session task tools. Electron checks measure 280px/420px agent headers and normal/compact task-strip heights.

## Persistence contract

The canonical snapshot replacement is the commit point. Audit-journal failure is logged without falsely rejecting the committed revision. Oversized snapshots are rejected before replacement. Corrupt snapshots and missing/tampered referenced briefs produce restoration errors rather than masquerading as absent goals. Archiving copies briefs before removing the current snapshot so an interrupted archive does not strand the active goal without its source.

## Verification and limits

`pnpm verify` passed: TypeScript, 164 Vitest files (1,690 tests passed; one existing test skipped), the production build, and seven Electron E2E tests. Terra independently reviewed the runtime changes and verified the corrected SDK lifecycle regressions. Visual captures are generated under `test-results/pi-desktop-goalmax-agents-{normal,compact}.png`. The design detector's changed-line advisories concern density values already documented in `design/COMPACT.md`; unrelated global stylesheet findings were not changed.

These checks use deterministic adapters and local persistence, not paid live-provider runs. GoalMax's normal completion tool uses a deterministic evidence gate; the separate verification flow uses an independent reviewer. Neither is a guarantee of arbitrary model output quality. Token/time budgets remain admission limits for automatic continuation, not hard mid-turn spending caps; elapsed time includes paused/offline wall time. The later v0.9.8-beta1 recovery work adds a durable outbox for queued and compaction-held drafts shared by ordinary sessions and GoalMax. Unacknowledged messages reopen for review and are not resent automatically. This does not resume interrupted tool calls or provide exactly-once external effects; see [the execution plan and remaining limits](../plans/dependable-execution.md).
