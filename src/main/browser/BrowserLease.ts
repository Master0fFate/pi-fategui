import { BrowserError } from './BrowserErrors';

export interface BrowserLeaseState {
  ownerSessionId: string;
  acquiredAt: number;
}

export class BrowserLease {
  private state: BrowserLeaseState | null = null;

  acquire(ownerSessionId: string): BrowserLeaseState {
    const owner = ownerSessionId.trim();
    if (!owner || owner.length > 500) throw new BrowserError('ACTION_BLOCKED', 'A bounded root session id is required for browser control.');
    if (this.state && this.state.ownerSessionId !== owner) {
      throw new BrowserError('ACTION_BLOCKED', 'The live browser is leased to another root session.');
    }
    this.state ??= { ownerSessionId: owner, acquiredAt: Date.now() };
    return { ...this.state };
  }

  assertOwner(ownerSessionId: string): void {
    if (!this.state || this.state.ownerSessionId !== ownerSessionId) {
      throw new BrowserError('ACTION_BLOCKED', 'The active root session does not own the browser lease.');
    }
  }

  release(ownerSessionId: string): boolean {
    if (this.state?.ownerSessionId !== ownerSessionId) return false;
    this.state = null;
    return true;
  }

  getState(): BrowserLeaseState | null {
    return this.state ? { ...this.state } : null;
  }
}
