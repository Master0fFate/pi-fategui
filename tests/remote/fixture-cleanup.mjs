/** Cleanup orchestration only; no SSH/host substitutes. Every cleanup step is
 * attempted even after another step fails. Any cleanup uncertainty fails the
 * case, so a workflow-complete/exit-0 record cannot hide leaked ownership. */
export async function withFixtureCleanup(work, steps, onFailure = async () => {}) {
  let result; const failures = [];
  try { result = await work(); } catch (error) { failures.push(error); }
  for (const step of steps) {
    try { await step.run(); }
    catch (error) {
      failures.push(new Error(`Cleanup ${step.name} failed: ${String(error)}`, { cause: error }));
      try { await onFailure(step.name, error); }
      catch (logError) { failures.push(new Error(`Cleanup failure evidence unavailable: ${String(logError)}`, { cause: logError })); }
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => String(error)).join('; '));
  return result;
}
