import { OwnershipConflict } from '../../core/ownership/OwnerLock';

export interface DesktopStartupFailure {
  readonly title: string;
  readonly message: string;
}

/** Fixed host guidance only: SDK messages, paths, owner diagnostics and keys are not presentation data. */
export function desktopStartupFailure(error: unknown): DesktopStartupFailure {
  return {
    title: 'Fate UI could not start this instance',
    message: error instanceof OwnershipConflict
      ? 'Fate UI could not acquire exclusive runtime ownership. A running or retained owner may still hold this profile. '
        + 'Use the already-running Fate UI window, or close all possible Fate UI owners normally before retrying. '
        + 'A profile whose previous owner stopped, for example after a crash or a forced quit, is recovered automatically at the next start. '
        + 'Do not delete ownership records. If the conflict remains after all possible owners have stopped, '
        + 'request explicit operator recovery review. A separate Chromium profile does not authorize a second Pi runtime for this Fate profile.'
      : 'Fate UI could not finish starting. This instance will close. Check your configuration before retrying. '
        + 'If the problem persists, request help reviewing startup and recovery state.',
  };
}

/** The existing desktop disposal coordinator remains the sole process-exit owner. */
export function desktopStartupExitCode(startupFailed: boolean, shutdownStatus: 'settled' | 'incomplete'): 0 | 1 {
  return !startupFailed && shutdownStatus === 'settled' ? 0 : 1;
}
