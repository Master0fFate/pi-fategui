export class WorkflowReviewOperatorError extends Error {
  constructor(options?: ErrorOptions) { super('Native workflow review did not complete. Retain every original database, sidecar, review file and uncertain ownership record. Opaque or malformed history is diagnosis-only; no task was resumed.', options); }
  get operatorMessage(): string { return 'Native workflow review did not complete. Retain every original database, sidecar, review file and uncertain ownership record. Opaque or malformed history is diagnosis-only; no task was resumed.'; }
}
