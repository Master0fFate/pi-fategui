export type BrowserErrorCode =
  | 'ACTION_BLOCKED'
  | 'CDP_UNAVAILABLE'
  | 'INVALID_URL'
  | 'ORIGIN_NOT_GRANTED'
  | 'PRIVATE_NETWORK_BLOCKED'
  | 'STALE_SNAPSHOT'
  | 'TAB_NOT_FOUND'
  | 'UNSUPPORTED_ACTION';

export class BrowserError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'BrowserError';
  }
}
