const MAX_NATIVE_TIMEOUT_MS = 2_147_483_647;

export interface CancelableTimer {
  cancel(): void;
}

/** Schedule any safe JavaScript duration without Node's 32-bit setTimeout overflow. */
export function scheduleLongTimeout(callback: () => void, delayMs: number): CancelableTimer {
  const deadline = Date.now() + Math.max(0, delayMs);
  let handle: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const arm = () => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      callback();
      return;
    }
    handle = setTimeout(arm, Math.min(remaining, MAX_NATIVE_TIMEOUT_MS));
  };

  arm();
  return {
    cancel: () => {
      cancelled = true;
      if (handle) clearTimeout(handle);
      handle = undefined;
    },
  };
}
