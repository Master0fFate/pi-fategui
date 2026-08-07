import { createHash } from 'node:crypto';
import { BrowserError } from './BrowserErrors';

export interface BrowserElementFingerprint {
  tagName: string;
  role: string | null;
  accessibleName: string | null;
  stableAttributes: Record<string, string>;
  nearbyTextHash: string;
  ancestorHash: string;
}

export interface BrowserElementHandle {
  tabId: string;
  targetId: string;
  sessionId: string;
  frameId: string;
  frameOrigin: string;
  documentEpoch: number;
  frameEpoch: number;
  loaderId: string;
  backendNodeId: number;
  fingerprint: BrowserElementFingerprint;
}

export interface RefResolutionContext {
  tabId: string;
  documentEpoch: number;
  expectedOrigin?: string;
  expectedTargetId?: string;
  currentLoaderId?: string;
}

const MAX_RETAINED_REFS = 12_000;

export class BrowserRefRegistry {
  private nextRef = 1;
  private readonly refs = new Map<string, BrowserElementHandle>();
  private readonly currentNodeRefs = new Map<string, string>();
  private readonly latestNodeRefs = new Map<string, string>();
  private readonly tabEpochs = new Map<string, number>();

  beginDocument(tabId: string, documentEpoch: number): void {
    const current = this.tabEpochs.get(tabId);
    if (current !== undefined && documentEpoch < current) {
      throw new BrowserError('STALE_SNAPSHOT', 'Document epochs cannot move backwards.');
    }
    if (current === documentEpoch) return;
    this.tabEpochs.set(tabId, documentEpoch);
    for (const key of this.currentNodeRefs.keys()) {
      if (key.startsWith(`${tabId}:`)) this.currentNodeRefs.delete(key);
    }
    for (const key of this.latestNodeRefs.keys()) {
      if (key.startsWith(`${tabId}:`)) this.latestNodeRefs.delete(key);
    }
    this.trimRetainedRefs();
  }

  register(handle: BrowserElementHandle): string {
    const currentEpoch = this.tabEpochs.get(handle.tabId);
    if (currentEpoch === undefined) this.beginDocument(handle.tabId, handle.documentEpoch);
    else if (currentEpoch !== handle.documentEpoch) {
      throw new BrowserError('STALE_SNAPSHOT', 'Cannot register an element from a stale document.');
    }

    const nodeKey = [
      handle.tabId,
      handle.documentEpoch,
      handle.targetId,
      handle.sessionId || 'root',
      handle.frameId,
      handle.loaderId,
      handle.backendNodeId,
    ].join(':');
    const looseNodeKey = `${handle.tabId}:${handle.documentEpoch}:${handle.frameId}:${handle.backendNodeId}`;
    const existing = this.currentNodeRefs.get(nodeKey);
    if (existing) {
      const existingHandle = this.refs.get(existing);
      if (existingHandle && fingerprintsMatch(existingHandle.fingerprint, handle.fingerprint)) {
        this.latestNodeRefs.set(looseNodeKey, existing);
        return existing;
      }
      if (existingHandle) this.refs.delete(existing);
    }

    const ref = `e${this.nextRef++}`;
    this.refs.set(ref, cloneHandle(handle));
    this.currentNodeRefs.set(nodeKey, ref);
    this.latestNodeRefs.set(looseNodeKey, ref);
    this.trimRetainedRefs();
    return ref;
  }

  refForNode(tabId: string, documentEpoch: number, frameId: string, backendNodeId: number): string | undefined {
    return this.latestNodeRefs.get(`${tabId}:${documentEpoch}:${frameId}:${backendNodeId}`);
  }

  resolve(ref: string, context: RefResolutionContext): BrowserElementHandle {
    const handle = this.refs.get(ref);
    if (!handle) throw new BrowserError('STALE_SNAPSHOT', `Element ref ${ref} is unknown or expired.`);
    if (handle.tabId !== context.tabId || handle.documentEpoch !== context.documentEpoch) {
      throw new BrowserError('STALE_SNAPSHOT', `Element ref ${ref} belongs to a different document.`);
    }
    if (context.expectedOrigin && handle.frameOrigin !== context.expectedOrigin) {
      throw new BrowserError('STALE_SNAPSHOT', `Element ref ${ref} no longer belongs to the expected origin.`);
    }
    if (context.expectedTargetId && handle.targetId !== context.expectedTargetId) {
      throw new BrowserError('STALE_SNAPSHOT', `Element ref ${ref} belongs to a different browser target.`);
    }
    if (context.currentLoaderId && handle.loaderId !== context.currentLoaderId) {
      throw new BrowserError('STALE_SNAPSHOT', `Element ref ${ref} belongs to a replaced frame document.`);
    }
    return cloneHandle(handle);
  }

  invalidateTab(tabId: string, nextDocumentEpoch: number): void {
    this.beginDocument(tabId, nextDocumentEpoch);
  }

  clearTab(tabId: string): void {
    this.tabEpochs.delete(tabId);
    for (const [ref, handle] of this.refs) if (handle.tabId === tabId) this.refs.delete(ref);
    for (const key of this.currentNodeRefs.keys()) if (key.startsWith(`${tabId}:`)) this.currentNodeRefs.delete(key);
    for (const key of this.latestNodeRefs.keys()) if (key.startsWith(`${tabId}:`)) this.latestNodeRefs.delete(key);
  }

  private trimRetainedRefs(): void {
    while (this.refs.size > MAX_RETAINED_REFS) {
      const oldest = this.refs.keys().next().value as string | undefined;
      if (!oldest) break;
      this.refs.delete(oldest);
      for (const [nodeKey, ref] of this.currentNodeRefs) if (ref === oldest) this.currentNodeRefs.delete(nodeKey);
      for (const [nodeKey, ref] of this.latestNodeRefs) if (ref === oldest) this.latestNodeRefs.delete(nodeKey);
    }
  }
}

export function fingerprintHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function fingerprintsMatch(expected: BrowserElementFingerprint, actual: BrowserElementFingerprint): boolean {
  if (expected.tagName !== actual.tagName || expected.role !== actual.role) return false;
  if (expected.accessibleName !== actual.accessibleName) return false;
  const expectedAttributes = Object.entries(expected.stableAttributes).sort();
  const actualAttributes = Object.entries(actual.stableAttributes).sort();
  return JSON.stringify(expectedAttributes) === JSON.stringify(actualAttributes)
    && expected.nearbyTextHash === actual.nearbyTextHash
    && expected.ancestorHash === actual.ancestorHash;
}

function cloneHandle(handle: BrowserElementHandle): BrowserElementHandle {
  return {
    ...handle,
    fingerprint: { ...handle.fingerprint, stableAttributes: { ...handle.fingerprint.stableAttributes } },
  };
}
