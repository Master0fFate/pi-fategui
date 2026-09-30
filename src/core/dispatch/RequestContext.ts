import { z } from 'zod';
import { millisecondsSchema, uuidSchema } from '../../shared/protocol/requestIds';

const contextBrand: unique symbol = Symbol('adapter-created RequestContext');
const registeredContexts = new WeakSet<object>();
const identitySchema = z.object({ principalId: uuidSchema, clientId: uuidSchema, expiresAt: millisecondsSchema }).strict();
type Identity = z.output<typeof identitySchema>;

/** Never parse this type from command JSON. Membership, permission and control are resolved live. */
export interface RequestContext extends Readonly<Identity> {
  readonly [contextBrand]: true;
  readonly adapter: 'local-ipc' | 'authenticated-server';
  readonly origin: string | null;
}

function register(identity: Identity, adapter: RequestContext['adapter'], origin: string | null): RequestContext {
  const context: RequestContext = Object.freeze({ ...identity, adapter, origin, [contextBrand]: true as const });
  registeredContexts.add(context);
  return context;
}

/** Trusted main-process adapter only, AFTER sender/main-frame validation. Does not grant permission. */
export function createLocalIpcContext(identity: Identity): RequestContext {
  return register(identitySchema.parse(identity), 'local-ipc', null);
}

/** Trusted server auth adapter only, AFTER credential/ticket/origin validation. Not a network enable switch. */
export function createAuthenticatedServerContext(identity: Identity, verifiedOrigin: string | null): RequestContext {
  const origin = z.string().min(1).max(512).url().nullable().parse(verifiedOrigin);
  return register(identitySchema.parse(identity), 'authenticated-server', origin);
}

/** Rejects copied objects, JSON, and compile-time assertions that did not use a trusted constructor. */
export function isAdapterCreatedContext(value: unknown): value is RequestContext {
  return typeof value === 'object' && value !== null && registeredContexts.has(value);
}
