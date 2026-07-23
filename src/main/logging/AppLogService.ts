import type { LogEntry } from '../../shared/contracts/ipc';

/** In-memory, credential-free application diagnostics ring buffer. */
export class AppLogService {
  private readonly entries: LogEntry[] = [];

  write(level: LogEntry['level'], scope: string, message: string): void {
    const sanitized = message
      .replace(/(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}/gi, '[credential redacted]')
      .slice(0, 8_000);
    this.entries.push({ timestamp: new Date().toISOString(), level, scope, message: sanitized });
    if (this.entries.length > 500) this.entries.splice(0, this.entries.length - 500);
  }

  list(): LogEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}
