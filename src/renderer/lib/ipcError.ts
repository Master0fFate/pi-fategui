/**
 * Main-process IPC rejections arrive as Error objects whose message is a
 * JSON-serialized AppError. Extract the human-readable message when possible.
 */
export function ipcErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(error.message) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message;
    } catch { /* Not a normalized payload; fall through. */ }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
