import type { PiSdkAdapter } from '../../../src/main/pi/PiRuntimeService';
import { createFateCore } from '../../../src/core/createFateCore';
import { startNodeServerWithFactory } from '../../../src/server/compose';
import { MultiProjectPiRuntime } from '../../../src/main/pi/MultiProjectPiRuntime';

/** Test-only injection; the production entry has no adapter selector. */
export function startTestNodeServer(input: unknown, adapter: PiSdkAdapter, shutdownBudgetMs?: number) {
  return startNodeServerWithFactory(input, (options) => createFateCore({ ...options, adapter,
    // Deterministic fake turns must not start the optional real-model title helper.
    createRuntime: (dependencies) => new MultiProjectPiRuntime({ ...dependencies,
      createSessionTitleGenerator: () => ({ generate: async () => null }) }),
    ...(shutdownBudgetMs === undefined ? {} : { shutdownBudgetMs }) }));
}
