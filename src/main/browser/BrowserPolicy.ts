import { isIP } from 'node:net';
import type {
  BrowserActionDecision,
  BrowserControlLevel,
  BrowserOriginGrant,
  ProposedBrowserAction,
} from '../../shared/contracts/browser';
import { browserOriginGrantSchema, proposedBrowserActionSchema } from '../../shared/contracts/browser';
import { BrowserError } from './BrowserErrors';

export interface BrowserUrlDecision {
  allowed: boolean;
  normalizedUrl?: string;
  origin?: string;
  privateNetwork: boolean;
  reason: string;
}

export function inspectBrowserUrl(value: string, privateNetworkOrigins: ReadonlySet<string> = new Set()): BrowserUrlDecision {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { allowed: false, privateNetwork: false, reason: 'The address is not a valid URL.' };
  }

  if (url.href === 'about:blank') {
    return { allowed: true, normalizedUrl: url.href, origin: 'null', privateNetwork: false, reason: 'Blank page is allowed.' };
  }
  if (url.protocol === 'fate-local:') {
    if (url.username || url.password || url.port || !/^[a-f0-9]{48}$/u.test(url.hostname)) {
      return { allowed: false, privateNetwork: false, reason: 'The local-page capability is invalid.' };
    }
    return {
      allowed: true,
      normalizedUrl: url.href,
      origin: `fate-local://${url.hostname}`,
      privateNetwork: false,
      reason: 'Authorized local page is allowed.',
    };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, privateNetwork: false, reason: `The ${url.protocol || 'unknown'} protocol is blocked.` };
  }
  if (url.username || url.password) {
    return { allowed: false, privateNetwork: false, reason: 'URLs containing credentials are blocked.' };
  }

  if (isCloudMetadataHostname(url.hostname)) {
    return { allowed: false, normalizedUrl: url.href, origin: url.origin, privateNetwork: true, reason: 'Cloud metadata endpoints are always blocked.' };
  }
  const privateNetwork = isPrivateNetworkHostname(url.hostname);
  if (privateNetwork && !isLoopbackHostname(url.hostname) && !privateNetworkOrigins.has(url.origin)) {
    return {
      allowed: false,
      normalizedUrl: url.href,
      origin: url.origin,
      privateNetwork,
      reason: 'This private-network address needs agent permission first: open it in the built-in browser address bar, then press “Allow agent” on the access strip (or switch the session to Full access).',
    };
  }
  return { allowed: true, normalizedUrl: url.href, origin: url.origin, privateNetwork, reason: 'URL is allowed.' };
}

export function isCloudMetadataHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  const mappedIpv4 = embeddedIpv4FromIpv6(hostname);
  return hostname === '169.254.169.254'
    || hostname === 'metadata.google.internal'
    || hostname === 'metadata.google'
    || hostname === '100.100.100.200'
    || hostname === 'fd00:ec2::254'
    || Boolean(mappedIpv4 && isCloudMetadataHostname(mappedIpv4));
}

export function isLoopbackHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'localhost.localdomain' || hostname === '::1') return true;
  const ipKind = isIP(hostname);
  if (ipKind === 4) return hostname.split('.')[0] === '127';
  if (ipKind === 6) {
    const mapped = embeddedIpv4FromIpv6(hostname);
    return mapped ? isLoopbackHostname(mapped) : false;
  }
  return false;
}

export function isPrivateNetworkHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (isLoopbackHostname(hostname)) return true;

  const ipKind = isIP(hostname);
  if (ipKind === 4) {
    const octets = hostname.split('.').map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224;
  }
  if (ipKind === 6) {
    if (hostname === '::' || hostname === '::1') return true;
    if (/^f[cd]/u.test(hostname) || /^fe/u.test(hostname) || /^ff/u.test(hostname)) return true;
    const mapped = embeddedIpv4FromIpv6(hostname);
    return mapped ? isPrivateNetworkHostname(mapped) : false;
  }
  return false;
}

