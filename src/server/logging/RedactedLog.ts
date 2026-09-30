import { diagnosticSchema, type Diagnostic } from '../../shared/protocol/diagnostics';

/** Operational diagnostics are constructed from a fixed DTO BEFORE serialization.
 * Never hand an Error, URL, request, header, prompt, token, file path, or settings object to this sink. */
export class RedactedLog {
  constructor(private readonly sink: (entry: string) => void) {}
  write(input: Diagnostic): void {
    try { this.sink(JSON.stringify(diagnosticSchema.parse(input))); }
    catch { /* Logging cannot alter command admission or reveal a fallback error. */ }
  }
}
