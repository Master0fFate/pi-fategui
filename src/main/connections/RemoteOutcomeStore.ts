import { z } from 'zod';
import { pendingRemoteOutcomeSchema } from '../../shared/contracts/connections';
import type { PendingRemoteOutcome } from './RemoteCoreClient';
import { readPrivateConnectionJson, writePrivateConnectionJson } from './PrivateConnectionFile';

const MAX_METADATA_BYTES = 192 * 1024;
const schema = z.object({ version: z.literal(1), outcomes: z.array(pendingRemoteOutcomeSchema).max(128) }).strict()
  .refine(({ outcomes }) => new Set(outcomes.map((item) => item.requestId)).size === outcomes.length);
/** Client-side recovery metadata only. No prompt, credential, response body, or execution replay. */
export class RemoteOutcomeStore {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  async load(): Promise<PendingRemoteOutcome[]> {
    const raw = await readPrivateConnectionJson(this.file, MAX_METADATA_BYTES);
    if (raw === undefined) return [];
    return schema.parse(raw).outcomes.map((item) => ({ ...item, status: item.status === 'sending' ? 'outcome_unknown' : item.status }));
  }
  save(outcomes: readonly PendingRemoteOutcome[]): Promise<void> {
    const value = schema.parse({ version: 1, outcomes });
    const work = this.tail.then(() => writePrivateConnectionJson(this.file, value, MAX_METADATA_BYTES));
    this.tail = work.catch(() => undefined);
    return work;
  }
  flush(): Promise<void> { return this.tail; }
}
