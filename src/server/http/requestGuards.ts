import type { IncomingMessage } from 'node:http';
import { ProtocolFault } from '../../shared/protocol/errors';

/** These are host-owned values, never inferred from Forwarded or X-Forwarded-* headers. */
export interface HttpGuardConfig {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowedHosts?: ReadonlySet<string>;
}

/** Reject ambiguous Host and Origin fields before reading a request body or upgrading a socket. */
export function guardRequest(request: IncomingMessage, config: HttpGuardConfig, options: {
  readonly browserMutation?: boolean;
  readonly websocket?: boolean;
  readonly ownerAdmin?: boolean;
} = {}): string | null {
  const fields = new Map<string, string[]>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    const value = request.rawHeaders[index + 1];
    if (!name || value === undefined) throw new ProtocolFault('INVALID_REQUEST');
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }
  const host = fields.get('host');
  const allowedHosts = config.allowedHosts ?? new Set([`${config.host}:${config.port}`]);
  if (host?.length !== 1 || !allowedHosts.has(host[0]!)) throw new ProtocolFault('FORBIDDEN');
  const origins = fields.get('origin');
  if (origins && (origins.length !== 1 || !config.allowedOrigins.has(origins[0]!))) throw new ProtocolFault('FORBIDDEN');
  if ((options.browserMutation || options.websocket) && !origins) throw new ProtocolFault('FORBIDDEN');
  if (options.ownerAdmin && origins) throw new ProtocolFault('FORBIDDEN');
  return origins?.[0] ?? null;
}

/** No API route accepts an encoded path, fragment, query, or alternate spelling. */
export function apiPath(request: IncomingMessage): string {
  const target = request.url;
  if (!target || target.length > 2048 || !target.startsWith('/') || target.startsWith('//') || /[%?#\\\u0000-\u001f\u007f]/u.test(target)
    || target.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new ProtocolFault('INVALID_REQUEST');
  }
  return target;
}

export function oneHeader(request: IncomingMessage, name: string): string | null {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
      const value = request.rawHeaders[index + 1];
      if (value === undefined) throw new ProtocolFault('INVALID_REQUEST');
      values.push(value);
    }
  }
  if (values.length > 1) throw new ProtocolFault('INVALID_REQUEST');
  return values[0] ?? null;
}

/** Prevent unbounded buffering, including chunked bodies with no Content-Length. */
export async function boundedTextBody(request: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  if (oneHeader(request, 'content-type') !== 'application/json') throw new ProtocolFault('INVALID_REQUEST');
  const declared = oneHeader(request, 'content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maxBytes)) throw new ProtocolFault('INVALID_REQUEST');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new ProtocolFault('INVALID_REQUEST');
    size += chunk.length;
    if (size > maxBytes) throw new ProtocolFault('INVALID_REQUEST');
    chunks.push(chunk);
  }
  if (declared !== null && size !== Number(declared)) throw new ProtocolFault('INVALID_REQUEST');
  return Buffer.concat(chunks, size).toString('utf8');
}

export async function boundedJsonBody(request: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  const text = await boundedTextBody(request, maxBytes);
  try { return JSON.parse(text) as unknown; }
  catch { throw new ProtocolFault('INVALID_REQUEST'); }
}