function embeddedIpv4FromIpv6(value: string): string | null {
  const words = ipv6Words(value);
  if (!words) return null;
  const ipv4 = (high: number, low: number) => `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
  const allZero = (start: number, end: number) => words.slice(start, end).every((word) => word === 0);

  // IPv4-compatible and IPv4-mapped addresses.
  if (allZero(0, 6) || (allZero(0, 5) && words[5] === 0xffff)) return ipv4(words[6] ?? 0, words[7] ?? 0);
  // IPv4-translatable address prefix ::ffff:0:0/96.
  if (allZero(0, 4) && words[4] === 0xffff && words[5] === 0) return ipv4(words[6] ?? 0, words[7] ?? 0);
  // Well-known and local-use NAT64 prefixes.
  if (words[0] === 0x64 && words[1] === 0xff9b && allZero(2, 6)) return ipv4(words[6] ?? 0, words[7] ?? 0);
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) return ipv4(words[3] ?? 0, words[4] ?? 0);
  // 6to4 and ISATAP transition addresses can encapsulate private IPv4.
  if (words[0] === 0x2002) return ipv4(words[1] ?? 0, words[2] ?? 0);
  if (words[5] === 0x5efe) return ipv4(words[6] ?? 0, words[7] ?? 0);
  return null;
}

function ipv6Words(value: string): number[] | null {
  if (isIP(value) !== 6) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const result: number[] = [];
    for (const piece of side.split(':')) {
      if (!piece) return null;
      if (piece.includes('.')) {
        const octets = piece.split('.').map(Number);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
        result.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
      } else {
        const parsed = Number.parseInt(piece, 16);
        if (!/^[0-9a-f]{1,4}$/u.test(piece) || !Number.isInteger(parsed)) return null;
        result.push(parsed);
      }
    }
    return result;
  };
  const left = parseSide(halves[0] ?? '');
  const right = parseSide(halves[1] ?? '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = halves.length === 1 ? left : [...left, ...Array.from({ length: missing }, () => 0), ...right];
  return words.length === 8 ? words : null;
}

export class BrowserPolicy {
  private controlLevel: BrowserControlLevel = 'off';
  private sessionFullAccess = false;
  private readonly grants = new Map<string, { grant: BrowserOriginGrant; taskId?: string }>();
  private activeTaskId: string | null = null;

  setControlLevel(level: BrowserControlLevel): void {
    this.controlLevel = level;
  }

  getControlLevel(): BrowserControlLevel {
    return this.controlLevel;
  }

  setSessionFullAccess(enabled: boolean): boolean {
    const changed = this.sessionFullAccess !== enabled;
    this.sessionFullAccess = enabled;
    return changed;
  }

  hasSessionFullAccess(): boolean {
    return this.sessionFullAccess;
  }

  beginTask(taskId: string): boolean {
    const bounded = taskId.trim();
    if (!bounded || bounded.length > 500) throw new BrowserError('ACTION_BLOCKED', 'A bounded task or run id is required.');
    const changed = this.activeTaskId !== bounded;
    if (this.activeTaskId && changed) {
      this.clearScopedGrants('once');
      this.clearScopedGrants('task');
    }
    this.activeTaskId = bounded;
    return changed;
  }

  setGrant(input: BrowserOriginGrant): BrowserOriginGrant {
    const parsed = browserOriginGrantSchema.parse(input);
    if (parsed.scope !== 'always' && !this.activeTaskId) {
      throw new BrowserError('ACTION_BLOCKED', 'Once and task browser grants require an active task binding.');
    }
    const origin = normalizeNetworkOrigin(parsed.origin);
    if (isCloudMetadataHostname(new URL(origin).hostname)) {
      throw new BrowserError('PRIVATE_NETWORK_BLOCKED', 'Cloud metadata origins can never receive browser grants.');
    }
    const grant = { ...parsed, origin };
    this.grants.set(origin, { grant, ...(parsed.scope === 'always' ? {} : { taskId: this.activeTaskId! }) });
    return grant;
  }

  revokeGrant(origin: string): boolean {
    return this.grants.delete(normalizeNetworkOrigin(origin));
  }

  listGrants(): BrowserOriginGrant[] {
    return [...this.grants.values()].map((entry) => ({ ...entry.grant }));
  }

  inspectUrl(value: string): BrowserUrlDecision {
    const privateOrigins = new Set(
      [...this.grants.values()].filter((entry) => this.isActive(entry) && entry.grant.allowPrivateNetwork).map((entry) => entry.grant.origin),
    );
    if (this.sessionFullAccess) {
      try {
        const url = new URL(value.trim());
        if ((url.protocol === 'http:' || url.protocol === 'https:') && !isCloudMetadataHostname(url.hostname)) privateOrigins.add(url.origin);
      } catch { /* The shared URL inspector returns the canonical parse error. */ }
    }
    return inspectBrowserUrl(value, privateOrigins);
  }

  requireAllowedUrl(value: string): { url: string; origin: string } {
    const decision = this.inspectUrl(value);
    if (!decision.allowed || !decision.normalizedUrl || !decision.origin) {
      throw new BrowserError(
        decision.privateNetwork ? 'PRIVATE_NETWORK_BLOCKED' : 'INVALID_URL',
        decision.reason,
      );
    }
    return { url: decision.normalizedUrl, origin: decision.origin };
  }

  allowsPrivateNetworkForOrigin(origin: string): boolean {
    try {
      const normalized = normalizeNetworkOrigin(origin);
      const hostname = new URL(normalized).hostname;
      if (isCloudMetadataHostname(hostname)) return false;
      if (isLoopbackHostname(hostname) || this.sessionFullAccess) return true;
      const entry = this.grants.get(normalized);
      return Boolean(entry && this.isActive(entry) && entry.grant.allowPrivateNetwork);
    } catch { return false; }
  }

  canRead(origin: string): boolean {
    if (isLocalPageOrigin(origin)) return true;
    if (origin === 'null') return false;
    try {
      const normalized = normalizeNetworkOrigin(origin);
      if (this.sessionFullAccess && !isCloudMetadataHostname(new URL(normalized).hostname)) return true;
      const entry = this.grants.get(normalized);
      return Boolean(entry && this.isActive(entry) && entry.grant.read);
    } catch { return false; }
  }

  canInteract(origin: string): boolean {
    if (isLocalPageOrigin(origin)) return true;
    if (origin === 'null') return false;
    try {
      const normalized = normalizeNetworkOrigin(origin);
      if (this.sessionFullAccess && !isCloudMetadataHostname(new URL(normalized).hostname)) return true;
      const entry = this.grants.get(normalized);
      return Boolean(entry && this.isActive(entry) && entry.grant.interact);
    } catch { return false; }
  }

  consumeOnceGrant(origin: string): boolean {
    let normalized: string;
    try { normalized = normalizeNetworkOrigin(origin); } catch { return false; }
    if (this.grants.get(normalized)?.grant.scope !== 'once') return false;
    return this.grants.delete(normalized);
  }

  clearScopedGrants(scope: 'once' | 'task'): void {
    for (const [origin, entry] of this.grants) if (entry.grant.scope === scope) this.grants.delete(origin);
    if (scope === 'task') this.activeTaskId = null;
  }

  private isActive(entry: { grant: BrowserOriginGrant; taskId?: string }): boolean {
    return entry.grant.scope === 'always' || Boolean(this.activeTaskId && entry.taskId === this.activeTaskId);
  }
}

export class BrowserActionGate {
  constructor(private readonly policy: BrowserPolicy) {}

  consume(action: ProposedBrowserAction): boolean {
    const originConsumed = this.policy.consumeOnceGrant(action.origin);
    const frameConsumed = action.frameOrigin !== action.origin && this.policy.consumeOnceGrant(action.frameOrigin);
    let destinationConsumed = false;
    if (action.destinationUrl) {
      try {
        destinationConsumed = this.policy.consumeOnceGrant(new URL(action.destinationUrl).origin);
      } catch { /* Invalid destinations are blocked during evaluation. */ }
    }
    return originConsumed || frameConsumed || destinationConsumed;
  }

  evaluate(rawAction: ProposedBrowserAction): BrowserActionDecision {
    const action = proposedBrowserActionSchema.parse(rawAction);
    const level = this.policy.getControlLevel();
    if (level !== 'interact') return { outcome: 'block', reason: `Browser control level ${level} does not permit agent actions.` };
    if (!this.policy.canRead(action.origin) || !this.policy.canRead(action.frameOrigin)) {
      return { outcome: 'block', reason: 'The action references an origin that is not readable.' };
    }
    if (!this.policy.canInteract(action.origin) || !this.policy.canInteract(action.frameOrigin)) {
      return { outcome: 'block', reason: 'The action references an origin that is not writable.' };
    }
    if (action.textClassification === 'secret' && !this.policy.hasSessionFullAccess()) {
      return { outcome: 'block', reason: 'Secrets, passwords, and one-time codes require human takeover.' };
    }
    if (action.destinationUrl) {
      const destination = this.policy.inspectUrl(action.destinationUrl);
      if (!destination.allowed || !destination.origin) return { outcome: 'block', reason: destination.reason };
      if (!this.policy.canInteract(destination.origin)) {
        return { outcome: 'block', reason: 'The destination origin is not writable.' };
      }
      if (!this.policy.hasSessionFullAccess() && destination.origin !== comparableOrigin(action.origin)) {
        return { outcome: 'confirm', reason: 'Moving data or control to another origin requires confirmation.' };
      }
    }
    if (this.policy.hasSessionFullAccess()) {
      return { outcome: 'allow', reason: 'This session has Full access.' };
    }
    if (action.kind === 'upload' || action.kind === 'download' || action.kind === 'submit') {
      return { outcome: 'confirm', reason: `${action.kind} actions require confirmation.` };
    }
    if (action.consequence !== 'none') {
      return { outcome: 'confirm', reason: `${action.consequence} actions require confirmation.` };
    }
    return { outcome: 'allow', reason: 'The origin grants and action classification permit this action.' };
  }
}

function isLocalPageOrigin(value: string): boolean {
  return /^fate-local:\/\/[a-f0-9]{48}$/u.test(value);
}

function comparableOrigin(value: string): string {
  return isLocalPageOrigin(value) ? value : normalizeNetworkOrigin(value);
}

function normalizeNetworkOrigin(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.origin === 'null') {
      throw new Error('Unsupported origin');
    }
    return url.origin;
  } catch {
    throw new BrowserError('INVALID_URL', 'Browser origin grants require an http or https origin.');
  }
}
