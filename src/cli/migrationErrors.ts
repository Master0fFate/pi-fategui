const messages = {
  blocked: 'Migration preflight was blocked. Review the summary, stop all relevant writers and correct the reported category before preparing a new plan.',
  plan: 'Migration plan is unavailable, unsafe, changed, from a different host/profile, or incompatible with this native format. No replacement plan was inferred.',
  operation: 'Migration did not complete. Retain the plan, backup, staging and any ownership records for review. Never remove an uncertain lock or fall back to another runtime.',
} as const;
/** No path, source content, credential or upstream error is printed at the CLI boundary. */
export class MigrationOperatorError extends Error {
  constructor(readonly code: keyof typeof messages, options?: ErrorOptions) { super(messages[code], options); }
  get operatorMessage(): string { return messages[this.code]; }
}
