import { describe, expect, it } from 'vitest';
import type { BrowserCdpClient } from './CdpClient';
import { BrowserPointerOverlay } from './BrowserPointerOverlay';

describe('BrowserPointerOverlay', () => {
  it('renders movement and click feedback through page CDP without native cursor APIs', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const send: BrowserCdpClient['send'] = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push([method, params]);
      return {} as T;
    };
    const cdp: BrowserCdpClient = { supports: (domain) => domain === 'Runtime', send };
    const pointer = new BrowserPointerOverlay(cdp);

    await pointer.move({ x: 42.25, y: 81.5 }, 'button "Save"');
    await pointer.click({ x: 42.25, y: 81.5 });
    await pointer.clear();

    expect(calls).toHaveLength(3);
    expect(calls.every(([method]) => method === 'Runtime.evaluate')).toBe(true);
    expect(JSON.stringify(calls)).toContain('agent-pointer');
    expect(String(calls[0]?.[1]?.expression)).toContain(JSON.stringify('button "Save"'));
  });

  it('degrades silently when the Runtime domain is unavailable', async () => {
    const calls: string[] = [];
    const send: BrowserCdpClient['send'] = async <T>(method: string): Promise<T> => {
      calls.push(method);
      return {} as T;
    };
    const pointer = new BrowserPointerOverlay({ supports: () => false, send });

    await pointer.move({ x: 1, y: 2 }, 'target');
    await pointer.click({ x: 1, y: 2 });

    expect(calls).toEqual([]);
  });
});
