import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BrowserAnnotation } from '../../shared/contracts/browser';
import type { BrowserService } from '../browser/BrowserService';
import { appendBrowserAnnotationContext, type BrowserAnnotationContextSource } from './BrowserAnnotationContext';
import {
  createPiBrowserTools,
  type BrowserToolActionOutput,
  type BrowserToolTab,
  type PiBrowserToolHost,
} from './PiBrowserTools';

const PAGE_SETTLE_TIMEOUT_MS = 4_000;
const PAGE_SETTLE_POLL_MS = 40;

export interface ActiveBrowserRoot {
  projectPath: string;
  sessionId: string;
}

export interface PiBrowserRuntimeIntegration {
  createTools(): ToolDefinition[];
  appendAnnotationContext(text: string, annotationIds: readonly string[]): Promise<string>;
  currentRoot(): ActiveBrowserRoot | null;
  setActiveRoot(root: ActiveBrowserRoot | null): void;
}

export class BrowserRuntimeBridge implements PiBrowserRuntimeIntegration, PiBrowserToolHost, BrowserAnnotationContextSource {
  private activeRoot: ActiveBrowserRoot | null = null;

  constructor(private readonly resolveService: () => BrowserService | null) {}

  createTools(): ToolDefinition[] {
    return createPiBrowserTools(() => this);
  }

  appendAnnotationContext(text: string, annotationIds: readonly string[]): Promise<string> {
    return appendBrowserAnnotationContext(text, annotationIds, this);
  }

  currentRoot(): ActiveBrowserRoot | null {
    return this.activeRoot ? { ...this.activeRoot } : null;
  }

  setActiveRoot(root: ActiveBrowserRoot | null): void {
    const previous = this.activeRoot;
    if (previous?.projectPath === root?.projectPath && previous?.sessionId === root?.sessionId) return;
    const service = this.resolveService();
    if (service && previous) {
      service.cancelAnnotationSelection();
      service.lease.release(previous.sessionId);
      service.endTask();
    }
    this.activeRoot = root ? { ...root } : null;
    this.syncService();
  }

  syncService(): void {
    const root = this.activeRoot;
    const service = this.resolveService();
    if (!root || !service) return;
    const lease = service.lease.getState();
    if (lease && lease.ownerSessionId !== root.sessionId) service.lease.release(lease.ownerSessionId);
    service.beginTask(root.sessionId);
    service.lease.acquire(root.sessionId);
  }

  async resolveAnnotations(ids: readonly string[]): Promise<readonly BrowserAnnotation[]> {
    const service = this.resolveService();
    return service ? service.resolveAnnotations(ids) : [];
  }

  async navigate(input: Parameters<PiBrowserToolHost['navigate']>[0]) {
    const service = await this.serviceFor(input.sessionId);
    const tabId = activeTabId(service);
    await service.navigate(tabId, input.url, 'agent', input.signal);
    await waitForPage(service, tabId, input.signal);
    return service.snapshot(tabId);
  }

  async snapshot(input: Parameters<PiBrowserToolHost['snapshot']>[0]) {
    const service = await this.serviceFor(input.sessionId);
    const tabId = activeTabId(service);
    return service.snapshot(tabId, {
      mode: input.mode,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      ...(input.query ? { query: input.query } : {}),
    });
  }

  async click(input: Parameters<PiBrowserToolHost['click']>[0]): Promise<BrowserToolActionOutput> {
    const service = await this.serviceFor(input.sessionId);
    const tabId = activeTabId(service);
    const action = await service.click(tabId, { ref: input.ref, ...(input.signal ? { signal: input.signal } : {}) });
    await waitForPage(service, tabId, input.signal);
    return { action, snapshot: await service.snapshot(tabId) };
  }

  async type(input: Parameters<PiBrowserToolHost['type']>[0]): Promise<BrowserToolActionOutput> {
    const service = await this.serviceFor(input.sessionId);
    const tabId = activeTabId(service);
    const action = await service.type(tabId, {
      ref: input.ref,
      text: input.text,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await waitForPage(service, tabId, input.signal);
    return { action, snapshot: await service.snapshot(tabId) };
  }

  async press(input: Parameters<PiBrowserToolHost['press']>[0]): Promise<BrowserToolActionOutput> {
    const service = await this.serviceFor(input.sessionId);
    const tabId = activeTabId(service);
    const action = await service.press(tabId, input.key, input.signal);
    await waitForPage(service, tabId, input.signal);
    return { action, snapshot: await service.snapshot(tabId) };
  }

  async scroll(input: Parameters<PiBrowserToolHost['scroll']>[0]): Promise<BrowserToolActionOutput> {
    const service = await this.serviceFor(input.sessionId);
    const tabId = activeTabId(service);
    const action = await service.scroll(tabId, input.deltaX, input.deltaY, input.signal);
    await waitForPage(service, tabId, input.signal);
    return { action, snapshot: await service.snapshot(tabId) };
  }

  async tabs(input: Parameters<PiBrowserToolHost['tabs']>[0]): Promise<readonly BrowserToolTab[]> {
    const service = await this.serviceFor(input.sessionId);
    const state = service.getState();
    return state.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.id === state.activeTabId,
    }));
  }

  private async serviceFor(sessionId: string): Promise<BrowserService> {
    const root = this.activeRoot;
    if (!root || root.sessionId !== sessionId) {
      throw new Error('The active root session does not own the built-in browser. Switch back to that session or take over manually.');
    }
    const service = this.resolveService();
    if (!service) throw new Error('Open the Browser workspace for the active trusted project before using browser tools.');
    service.beginTask(root.sessionId);
    const lease = service.lease.getState();
    if (lease?.ownerSessionId !== root.sessionId) {
      if (lease) service.lease.release(lease.ownerSessionId);
      service.lease.acquire(root.sessionId);
    }
    service.lease.assertOwner(root.sessionId);
    if (!service.getState().activeTabId) await service.ensureTab();
    return service;
  }
}

function activeTabId(service: BrowserService): string {
  const tabId = service.getState().activeTabId;
  if (!tabId) throw new Error('No Fate-managed browser tab is active.');
  return tabId;
}

async function waitForPage(service: BrowserService, tabId: string, signal?: AbortSignal): Promise<void> {
  const started = Date.now();
  let observedLoading = false;
  while (Date.now() - started < PAGE_SETTLE_TIMEOUT_MS) {
    if (signal?.aborted) throw new DOMException('Browser action aborted.', 'AbortError');
    const tab = service.getState().tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error('The active browser tab closed while Fate UI waited for the page.');
    observedLoading ||= tab.loading;
    if (!tab.loading && (observedLoading || Date.now() - started >= 120)) return;
    await abortableDelay(PAGE_SETTLE_POLL_MS, signal);
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Browser action aborted.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    timeout.unref?.();
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new DOMException('Browser action aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
