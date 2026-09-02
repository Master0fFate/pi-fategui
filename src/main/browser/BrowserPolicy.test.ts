import { describe, expect, it } from 'vitest';
import { BrowserActionGate, BrowserPolicy, inspectBrowserUrl, isPrivateNetworkHostname } from './BrowserPolicy';

describe('browser URL and origin policy', () => {
  it('allows only blank/http/https and rejects credentials and private destinations by default', () => {
    expect(inspectBrowserUrl('about:blank').allowed).toBe(true);
    expect(inspectBrowserUrl('https://example.test/path').allowed).toBe(true);
    expect(inspectBrowserUrl('file:///etc/passwd').allowed).toBe(false);
    expect(inspectBrowserUrl('javascript:alert(1)').allowed).toBe(false);
    expect(inspectBrowserUrl('https://user:pass@example.test').allowed).toBe(false);
    expect(inspectBrowserUrl('http://127.0.0.1:5173').allowed).toBe(true);
    expect(inspectBrowserUrl('http://localhost:3000').allowed).toBe(true);
    expect(inspectBrowserUrl('http://[::1]:3000').allowed).toBe(true);
    expect(inspectBrowserUrl('http://192.168.1.10:8080').allowed).toBe(false);
    expect(inspectBrowserUrl('http://0x7f000001').allowed).toBe(true);
    expect(new BrowserPolicy().allowsPrivateNetworkForOrigin('http://localhost:3000')).toBe(true);
    expect(new BrowserPolicy().allowsPrivateNetworkForOrigin('http://192.168.1.10:8080')).toBe(false);
    expect(isPrivateNetworkHostname('127.0.0.1')).toBe(true);
    expect(isPrivateNetworkHostname('::ffff:7f00:1')).toBe(true);
    expect(isPrivateNetworkHostname('0:0:0:0:0:ffff:c0a8:1')).toBe(true);
    expect(isPrivateNetworkHostname('ff02::1')).toBe(true);
    expect(isPrivateNetworkHostname('::7f00:1')).toBe(true);
    expect(isPrivateNetworkHostname('64:ff9b::7f00:1')).toBe(true);
    expect(isPrivateNetworkHostname('2002:7f00:1::')).toBe(true);
  });

  it('allows explicitly granted private origins but never metadata endpoints', () => {
    const local = 'http://127.0.0.1:5173';
    expect(inspectBrowserUrl(`${local}/`, new Set([local])).allowed).toBe(true);
    expect(inspectBrowserUrl('http://169.254.169.254/latest', new Set(['http://169.254.169.254'])).allowed).toBe(false);
    expect(inspectBrowserUrl('http://metadata.google.internal/', new Set(['http://metadata.google.internal'])).allowed).toBe(false);
  });

  it('gates actions deterministically and consumes one-use grants', () => {
    const policy = new BrowserPolicy();
    policy.setControlLevel('interact');
    policy.beginTask('run-1');
    policy.setGrant({ origin: 'https://example.test', read: true, interact: true, scope: 'once', allowPrivateNetwork: false });
    const gate = new BrowserActionGate(policy);
    const base = { kind: 'click' as const, origin: 'https://example.test', frameOrigin: 'https://example.test', consequence: 'none' as const };
    expect(gate.evaluate(base).outcome).toBe('allow');
    expect(gate.evaluate({ ...base, consequence: 'financial' }).outcome).toBe('confirm');
    expect(gate.evaluate({ ...base, kind: 'type', textClassification: 'secret' }).outcome).toBe('block');
    gate.consume(base);
    expect(gate.evaluate(base).outcome).toBe('block');
  });

  it('consumes a one-use destination grant after a cross-origin submission', () => {
    const policy = new BrowserPolicy();
    policy.setControlLevel('interact');
    policy.beginTask('run-1');
    policy.setGrant({ origin: 'https://example.test', read: true, interact: true, scope: 'task', allowPrivateNetwork: false });
    policy.setGrant({ origin: 'https://receive.test', read: true, interact: true, scope: 'once', allowPrivateNetwork: false });
    const gate = new BrowserActionGate(policy);
    const action = {
      kind: 'submit' as const,
      origin: 'https://example.test',
      frameOrigin: 'https://example.test',
      destinationUrl: 'https://receive.test/form',
      consequence: 'account' as const,
    };

    expect(gate.evaluate(action).outcome).toBe('confirm');
    expect(gate.consume(action)).toBe(true);
    expect(policy.canInteract('https://receive.test')).toBe(false);
  });

  it('binds browser authority to explicit session Full access without weakening metadata blocks', () => {
    const policy = new BrowserPolicy();
    policy.setControlLevel('interact');
    policy.beginTask('run-full-access');
    policy.setSessionFullAccess(true);
    const gate = new BrowserActionGate(policy);

    expect(policy.inspectUrl('http://127.0.0.1:5173/').allowed).toBe(true);
    expect(policy.canRead('https://example.test')).toBe(true);
    expect(policy.canInteract('https://example.test')).toBe(true);
    expect(policy.allowsPrivateNetworkForOrigin('http://localhost:5173')).toBe(true);
    expect(gate.evaluate({
      kind: 'submit', origin: 'https://example.test', frameOrigin: 'https://example.test',
      destinationUrl: 'https://receive.test/form', textClassification: 'secret', consequence: 'account',
    })).toEqual({ outcome: 'allow', reason: 'This session has Full access.' });
    expect(policy.inspectUrl('http://169.254.169.254/latest').allowed).toBe(false);

    policy.setSessionFullAccess(false);
    expect(policy.canInteract('https://example.test')).toBe(false);
  });

  it('never treats opaque origins as implicitly readable or writable', () => {
    const policy = new BrowserPolicy();
    policy.setSessionFullAccess(true);
    expect(policy.canRead('null')).toBe(false);
    expect(policy.canRead('opaque')).toBe(false);
    expect(policy.canInteract('null')).toBe(false);
  });
});
