import type { PromptOptions } from '@earendil-works/pi-coding-agent';

/** Native Pi 1.0 admission is a disposition, not a boolean acknowledgment. */
export type PiPromptDisposition = Parameters<NonNullable<PromptOptions['preflightResult']>>[0];

/** Fail closed if an extension or an incompatible SDK violates the public contract. */
export function piPromptDisposition(value: unknown): PiPromptDisposition | null {
  return value === 'started' || value === 'queued' || value === 'handled' ? value : null;
}
