import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FatePaths } from '../../core/FatePaths';
import { ProtocolFault } from '../../shared/protocol/errors';
import { AuthStore, credentialDigest, freshCredential, type AuthState } from './AuthStore';

const CODE_LIFETIME_MS = 5 * 60_000;
const SESSION_LIFETIME_MS = 8 * 60 * 60_000;
const CLIENT_LIFETIME_MS = 30 * 24 * 60 * 60_000;
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILED_EXCHANGES = 5;
const MAX_CODES = 64;
const MAX_SESSIONS = 32;
const MAX_CLIENTS = 128;
const codePattern = /^fb1_[A-Za-z0-9_-]{43}$/u;
const clientPattern = /^fc1_[A-Za-z0-9_-]{43}$/u;
const sessionPattern = /^fs1_[A-Za-z0-9_-]{43}$/u;
const csrfPattern = /^fx1_[A-Za-z0-9_-]{43}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ClientPrincipal {
  readonly kind: 'client';
  readonly principalId: string;
  readonly clientId: string;
  readonly workspaceRoots: readonly string[];
  readonly expiresAt: number;
}
export interface BrowserPrincipal {
  readonly kind: 'browser';
  readonly principalId: string;
  readonly sessionId: string;
  /** A code grants registered-workspace viewing, not a control lease or mutation. */
  readonly workspaceRoots: readonly string[];
  readonly expiresAt: number;
}
export type AuthRevocation =
  | Readonly<{ kind: 'client'; clientId: string }>
  | Readonly<{ kind: 'session'; sessionId: string }>
  | Readonly<{ kind: 'all' }>;

export interface BrowserSessionInfo { readonly sessionId: string; readonly expiresAt: number; readonly csrfToken: string }
export interface ExchangedSession { readonly sessionToken: string; readonly session: BrowserSessionInfo }
export interface IssuedClient { readonly clientId: string; readonly credential: string; readonly expiresAt: number }
export interface BootstrapCode { readonly code: string; readonly expiresAt: number }
export interface SafeAuthStatus { readonly clientCount: number; readonly liveSessionCount: number; readonly pendingCodeCount: number }

function prune(draft: AuthState, now: number): void {
  draft.clients = draft.clients.filter((item) => item.expiresAt > now);
  draft.codes = draft.codes.filter((item) => item.expiresAt > now);
  draft.sessions = draft.sessions.filter((item) => item.expiresAt > now);
  draft.failures = draft.failures.map((item) => ({ peer: item.peer, at: item.at.filter((at) => at > now - FAILURE_WINDOW_MS) }))
    .filter((item) => item.at.length > 0);
}
function equalToken(left: string, right: string): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

/**
 * Host-owned authentication. Only an owner credential authorizes the typed
 * admin operations. Transport must independently enforce Host/Origin/CSRF;
 * a missing Origin is never an admin role or proof of local ownership.
 */
export class AuthService {
  private readonly rootsByDigest: ReadonlyMap<string, string>;
  private readonly browserRoots: readonly string[];
  private readonly listeners = new Set<(event: AuthRevocation) => void>();

  private constructor(private readonly store: AuthStore, workspaceRoots: readonly string[]) {
    if (workspaceRoots.length < 1 || workspaceRoots.length > 8 || new Set(workspaceRoots).size !== workspaceRoots.length
      || workspaceRoots.some((root) => !path.isAbsolute(root) || path.normalize(root) !== root || root.includes('\0'))) {
      throw new ProtocolFault('INVALID_REQUEST');
    }
    this.rootsByDigest = new Map(workspaceRoots.map((root) => [credentialDigest('workspace', root), root]));
    this.browserRoots = Object.freeze([...workspaceRoots]);
    store.onBlocked(() => { this.publish({ kind: 'all' }); });
  }

  /** Must be called only after the core acquired the profile-owner lock. */
  static async open(paths: FatePaths, workspaceRoots: readonly string[], options: { readonly now?: () => number } = {}): Promise<AuthService> {
    return new AuthService(await AuthStore.open(paths, options), workspaceRoots);
  }

