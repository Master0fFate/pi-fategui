import type { CoreShutdownResult } from '../core/lifecycle/CoreLifecycle';

/** Host transports may own writers too (manual shells). Fence first, request
 * all transport stops, and retain core/profile/checkout ownership until they
 * actually settle. A caller's grace deadline is not a resource release.
 */
export function createHostShutdown(options: {
  readonly fence: () => void;
  readonly stopTransports: () => Promise<void>;
  readonly stopCore: () => Promise<CoreShutdownResult>;
  readonly coreSettlement: () => Promise<void> | null;
  readonly budgetMs?: number;
}): { stop(): Promise<CoreShutdownResult>; settled(): Promise<void> | null } {
  const budget = options.budgetMs ?? 4_000;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 60_000) throw new Error('Invalid host shutdown budget.');
  let result: Promise<CoreShutdownResult> | null = null;
  let settlement: Promise<void> | null = null;
  return {
    settled: () => settlement,
    stop: () => {
      if (result) return result;
      // Reserve before callbacks: a synchronous shutdown observer may reenter.
      let report!: (value: CoreShutdownResult) => void;
      result = new Promise<CoreShutdownResult>((resolve) => { report = resolve; });
      let fenceFailed = false;
      let fenceFailure: unknown;
      try { options.fence(); } catch (error) { fenceFailed = true; fenceFailure = error; }
      let transports: Promise<void>;
      // Start transport fencing NOW, not in a later microtask after a buffered
      // request body could otherwise reach an administrative mutation.
      try { transports = options.stopTransports(); }
      catch (error) { transports = Promise.reject(error); }
      settlement = transports.then(async () => {
        if (fenceFailed) throw fenceFailure;
        const core = await options.stopCore();
        if (core.status !== 'settled') {
          const actual = options.coreSettlement();
          if (!actual) throw new Error('Core shutdown settlement is unavailable; ownership must remain held.');
          await actual;
        }
      });
      const timer = setTimeout(() => report({ status: 'incomplete', reason: 'timeout' }), budget);
      void settlement.then(() => { clearTimeout(timer); report({ status: 'settled' }); },
        () => { clearTimeout(timer); report({ status: 'incomplete', reason: 'failed' }); });
      return result;
    },
  };
}
