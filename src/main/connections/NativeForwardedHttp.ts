import { request } from 'node:http';
import { forwardedHostSchema } from '../../shared/protocol/connectionProfiles';
import { MAX_COMMAND_BYTES, MAX_RESULT_BYTES } from '../../shared/protocol/methods';

const unavailable = () => new Error('Remote command transport is unavailable.');

/** Main-only exact command route. Node fetch can replace Host with the local relay port. */
export function createNativeForwardedFetch(origin: string, expectedHost: string): typeof fetch {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(origin) || Number(new URL(origin).port) > 65535) throw unavailable();
  const host = forwardedHostSchema.parse(expectedHost), endpoint = `${origin}/api/command`;
  return async (input, init) => {
    if (typeof input !== 'string' || input !== endpoint || init?.method !== 'POST' || typeof init.body !== 'string'
      || init.credentials !== 'omit' || init.redirect !== 'error' || Buffer.byteLength(init.body, 'utf8') > MAX_COMMAND_BYTES) throw unavailable();
    const incoming = new Headers(init.headers), authorization = incoming.get('Authorization'), ticket = incoming.get('X-Fate-Client-Ticket');
    if (!authorization || !/^Bearer fc1_[A-Za-z0-9_-]{43}$/u.test(authorization) || !ticket || !/^ft1_[A-Za-z0-9_-]{43}$/u.test(ticket)) throw unavailable();
    const body = init.body;
    return new Promise<Response>((resolve, reject) => {
      const call = request(new URL(endpoint), { method: 'POST', timeout: 10_000,
        ...(init.signal ? { signal: init.signal } : {}),
        headers: { Host: host, Authorization: authorization, 'X-Fate-Client-Ticket': ticket,
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8') },
      }, (response) => {
        const status = response.statusCode;
        if (status === undefined || status < 200 || status > 599 || status === 204 || status === 205 || status >= 300 && status < 400) {
          response.destroy(); reject(unavailable()); return;
        }
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_RESULT_BYTES) { response.destroy(); call.destroy(); reject(unavailable()); return; }
          chunks.push(chunk);
        });
        response.once('aborted', () => reject(unavailable())); response.once('error', () => reject(unavailable()));
        response.once('end', () => resolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })));
      });
      call.once('timeout', () => { call.destroy(); reject(unavailable()); });
      call.once('error', () => reject(unavailable())); call.end(body);
    });
  };
}
