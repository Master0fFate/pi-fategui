# GoalMax and durable work

GoalMax keeps a longer coding objective visible alongside its completion criteria, tasks, evidence, and next action. It uses the same agent executor as ordinary delegation; it is not a second agent mode.

## Start and guide a goal

Enter `/goalmax` followed by the objective, or use the goal controls in the workspace. Be specific about the behavior to deliver and the checks that would demonstrate success.

The compact goal rail opens the Goal Flight Deck. Use its overview, criteria, evidence, and timeline to inspect progress. The task strip below it shows the current task and expands into the task list. Ordinary tasks and goal-managed criteria remain distinct: marking an ordinary task done is not independent verification.

- **Edit goal** changes the objective, criteria, verification level, or explicit limits.
- **Pause** prevents future automatic continuations; active work can still finish.
- **Resume** re-enables eligible continuations under current permissions and workspace policy.
- **Verify** requests the configured verification flow, including an independent reviewer where required.
- **Cancel / Stop** attempts to stop root and delegated work. Failures are reported rather than disguised as successful cancellation.
- **Clear** removes the current goal from the workspace while retaining its archived record.

GoalMax may continue an active goal automatically when the runtime is ready. Pause or cancel it when you do not want further work.

## Completion is a gate, not a confident sentence

The normal completion tool uses deterministic evidence checks; the separate verification flow can use an independent reviewer. Strict verification adds stronger requirements. Inspect the recorded evidence to understand which checks actually ran.

Pending workflow admission, live child tasks, parent/child joins, queued user work, and changed verification inputs prevent premature completion. A passing result that becomes stale during verification is not accepted as a final completion.

No gate guarantees arbitrary model output is correct. Review important changes before merging or deploying them.

## Queues and recovery

Queued messages retain stable identities and their editable original drafts. You can change their delivery mode, edit them, or cancel them. Steering and saved goal instructions remain visible above the composer.

After uncertain delivery or a restart, unacknowledged drafts reopen for review rather than being automatically resent. Restore or discard them explicitly. This prevents blind replay; it does not make external tool effects exactly-once.

A paused recovered workflow resumes only through an explicit workflow action. Individual interrupted agents use the normal follow-up lifecycle. See [Agent orchestration](agent-orchestration.md).

## Limits and failure behavior

- Goal token/time budgets constrain admission of automatic continuation. They are not hard mid-turn spending caps, and elapsed time includes paused/offline wall time.
- Workflow runtime, idle, and resource thresholds are advisory telemetry. They do not secretly abort an agent or select a replacement model.
- A provider may not stop immediately when interrupted. Fate retains failed-to-stop execution and its writer lease until actual settlement instead of admitting a competing writer.
- If a goal pause/cancel cannot be persisted, cancellation is still attempted and the running application inhibits further automatic goal execution. The error remains visible; resolve storage issues before relying on a saved control state.
- Local atomic writes protect ordinary process-crash recovery, not every filesystem or power-loss failure. Separate application instances do not provide a global execution lock.

For workspace isolation and authority, see [Architecture and security](architecture.md) and [Agent orchestration](agent-orchestration.md).
