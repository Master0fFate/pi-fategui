import { z } from 'zod';
import { connectionSelectSchema, type ConnectionSelection } from '../../shared/contracts/connections';
import { readPrivateConnectionJson, writePrivateConnectionJson } from './PrivateConnectionFile';

const schema = z.object({ version: z.literal(1), selection: connectionSelectSchema }).strict();
/** Public target IDs only. A failed load must be fenced by main, never interpreted as local. */
export class ConnectionSelectionStore {
  constructor(private readonly file: string) {}
  async load(): Promise<ConnectionSelection> {
    const raw = await readPrivateConnectionJson(this.file, 2048);
    return raw === undefined ? { kind: 'local' } : schema.parse(raw).selection;
  }
  /** Explicit trusted selection only, never authentication/connection failure. */
  async save(selection: ConnectionSelection): Promise<void> {
    await writePrivateConnectionJson(this.file, schema.parse({ version: 1, selection }), 2048);
  }
}
