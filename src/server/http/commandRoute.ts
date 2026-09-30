import type { Dispatcher } from '../../core/dispatch/Dispatcher';
import type { ProtocolResponse } from '../../shared/protocol/envelopes';
import type { ClientTickets } from '../auth/ClientTickets';
import type { AuthenticatedPrincipal } from './createHttpServer';

/** Transport only: authentication and ticket validation create the trusted context.
 * All method schemas, authorization, journal admission and wire DTOs remain in Dispatcher. */
export function createCommandRoute(dispatcher: Dispatcher, tickets: ClientTickets, serverEpoch: string) {
  return async (body: string, principal: AuthenticatedPrincipal, ticket: string, origin: string | null): Promise<ProtocolResponse> => {
    const identity = tickets.verify(ticket, principal, serverEpoch, origin);
    return dispatcher.dispatchJson(body, identity);
  };
}
