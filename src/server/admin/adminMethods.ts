import { z } from 'zod';
import { ProtocolFault } from '../../shared/protocol/errors';
import { AuthService } from '../auth/AuthService';
import { providerLoginStartInputSchema, providerLoginRespondInputSchema, providerLoginStateSchema } from '../../shared/contracts/ipc';
import type { ProviderAdminPort } from './providerMethods';

const ownerToken = z.string().regex(/^fo1_[A-Za-z0-9_-]{43}$/u);
const clientToken = z.string().regex(/^fc1_[A-Za-z0-9_-]{43}$/u);
const bootstrapToken = z.string().regex(/^fb1_[A-Za-z0-9_-]{43}$/u);
const positiveTime = z.number().int().safe().nonnegative();
const clientId = z.string().uuid();

/** Fixed, typed catalog. No reflected names, role field, paths for file access,
 * shell command, arbitrary JS, provider token, or generic host invocation. */
export const adminRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('auth.bootstrap.create'), input: z.object({}).strict() }).strict(),
  z.object({ method: z.literal('auth.bootstrap.revoke'), input: z.object({ code: bootstrapToken }).strict() }).strict(),
  z.object({ method: z.literal('auth.status'), input: z.object({}).strict() }).strict(),
  z.object({ method: z.literal('client.issue'), input: z.object({ workspaceRoots: z.array(z.string().min(1).max(32_768)).min(1).max(8) }).strict() }).strict(),
  z.object({ method: z.literal('client.revoke'), input: z.object({ clientId }).strict() }).strict(),
  z.object({ method: z.literal('owner.rotate'), input: z.object({}).strict() }).strict(),
  z.object({ method: z.literal('provider.initialize'), input: z.object({}).strict() }).strict(),
  z.object({ method: z.literal('provider.state'), input: z.object({}).strict() }).strict(),
  z.object({ method: z.literal('provider.start'), input: providerLoginStartInputSchema }).strict(),
  z.object({ method: z.literal('provider.respond'), input: providerLoginRespondInputSchema }).strict(),
  z.object({ method: z.literal('provider.cancel'), input: z.object({}).strict() }).strict(),
]);
export type AdminRequest = z.output<typeof adminRequestSchema>;

export const adminResponseSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('auth.bootstrap.create'), result: z.object({ code: bootstrapToken, expiresAt: positiveTime }).strict() }).strict(),
  z.object({ method: z.literal('auth.bootstrap.revoke'), result: z.object({ revoked: z.boolean() }).strict() }).strict(),
  z.object({ method: z.literal('auth.status'), result: z.object({ clientCount: z.number().int().min(0).max(128),
    liveSessionCount: z.number().int().min(0).max(32), pendingCodeCount: z.number().int().min(0).max(64) }).strict() }).strict(),
  z.object({ method: z.literal('client.issue'), result: z.object({ clientId, credential: clientToken, expiresAt: positiveTime }).strict() }).strict(),
  z.object({ method: z.literal('client.revoke'), result: z.object({ revoked: z.boolean() }).strict() }).strict(),
  z.object({ method: z.literal('owner.rotate'), result: z.object({ ownerCredential: ownerToken }).strict() }).strict(),
  z.object({ method: z.literal('provider.initialize'), result: providerLoginStateSchema }).strict(),
  z.object({ method: z.literal('provider.state'), result: providerLoginStateSchema }).strict(),
  z.object({ method: z.literal('provider.start'), result: providerLoginStateSchema }).strict(),
  z.object({ method: z.literal('provider.respond'), result: providerLoginStateSchema }).strict(),
  z.object({ method: z.literal('provider.cancel'), result: providerLoginStateSchema }).strict(),
]);
export type AdminResponse = z.output<typeof adminResponseSchema>;
function safeResult(value: unknown): AdminResponse {
  const parsed = adminResponseSchema.safeParse(value);
  if (!parsed.success) throw new ProtocolFault('INTERNAL_ERROR');
  return parsed.data;
}

/** T33's HTTP adapter must pass actual headers, never caller-declared roles.
 * An omitted Origin is not authorization: only the host owner secret is. */
export interface AdminAuthority {
  readonly ownerCredential: string;
  readonly origin: string | null;
  readonly cookiePresented: boolean;
}

export async function executeAdminMethod(service: AuthService, authority: AdminAuthority, rawRequest: unknown,
  provider?: ProviderAdminPort): Promise<AdminResponse> {
  service.authorizeAdmin(authority);
  const parsed = adminRequestSchema.safeParse(rawRequest);
  if (!parsed.success) throw new ProtocolFault('INVALID_REQUEST');
  const request = parsed.data;
  switch (request.method) {
    case 'auth.bootstrap.create': return safeResult({ method: request.method,
      result: await service.createBootstrapCode(authority.ownerCredential) });
    case 'auth.bootstrap.revoke': return safeResult({ method: request.method,
      result: await service.revokeBootstrapCode(authority.ownerCredential, request.input.code) });
    case 'auth.status': return safeResult({ method: request.method,
      result: service.safeStatus(authority.ownerCredential) });
    case 'client.issue': return safeResult({ method: request.method,
      result: await service.issueClientCredential(authority.ownerCredential, request.input.workspaceRoots) });
    case 'client.revoke': return safeResult({ method: request.method,
      result: await service.revokeClientCredential(authority.ownerCredential, request.input.clientId) });
    case 'owner.rotate': return safeResult({ method: request.method,
      result: await service.rotateOwnerCredential(authority.ownerCredential) });
    case 'provider.initialize': {
      if (!provider) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
      return safeResult({ method: request.method, result: await provider.initialize() });
    }
    case 'provider.state': {
      if (!provider) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
      return safeResult({ method: request.method, result: provider.state() });
    }
    case 'provider.start': {
      if (!provider) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
      return safeResult({ method: request.method, result: await provider.start(request.input) });
    }
    case 'provider.respond': {
      if (!provider) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
      return safeResult({ method: request.method, result: provider.respond(request.input) });
    }
    case 'provider.cancel': {
      if (!provider) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
      return safeResult({ method: request.method, result: provider.cancel() });
    }
  }
}
