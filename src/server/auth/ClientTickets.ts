import { createHash, randomBytes } from 'node:crypto';
import { createAuthenticatedServerContext, type RequestContext } from '../../core/dispatch/RequestContext';
import { ProtocolFault } from '../../shared/protocol/errors';
import { uuidSchema } from '../../shared/protocol/requestIds';
import type { AuthenticatedPrincipal } from '../http/createHttpServer';
import type { AuthService } from './AuthService';

interface TicketRecord {
  readonly digest: string;
  readonly connectionId: string;
  readonly principalId: string;
  readonly kind: AuthenticatedPrincipal['kind'];
  readonly origin: string | null;
  readonly serverEpoch: string;
  readonly expiresAt: number;
  readonly workspaceRoots: readonly string[];
}
const MAX_TICKETS = 8;
const TICKET_LIFETIME_MS = 60 * 60_000;
const tokenPattern = /^ft1_[A-Za-z0-9_-]{43}$/u;
const digest = (token: string): string => createHash('sha256').update('fate-client-ticket-v1:').update(token).digest('hex');

/** One ticket per authenticated, first-frame-checked live event connection. */
export class ClientTickets {
  private readonly records = new Map<string, TicketRecord>();
  private readonly contexts = new WeakMap<RequestContext, TicketRecord>();
  private readonly unsubscribe: () => void;
  constructor(auth: AuthService, private readonly now: () => number = Date.now) {
    this.unsubscribe = auth.subscribeRevocations((event) => {
      if (event.kind === 'all') { this.records.clear(); return; }
      for (const [hash, record] of this.records) {
        if (event.kind === 'client'
          ? record.kind === 'client' && record.principalId === event.clientId
          : record.kind === 'browser' && record.principalId === event.sessionId) {
          this.records.delete(hash);
        }
      }
    });
  }
  issue(principal: AuthenticatedPrincipal, connectionId: string, serverEpoch: string, origin: string | null): string {
    uuidSchema.parse(connectionId); uuidSchema.parse(serverEpoch);
    const now = this.now();
    if (principal.expiresAt <= now) throw new ProtocolFault('UNAUTHENTICATED');
    this.revokeConnection(connectionId);
    if (this.records.size >= MAX_TICKETS) throw new ProtocolFault('BUSY');
    const token = `ft1_${randomBytes(32).toString('base64url')}`;
    const record: TicketRecord = Object.freeze({ digest: digest(token), connectionId, principalId: principal.principalId,
      kind: principal.kind, origin, serverEpoch, expiresAt: Math.min(principal.expiresAt, now + TICKET_LIFETIME_MS),
      workspaceRoots: Object.freeze([...principal.workspaceRoots]) });
    this.records.set(record.digest, record);
    return token;
  }
  verify(token: string, principal: AuthenticatedPrincipal, serverEpoch: string, origin: string | null): RequestContext {
    if (!tokenPattern.test(token)) throw new ProtocolFault('UNAUTHENTICATED');
    const record = this.records.get(digest(token));
    if (!record || record.serverEpoch !== serverEpoch || record.origin !== origin || record.kind !== principal.kind
      || record.principalId !== principal.principalId || record.expiresAt <= this.now() || principal.expiresAt <= this.now()) {
      throw new ProtocolFault('UNAUTHENTICATED');
    }
    const context = createAuthenticatedServerContext({ principalId: record.principalId,
      clientId: record.connectionId, expiresAt: Math.min(record.expiresAt, principal.expiresAt) }, origin);
    this.contexts.set(context, record);
    return context;
  }
  isLive(context: RequestContext, now = this.now()): boolean {
    const record = this.contexts.get(context);
    return Boolean(record && context.adapter === 'authenticated-server' && record.expiresAt > now
      && this.records.get(record.digest) === record && context.clientId === record.connectionId
      && context.principalId === record.principalId);
  }
  isMember(context: RequestContext, root: string): boolean {
    const record = this.contexts.get(context);
    return this.isLive(context) && Boolean(record?.workspaceRoots.includes(root));
  }
  revokeConnection(connectionId: string): void {
    for (const [hash, record] of this.records) if (record.connectionId === connectionId) this.records.delete(hash);
  }
  close(): void { this.records.clear(); this.unsubscribe(); }
}
