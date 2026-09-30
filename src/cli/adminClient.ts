import type { FatePaths } from '../core/FatePaths';
import { readHostOwnerCredential } from '../server/auth/AuthStore';
import { adminRequestSchema, adminResponseSchema, type AdminRequest, type AdminResponse } from '../server/admin/adminMethods';

export interface HostAdminClient { execute(request: AdminRequest): Promise<AdminResponse> }
/** No core/store constructor. Administration always goes to the current profile owner. */
export function createHostAdminClient(paths: FatePaths, port: number): HostAdminClient {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid host admin endpoint.');
  return Object.freeze({
    async execute(raw: AdminRequest): Promise<AdminResponse> {
      const request = adminRequestSchema.parse(raw);
      try {
        const owner = await readHostOwnerCredential(paths);
        const response = await fetch(`http://127.0.0.1:${port}/api/admin`, { method: 'POST', redirect: 'error',
          signal: AbortSignal.timeout(10_000), cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` }, body: JSON.stringify(request) });
        if (!response.ok || !response.body) throw new Error('Host admin refused.');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let count = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            count += next.value.byteLength;
            if (count > 1024 * 1024) { await reader.cancel(); throw new Error('Host admin result too large.'); }
            chunks.push(next.value);
          }
        } finally { reader.releaseLock(); }
        const result = adminResponseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
        if (result.method !== request.method) throw new Error('Host admin response mismatch.');
        return result;
      } catch {
        throw new Error('Start the host server, then retry. Check the private owner storage and host configuration.');
      }
    },
  });
}
