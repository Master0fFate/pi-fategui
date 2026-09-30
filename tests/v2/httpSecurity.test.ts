import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { apiPath, guardRequest, oneHeader } from '../../src/server/http/requestGuards';

const config = { host: '127.0.0.1' as const, port: 47500, allowedOrigins: new Set(['http://127.0.0.1:47500']) };
function request(rawHeaders: string[], url = '/api/info'): IncomingMessage {
  return { rawHeaders, url } as IncomingMessage;
}
const host = ['Host', '127.0.0.1:47500'];
const origin = ['Origin', 'http://127.0.0.1:47500'];

describe('AUTH-02 HTTP request guards', () => {
  it('rejects a missing, duplicate, or foreign Host, including proxy-provided host', () => {
    for (const headers of [[], [...host, ...host], ['Host', 'evil.example'], ['X-Forwarded-Host', '127.0.0.1:47500']]) {
      expect(() => guardRequest(request(headers), config)).toThrow();
    }
  });
  it('rejects hostile, null, duplicate, or absent browser mutation origins', () => {
    for (const headers of [[...host], [...host, 'Origin', 'null'], [...host, 'Origin', 'http://evil.example'], [...host, ...origin, ...origin]]) {
      expect(() => guardRequest(request(headers), config, { browserMutation: true })).toThrow();
    }
    expect(guardRequest(request([...host, ...origin]), config, { browserMutation: true })).toBe(origin[1]);
    expect(guardRequest(request(host), config)).toBeNull();
  });
  it('accepts only a host explicitly paired with an approved tunneled browser origin', () => {
    const forwarded = { ...config, allowedOrigins: new Set(['http://localhost:47501']),
      allowedHosts: new Set(['127.0.0.1:47500', 'localhost:47501']) };
    expect(guardRequest(request(['Host', 'localhost:47501', 'Origin', 'http://localhost:47501']), forwarded,
      { browserMutation: true })).toBe('http://localhost:47501');
    expect(() => guardRequest(request(['Host', 'localhost:47502', 'Origin', 'http://localhost:47501']), forwarded,
      { browserMutation: true })).toThrow();
  });
  it('rejects owner administration with any browser Origin', () => {
    expect(() => guardRequest(request([...host, ...origin]), config, { ownerAdmin: true })).toThrow();
    expect(guardRequest(request(host), config, { ownerAdmin: true })).toBeNull();
  });
  it('does not accept ambiguous headers, encoded routes, traversal, or query parameters', () => {
    expect(() => oneHeader(request([...host, 'Cookie', 'a', 'Cookie', 'b']), 'cookie')).toThrow();
    for (const target of ['/api/%69nfo', '/api/../info', '/api/info?token=secret', '//api/info', '/api/info#x']) {
      expect(() => apiPath(request(host, target))).toThrow();
    }
    expect(apiPath(request(host))).toBe('/api/info');
  });
});
