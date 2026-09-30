import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'INVALID_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'UNKNOWN_WORKSPACE', 'STALE_WORKSPACE',
  'STALE_SESSION', 'CONTROL_REQUIRED', 'PERMISSION_REQUIRED', 'UNSUPPORTED_CAPABILITY',
  'PROTOCOL_MISMATCH', 'SERVER_RESTARTED', 'RESULT_TOO_LARGE', 'BUSY', 'STORAGE_UNAVAILABLE',
  'REQUEST_CONFLICT', 'OUTCOME_UNKNOWN', 'INTERRUPT_FAILED', 'SNAPSHOT_NOT_READY',
  'RESYNC_REQUIRED', 'CLOCK_SKEW', 'INTERNAL_ERROR', 'DISPATCH_DISABLED',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
const recoverySchema = z.enum(['fix-request', 'authenticate', 'refresh', 'request-access', 'reconcile', 'wait', 'check-clock', 'contact-host']);
const errors = {
  INVALID_REQUEST: ['The request is invalid.', 'fix-request'],
  UNAUTHENTICATED: ['Authentication is required.', 'authenticate'],
  FORBIDDEN: ['Access is denied.', 'request-access'],
  UNKNOWN_WORKSPACE: ['The workspace is unavailable.', 'refresh'],
  STALE_WORKSPACE: ['The workspace has changed.', 'refresh'],
  STALE_SESSION: ['The session selection has changed.', 'refresh'],
  CONTROL_REQUIRED: ['Current workspace control is required.', 'request-access'],
  PERMISSION_REQUIRED: ['The operation is not permitted.', 'request-access'],
  UNSUPPORTED_CAPABILITY: ['The capability is unavailable.', 'refresh'],
  PROTOCOL_MISMATCH: ['The protocol version is unsupported.', 'refresh'],
  SERVER_RESTARTED: ['The server epoch has changed.', 'reconcile'],
  RESULT_TOO_LARGE: ['The result exceeds the protocol limit.', 'reconcile'],
  BUSY: ['Admission is unavailable.', 'wait'],
  STORAGE_UNAVAILABLE: ['Safe command admission is unavailable.', 'contact-host'],
  REQUEST_CONFLICT: ['The request identity conflicts with an earlier action.', 'reconcile'],
  OUTCOME_UNKNOWN: ['The operation outcome is unknown.', 'reconcile'],
  INTERRUPT_FAILED: ['The operation could not be confirmed stopped.', 'reconcile'],
  SNAPSHOT_NOT_READY: ['The requested view is not ready.', 'wait'],
  RESYNC_REQUIRED: ['The view must be refreshed.', 'refresh'],
  CLOCK_SKEW: ['The request time is outside the allowed window.', 'check-clock'],
  INTERNAL_ERROR: ['The operation could not be completed safely.', 'reconcile'],
  DISPATCH_DISABLED: ['Network dispatch is disabled in this preparation.', 'contact-host'],
} as const satisfies Record<ErrorCode, readonly [string, z.infer<typeof recoverySchema>]>;

export function safeError(code: ErrorCode) {
  // Also guard untyped host code; a malformed thrown fault must not break error serialization.
  const parsed = errorCodeSchema.safeParse(code);
  const safeCode = parsed.success ? parsed.data : 'INTERNAL_ERROR';
  const [message, recovery] = errors[safeCode];
  return { code: safeCode, message, recovery };
}

export const safeErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string().max(120),
  recovery: recoverySchema,
}).strict().refine((error) => {
  const fixed = safeError(error.code);
  return error.message === fixed.message && error.recovery === fixed.recovery;
});

/** Internal control flow only. Never serialize an exception or use its message as a wire message. */
export class ProtocolFault extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = 'ProtocolFault';
  }
}