  subscribeRevocations(listener: (event: AuthRevocation) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  /** The host stop path fences new authentication and closes subscribers first. */
  close(): void { this.store.close(); this.listeners.clear(); }
  private publish(event: AuthRevocation): void {
    for (const listener of this.listeners) { try { listener(event); } catch { /* The store remains revoked even if a transport fails to close. */ } }
  }
  /** Never pass the owner credential into ordinary bearer or cookie authentication. */
  assertOwner(credential: string): void {
    if (!this.store.ownerMatches(credential)) throw new ProtocolFault('UNAUTHENTICATED');
  }
  /** Admin HTTP adapter must also reject an Origin and any presented cookie. */
  authorizeAdmin(input: Readonly<{ ownerCredential: string; origin: string | null; cookiePresented: boolean }>): void {
    if (input.origin !== null || input.cookiePresented) throw new ProtocolFault('FORBIDDEN');
    this.assertOwner(input.ownerCredential);
  }

  async createBootstrapCode(ownerCredential: string): Promise<BootstrapCode> {
    this.assertOwner(ownerCredential);
    const code = freshCredential('fb1');
    return this.store.transaction((draft, now) => {
      this.assertOwner(ownerCredential); // Recheck in the write lane after a pending rotation.
      prune(draft, now);
      if (draft.codes.length >= MAX_CODES) throw new ProtocolFault('BUSY');
      const expiresAt = now + CODE_LIFETIME_MS;
      draft.codes.push({ digest: credentialDigest('code', code),
        scope: this.browserRoots.map((root) => credentialDigest('workspace', root)), issuedAt: now, expiresAt });
      return { code, expiresAt };
    });
  }

  /** Host-only rollback/revocation. A consumed code cannot revoke its separate browser session. */
  async revokeBootstrapCode(ownerCredential: string, code: string): Promise<{ revoked: boolean }> {
    this.assertOwner(ownerCredential);
    if (!codePattern.test(code)) throw new ProtocolFault('INVALID_REQUEST');
    return this.store.transaction((draft, now) => {
      this.assertOwner(ownerCredential);
      prune(draft, now);
      const digest = credentialDigest('code', code);
      const before = draft.codes.length;
      draft.codes = draft.codes.filter((entry) => entry.digest !== digest);
      return { revoked: draft.codes.length !== before };
    });
  }

  async issueClientCredential(ownerCredential: string, workspaceRoots: readonly string[]): Promise<IssuedClient> {
    this.assertOwner(ownerCredential);
    if (workspaceRoots.length < 1 || workspaceRoots.length > 8 || new Set(workspaceRoots).size !== workspaceRoots.length
      || workspaceRoots.some((root) => !this.rootsByDigest.has(credentialDigest('workspace', root)))) {
      throw new ProtocolFault('INVALID_REQUEST');
    }
    const credential = freshCredential('fc1');
    return this.store.transaction((draft, now) => {
      this.assertOwner(ownerCredential);
      prune(draft, now);
      if (draft.clients.length >= MAX_CLIENTS) throw new ProtocolFault('BUSY');
      const clientId = randomUUID();
      const expiresAt = now + CLIENT_LIFETIME_MS;
      draft.clients.push({ id: clientId, digest: credentialDigest('client', credential),
        scope: workspaceRoots.map((root) => credentialDigest('workspace', root)), issuedAt: now, expiresAt });
      return { clientId, credential, expiresAt };
    });
  }

  async revokeClientCredential(ownerCredential: string, clientId: string): Promise<{ revoked: boolean }> {
    this.assertOwner(ownerCredential);
    if (!uuidPattern.test(clientId)) throw new ProtocolFault('INVALID_REQUEST');
    const revoked = await this.store.transaction((draft, now) => {
      this.assertOwner(ownerCredential);
      prune(draft, now);
      const count = draft.clients.length;
      draft.clients = draft.clients.filter((item) => item.id !== clientId);
      return draft.clients.length !== count;
    });
    if (revoked) this.publish({ kind: 'client', clientId });
    return { revoked };
  }

  /** Only separate, explicitly issued client keys are native bearer credentials. */
  authenticateClient(credential: string): ClientPrincipal | null {
    const state = this.store.snapshot();
    if (typeof credential !== 'string' || !clientPattern.test(credential)) return null;
    const digest = credentialDigest('client', credential);
    const client = state.clients.find((item) => item.digest === digest && item.expiresAt > this.store.now());
    if (!client) return null;
    const workspaceRoots = client.scope.flatMap((item) => {
      const root = this.rootsByDigest.get(item);
      return root === undefined ? [] : [root];
    });
    if (workspaceRoots.length === 0) return null;
    return Object.freeze({ kind: 'client', principalId: client.id, clientId: client.id,
      workspaceRoots: Object.freeze(workspaceRoots), expiresAt: client.expiresAt });
  }

  /** One durable transaction consumes a code and creates the session. Failures
   * are also persisted, so restarting cannot reset the five-per-minute throttle. */
  async exchange(code: string, peer: string): Promise<ExchangedSession> {
    if (peer !== '127.0.0.1') throw new ProtocolFault('INVALID_REQUEST');
    const sessionToken = freshCredential('fs1');
    const sessionId = randomUUID();
    const peerDigest = credentialDigest('peer', peer);
    const outcome = await this.store.transaction((draft, now) => {
      prune(draft, now);
      const attempts = draft.failures.find((item) => item.peer === peerDigest);
      if (attempts && attempts.at.length >= MAX_FAILED_EXCHANGES) return { result: 'throttled' as const };
      const digest = typeof code === 'string' && codePattern.test(code) ? credentialDigest('code', code) : null;
      const index = digest === null ? -1 : draft.codes.findIndex((item) => item.digest === digest);
      if (index < 0) {
        if (!attempts && draft.failures.length >= 64) return { result: 'throttled' as const };
        if (attempts) attempts.at.push(now);
        else draft.failures.push({ peer: peerDigest, at: [now] });
        return { result: 'invalid' as const };
      }
      if (draft.sessions.length >= MAX_SESSIONS) return { result: 'full' as const };
      const [usedCode] = draft.codes.splice(index, 1);
      if (!usedCode) throw new ProtocolFault('STORAGE_UNAVAILABLE');
      const expiresAt = now + SESSION_LIFETIME_MS;
      const sessionDigest = credentialDigest('session', sessionToken);
      draft.sessions.push({ id: sessionId, digest: sessionDigest, scope: usedCode.scope, issuedAt: now, expiresAt });
      return { result: 'ok' as const, expiresAt, sessionDigest };
    });
    if (outcome.result === 'throttled' || outcome.result === 'full') throw new ProtocolFault('BUSY');
    if (outcome.result === 'invalid') throw new ProtocolFault('UNAUTHENTICATED');
    return { sessionToken, session: { sessionId, expiresAt: outcome.expiresAt,
      csrfToken: this.store.csrfFor(outcome.sessionDigest) } };
  }

  authenticateBrowser(sessionToken: string): BrowserPrincipal | null {
    const state = this.store.snapshot();
    if (typeof sessionToken !== 'string' || !sessionPattern.test(sessionToken)) return null;
    const digest = credentialDigest('session', sessionToken);
    const session = state.sessions.find((item) => item.digest === digest && item.expiresAt > this.store.now());
    if (!session) return null;
    const workspaceRoots = session.scope.flatMap((entry) => {
      const root = this.rootsByDigest.get(entry);
      return root === undefined ? [] : [root];
    });
    if (!workspaceRoots.length) return null;
    return Object.freeze({ kind: 'browser', principalId: session.id, sessionId: session.id,
      workspaceRoots: Object.freeze(workspaceRoots), expiresAt: session.expiresAt });
  }

  /** Same-origin GET /api/auth/session may retrieve this without rotating other tabs. */
  sessionInfo(sessionToken: string): BrowserSessionInfo {
    const session = this.authenticateBrowser(sessionToken);
    if (!session) throw new ProtocolFault('UNAUTHENTICATED');
    return { sessionId: session.sessionId, expiresAt: session.expiresAt,
      csrfToken: this.store.csrfFor(credentialDigest('session', sessionToken)) };
  }
  assertBrowserCsrf(sessionToken: string, csrfToken: string): BrowserPrincipal {
    const principal = this.authenticateBrowser(sessionToken);
    if (!principal) throw new ProtocolFault('UNAUTHENTICATED');
    const expected = this.store.csrfFor(credentialDigest('session', sessionToken));
    if (typeof csrfToken !== 'string' || !csrfPattern.test(csrfToken) || !equalToken(expected, csrfToken)) throw new ProtocolFault('FORBIDDEN');
    return principal;
  }
  async logout(sessionToken: string, csrfToken: string): Promise<void> {
    const session = this.assertBrowserCsrf(sessionToken, csrfToken);
    await this.store.transaction((draft, now) => {
      prune(draft, now);
      draft.sessions = draft.sessions.filter((item) => item.id !== session.sessionId);
    });
    this.publish({ kind: 'session', sessionId: session.sessionId });
  }
  /** Owner rotation invalidates every client, browser session, and pending code. */
  async rotateOwnerCredential(ownerCredential: string): Promise<{ ownerCredential: string }> {
    this.assertOwner(ownerCredential);
    const replacement = freshCredential('fo1');
    await this.store.rotateOwner(replacement, ownerCredential);
    this.publish({ kind: 'all' });
    return { ownerCredential: replacement };
  }

  safeStatus(ownerCredential: string): SafeAuthStatus {
    this.assertOwner(ownerCredential);
    const now = this.store.now();
    const state = this.store.snapshot();
    return { clientCount: state.clients.filter((item) => item.expiresAt > now).length,
      liveSessionCount: state.sessions.filter((item) => item.expiresAt > now).length,
      pendingCodeCount: state.codes.filter((item) => item.expiresAt > now).length };
  }
}
