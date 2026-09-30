import { z } from 'zod';

export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_REQUEST_AGE_MS = 24 * 60 * 60 * 1_000;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
/** Canonical, random v4 IDs; no paths, caller names, or provider identifiers. */
export const uuidSchema = z.string().regex(new RegExp(`^${uuidPattern}$`, 'u'));
export const millisecondsSchema = z.number().int().nonnegative().safe();
export const mutationRequestIdSchema = z.string().max(MAX_REQUEST_ID_LENGTH)
  .regex(new RegExp(`^${uuidPattern}\\.(?:0|[1-9][0-9]{0,15})\\.${uuidPattern}$`, 'u'))
  .refine((id) => Number.isSafeInteger(Number(id.split('.')[1])));
export const requestIdSchema = z.union([uuidSchema, mutationRequestIdSchema]);

export function createServerEpoch(): string {
  return uuidSchema.parse(globalThis.crypto.randomUUID());
}

/** Create only for a NEW action. An uncertain retry must reuse the original full envelope. */
export function createMutationIdentity(serverEpoch: string, issuedAt = Date.now()) {
  const epoch = uuidSchema.parse(serverEpoch);
  const time = millisecondsSchema.parse(issuedAt);
  return Object.freeze({ serverEpoch: epoch, issuedAt: time, requestId: mutationRequestIdSchema.parse(`${epoch}.${time}.${createServerEpoch()}`) });
}

export function mutationIdentityMatches(request: { requestId: string; serverEpoch: string; issuedAt: number }): boolean {
  if (!mutationRequestIdSchema.safeParse(request.requestId).success) return false;
  const [epoch, time] = request.requestId.split('.');
  return epoch === request.serverEpoch && time === String(request.issuedAt);
}

/** Identity/schema validation is separate from the host clock, which is rechecked at execution. */
export function validateRequestClock(
  request: { method: string; serverEpoch: string; issuedAt: number },
  serverEpoch: string,
  now: number,
): 'SERVER_RESTARTED' | 'CLOCK_SKEW' | null {
  if (request.serverEpoch !== serverEpoch) return 'SERVER_RESTARTED';
  if (!millisecondsSchema.safeParse(now).success || !millisecondsSchema.safeParse(request.issuedAt).success) return 'CLOCK_SKEW';
  const mutation = request.method === 'runtime.prompt' || request.method === 'runtime.abort' || request.method === 'session.select';
  if (mutation && (request.issuedAt < now - MAX_REQUEST_AGE_MS || request.issuedAt > now + MAX_CLOCK_SKEW_MS)) return 'CLOCK_SKEW';
  return null;
}
