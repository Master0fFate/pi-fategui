import type { MultiProjectPiRuntime } from '../../main/pi/MultiProjectPiRuntime';
import { PiDesktopError } from '../../main/pi/errors';
import { providerLoginStateSchema, type ProviderLoginStartInput, type ProviderLoginRespondInput,
  type ProviderLoginState, type RuntimeState } from '../../shared/contracts/ipc';
import { ProtocolFault } from '../../shared/protocol/errors';

/** Host-only API. It never serializes a Pi runtime, project, session or secret store. */
export interface ProviderAdminPort {
  initialize(): Promise<ProviderLoginState>;
  state(): ProviderLoginState;
  start(input: ProviderLoginStartInput): Promise<ProviderLoginState>;
  respond(input: ProviderLoginRespondInput): ProviderLoginState;
  cancel(): ProviderLoginState;
}
function projection(state: RuntimeState): ProviderLoginState {
  const parsed = providerLoginStateSchema.safeParse(state.providerLogin);
  if (!parsed.success) throw new ProtocolFault('INTERNAL_ERROR');
  return parsed.data;
}
function failure(error: unknown): never {
  // Never return SDK errors: they can contain a supplied credential or callback URL.
  if (error instanceof ProtocolFault) throw error;
  if (error instanceof PiDesktopError && error.normalized.code === 'RUN_ACTIVE') throw new ProtocolFault('BUSY');
  if (error instanceof PiDesktopError && error.normalized.code === 'INVALID_REQUEST') throw new ProtocolFault('INVALID_REQUEST');
  throw new ProtocolFault('INTERNAL_ERROR');
}
/** Captured once at host composition. Focus changes cannot move an active login. */
export function createProviderAdminPort(runtime: MultiProjectPiRuntime): ProviderAdminPort {
  const service = runtime.hostProviderLoginService();
  const assertIdle = () => { if (runtime.hasHostActiveWork()) throw new ProtocolFault('BUSY'); };
  return Object.freeze({
    async initialize() {
      try { return projection(await service.initializeProviderLogin()); } catch (error) { return failure(error); }
    },
    state() { return projection(service.getState(false)); },
    async start(input: ProviderLoginStartInput) {
      assertIdle();
      try { return projection(await service.startProviderLogin(input, assertIdle)); } catch (error) { return failure(error); }
    },
    respond(input: ProviderLoginRespondInput) {
      assertIdle();
      try { return projection(service.respondProviderLogin(input)); } catch (error) { return failure(error); }
    },
    cancel() { try { return projection(service.cancelProviderLogin()); } catch (error) { return failure(error); } },
  });
}
