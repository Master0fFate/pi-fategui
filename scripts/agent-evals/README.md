# Offline agent-task evaluations

Two initial **component tasks**, not an end-to-end agent benchmark: message recovery without replay and exact model routing without fallback. Each workspace contains an intentionally defective `solution.mjs` and a `TASK.md` brief. Give the workspace to an agent, then grade its result against the acceptance suite outside that workspace.

```bash
node scripts/agent-evals/run.mjs prepare --case delivery-recovery --workspace ../delivery-eval
# Have an agent repair ../delivery-eval/solution.mjs using its TASK.md.
node scripts/agent-evals/run.mjs grade --case delivery-recovery --workspace ../delivery-eval --out ../delivery-result.json
```

Use `--case explicit-routing` for the second task. Preparation refuses an existing workspace; grading requires a new result filename and never overwrites evidence. Exit status is 0 for acceptance success, 1 for failure/error. The defective seeds should fail.

To compare outcomes, add `--baseline ../previous-result.json`. Baselines must match the case, acceptance suite, and evaluator version/hashes; a previously passing task that now fails is a regression. Results retain candidate/suite/evaluator hashes, Node version, check results, grader duration, termination reason, and bounded diagnostics. Source identity covers `solution.mjs`, not arbitrary imported dependencies.

Optional `--metrics ../metrics.json` attaches **externally reported** total task time and provider cost:

```json
{
  "model": "exact-provider/exact-model-id",
  "source": "runtime usage export for this task",
  "taskWallTimeMs": 42000,
  "costUsd": 0.12
}
```

These fields are input claims, not telemetry collected or authenticated by the grader. Missing provider cost remains `null`, never zero. `gradingWallTimeMs` measures only local acceptance grading, not agent speed. Compare repeated task runs on the same machine/settings before drawing conclusions.

The grader launches Node's test runner in a separate process with an external reporter. Candidate stdout is not interpreted as test success. It terminates the process tree/group after 10 seconds and bounds retained output. This is **not a sandbox or a tamper-proof hostile-code evaluator**: candidate code runs with your account permissions and could modify files, start other processes, or contact a provider. Run only candidate work you authorize on a disposable, least-privilege machine when needed. Escaped descendants, memory exhaustion, and OS termination denial are outside this harness's containment guarantees.

No agent/provider is invoked by these commands. No live model quality, application-flow coverage, reduced spending, or improvement over a baseline is claimed merely because the harness tests pass.

Harness verification is included in `pnpm test` via `scripts/**/*.test.mjs`.
