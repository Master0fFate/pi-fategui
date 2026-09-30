import { requestEnvelopeSchema, responseEnvelopeSchema, type MutationRequest, type ProtocolResponse, type WireRequest } from '../shared/protocol/envelopes';
import { createServerEpoch } from '../shared/protocol/requestIds';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export class UnconfirmedCommand extends Error {
  constructor(readonly requestId: string, readonly status: ProtocolResponse | null = null) {
    super('The command outcome is not confirmed. Query its original request ID; do not submit a new mutation.');
    this.name = 'UnconfirmedCommand';
  }
}
async function boundedResponse(response: Response): Promise<ProtocolResponse> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The command response is empty.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('The command response exceeds the protocol limit.');
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  return responseEnvelopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
}

/** A timeout never implies that a mutation did not start. No automatic replay. */
export class HttpCommandTransport {
  constructor(private readonly baseUrl: string,
    private readonly credentials: () => Readonly<Record<string, string>>,
    private readonly ticket: () => string | null,
    private readonly send: typeof fetch = fetch) {
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/u.test(baseUrl)) throw new Error('Only an explicit loopback server is supported.');
  }
  async command(request: WireRequest): Promise<ProtocolResponse> {
    const parsed = requestEnvelopeSchema.parse(request);
    const ticket = this.ticket();
    if (!ticket) throw new Error('An authenticated event connection is required for commands.');
    const response = await this.send(`${this.baseUrl}/api/command`, { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Fate-Client-Ticket': ticket, ...this.credentials() },
      body: JSON.stringify(parsed) });
    const result = await boundedResponse(response);
    if (result.requestId !== parsed.requestId || result.serverEpoch !== parsed.serverEpoch) throw new Error('Stale command response.');
    return result;
  }
  /** Explicit read-only reconciliation after a lost response; old mutation ID is never changed. */
  async status(original: MutationRequest, currentServerEpoch: string = original.serverEpoch): Promise<ProtocolResponse> {
    return this.command({ protocol: 1, requestId: createServerEpoch(), serverEpoch: currentServerEpoch, issuedAt: Date.now(),
      method: 'command.status', workspaceId: original.workspaceId, workspaceGeneration: original.workspaceGeneration,
      input: { requestId: original.requestId } });
  }
  async commandWithStatus(original: MutationRequest): Promise<ProtocolResponse> {
    try { return await this.command(original); }
    catch {
      let status: ProtocolResponse | null = null;
      try { status = await this.status(original); } catch { /* Report uncertainty; do not retry the effect. */ }
      throw new UnconfirmedCommand(original.requestId, status);
    }
  }
}
