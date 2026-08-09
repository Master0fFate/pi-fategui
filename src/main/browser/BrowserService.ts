import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import path from 'node:path';
import {
  app,
  dialog,
  WebContentsView,
  type BrowserWindow,
  type DownloadItem,
  type Rectangle,
  type Session,
  type WebContents,
} from 'electron';
import type {
  BrowserActionResult,
  BrowserAnnotation,
  BrowserBounds,
  BrowserConsequence,
  BrowserControlLevel,
  BrowserEvent,
  BrowserOriginGrant,
  BrowserSnapshotMode,
  ProposedBrowserAction,
  BrowserState,
  BrowserUiMode,
  SemanticPageSnapshot,
} from '../../shared/contracts/browser';
import { BrowserActionExecutor, type BrowserConfirmationHandler } from './BrowserActionExecutor';
import { AnnotationService } from './AnnotationService';
import { BrowserAnnotationOverlay } from './BrowserAnnotationOverlay';
import { parseBrowserAddress } from './BrowserAddress';
import { BrowserAnnotationRepository } from './BrowserAnnotationRepository';
import { CdpClient } from './CdpClient';
import { BrowserError } from './BrowserErrors';
import { BrowserLease } from './BrowserLease';
import { BrowserActionGate, BrowserPolicy, inspectBrowserUrl, isCloudMetadataHostname, isPrivateNetworkHostname } from './BrowserPolicy';
import { BrowserRefRegistry } from './BrowserRefRegistry';
import { isRestorableBrowserUrl } from './BrowserHistoryRepository';
import { BrowserNetworkProxy, resolveTarget } from './BrowserNetworkProxy';
import { BrowserPointerOverlay } from './BrowserPointerOverlay';
import { LocalPageRegistry } from './LocalPageRegistry';
import { redactPotentialSecretText, redactSnapshotUrl, SemanticSnapshotEngine } from './SemanticSnapshotEngine';

interface AgentNavigationGuard {
  token: symbol;
  allowedOrigins: Set<string>;
  dispatching: boolean;
  restrictRequests: boolean;
}

type BrowserNavigationSource = 'user' | 'agent' | 'page';

interface BrowserTab {
  id: string;
  profileId: string;
  view: WebContentsView;
  cdp: CdpClient;
  snapshots: SemanticSnapshotEngine;
  actions: BrowserActionExecutor;
  annotationService: AnnotationService;
  annotationOverlay: BrowserAnnotationOverlay;
  pointerOverlay: BrowserPointerOverlay;
  gate: BrowserActionGate;
  humanNetworkOrigins: Set<string>;
  documentEpoch: number;
  pageRevision: number;
  semanticAvailable: boolean;
}

export type BrowserAppShortcut = 'focus-address' | 'toggle-browser' | 'open-palette' | 'pause-browser';

export interface BrowserAnnotationOwner {
  projectPath: string;
  sessionId: string;
}

export interface BrowserServiceOptions {
  canonicalProjectPath: string;
  confirmAction?: BrowserConfirmationHandler;
  annotationOwner?: () => BrowserAnnotationOwner | null;
  onAppShortcut?: (shortcut: BrowserAppShortcut) => void;
  onPaused?: () => void;
  /** Notified with every restorable committed navigation so the host can persist the last URL. */
  onNavigated?: (url: string) => void;
  /** Page to land on when the main tab is (re)opened without an explicit URL. */
  restoreUrl?: string | null;
}

export type BrowserEventSink = (event: BrowserEvent) => void;

export class BrowserService {
  readonly policy = new BrowserPolicy();
  readonly lease = new BrowserLease();
  readonly annotations = new BrowserAnnotationRepository();
  private readonly refs = new BrowserRefRegistry();
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly networkProxy = new BrowserNetworkProxy(this.policy, (origin) => this.allowsPrivateNetworkAuthority(origin));
  private readonly localPages: LocalPageRegistry;
  private readonly tabCreations = new Map<string, Promise<void>>();
  private readonly configuredSessions = new Map<Session, { download: (event: Electron.Event, item: DownloadItem, webContents: WebContents) => void }>();
  private activeTabId: string | null = null;
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private visible = false;
  private readonly viewBlockers = new Set<string>();
  private paused = true;
  private mode: BrowserUiMode = 'agent';
  private actionController = new AbortController();
  private annotationController: AbortController | null = null;
  private annotationLoop = 0;
  private readonly activeAgentNavigations = new Set<string>();
  private readonly activeUserNavigations = new Set<string>();
  private readonly userNavigationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly agentNavigationGuards = new Map<string, AgentNavigationGuard>();
  private agentInputDepth = 0;
  private eventSink: BrowserEventSink | null = null;

  constructor(
    private readonly owner: BrowserWindow,
    private readonly options: BrowserServiceOptions,
  ) {
    this.localPages = new LocalPageRegistry(options.canonicalProjectPath);
  }

  setEventSink(sink: BrowserEventSink | null): void {
    this.eventSink = sink;
    if (sink) this.emitState();
  }

  getState(): BrowserState {
    return {
      activeTabId: this.activeTabId,
      visible: this.visible && this.viewBlockers.size === 0,
      viewBlocked: this.viewBlockers.size > 0,
      sessionFullAccess: this.policy.hasSessionFullAccess(),
      paused: this.paused,
      controlLevel: this.policy.getControlLevel(),
      mode: this.mode,
      tabs: [...this.tabs.values()].map((tab) => ({
        id: tab.id,
        profileId: tab.profileId,
        url: this.displayUrl(tab),
        title: tab.view.webContents.getTitle().slice(0, 4_000),
        loading: tab.view.webContents.isLoading(),
        canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
        canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
        documentEpoch: tab.documentEpoch,
        semanticAvailable: tab.semanticAvailable,
      })),
      grants: this.policy.listGrants(),
    };
  }

  async ensureTab(tabId = 'browser-main', initialUrl?: string): Promise<void> {
    if (this.tabs.has(tabId)) {
      this.activateTab(tabId);
      return;
    }
    const pending = this.tabCreations.get(tabId);
    if (pending) {
      await pending;
      if (this.tabs.has(tabId)) this.activateTab(tabId);
      return;
    }
    // Reopening the main tab without an explicit address returns to the last
    // restorable page for this project (e.g. an accidental close of localhost).
    const resolvedUrl = initialUrl ?? this.options.restoreUrl ?? 'about:blank';
    const creation = this.createTab(tabId, 'project', resolvedUrl);
    this.tabCreations.set(tabId, creation);
    try {
      await creation;
    } finally {
      if (this.tabCreations.get(tabId) === creation) this.tabCreations.delete(tabId);
    }
  }

  async createTab(
    tabId: string,
    profileId: string,
    initialUrl = 'about:blank',
    source: BrowserNavigationSource = 'user',
  ): Promise<void> {
    if (this.tabs.has(tabId)) throw new BrowserError('ACTION_BLOCKED', `Browser tab ${tabId} already exists.`);
    if (this.tabs.size >= 16) throw new BrowserError('ACTION_BLOCKED', 'Close a browser tab before opening another.');
    const partition = projectProfilePartition(this.options.canonicalProjectPath, profileId);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        devTools: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        spellcheck: true,
      },
    });
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    await this.configureSession(view.webContents.session);
    const cdp = new CdpClient(view.webContents);
    const gate = new BrowserActionGate(this.policy);
    const pointerOverlay = new BrowserPointerOverlay(cdp);
    const tab: BrowserTab = {
      id: tabId,
      profileId,
      view,
      cdp,
      snapshots: new SemanticSnapshotEngine(cdp, this.refs),
      actions: new BrowserActionExecutor(
        cdp,
        this.refs,
        gate,
        this.options.confirmAction,
        () => this.networkProxy.resetConnections(),
        (action) => this.beginAgentNavigationGuard(tabId, action, true),
        pointerOverlay,
      ),
      annotationService: new AnnotationService(cdp, this.policy, this.annotations, this.refs),
      annotationOverlay: new BrowserAnnotationOverlay(cdp),
      pointerOverlay,
      gate,
      humanNetworkOrigins: new Set<string>(),
      documentEpoch: 0,
      pageRevision: 0,
      semanticAvailable: false,
    };
    cdp.setAvailabilityListener((event) => {
      tab.semanticAvailable = event.available;
      if (!event.available) {
        this.refs.clearTab(tabId);
        this.cancelActions();
        this.setPaused(true);
      }
      this.eventSink?.({ type: 'cdp-availability', tabId, available: event.available, ...(event.reason ? { reason: event.reason.slice(0, 1_000) } : {}) });
      this.emitState();
    });
    this.configureNavigation(tab);
    const previousActiveTabId = this.activeTabId;
    this.tabs.set(tabId, tab);
    this.owner.contentView.addChildView(view);
    view.setBounds(this.bounds);
    view.setVisible(false);
    try {
      // A second hidden WebContentsView can exist before Chromium has committed
      // its initial document. CDP domain enables then wait forever. Commit the
      // blank document before attaching, and await it so it cannot race the
      // user's first address.
      if (!view.webContents.getURL()) await view.webContents.loadURL('about:blank');
      await cdp.attach();
      this.activateTab(tabId);
      if (initialUrl !== 'about:blank') await this.navigate(tabId, initialUrl, source);
    } catch (error) {
      await this.destroyTab(tab);
      this.tabs.delete(tabId);
      if (this.activeTabId === tabId) {
        this.activeTabId = previousActiveTabId && this.tabs.has(previousActiveTabId) ? previousActiveTabId : null;
        this.applyVisibility();
        this.emitState();
      }
      throw error;
    }
  }

  async createUserTab(initialUrl = 'about:blank'): Promise<string> {
    const tabId = `tab-${randomUUID()}`;
    await this.createTab(tabId, 'project', initialUrl, 'user');
    return tabId;
  }

  private async createPageTab(initialUrl: string): Promise<string> {
    const tabId = `tab-${randomUUID()}`;
    await this.createTab(tabId, 'project', initialUrl, 'page');
    return tabId;
  }

  setBounds(bounds: BrowserBounds | Rectangle): void {
    const zoom = this.owner.webContents.getZoomFactor();
    const content = this.owner.getContentBounds();
    const x = clamp(Math.round(bounds.x * zoom), 0, content.width);
    const y = clamp(Math.round(bounds.y * zoom), 0, content.height);
    const converted = {
      x,
      y,
      width: clamp(Math.round(bounds.width * zoom), 0, content.width - x),
      height: clamp(Math.round(bounds.height * zoom), 0, content.height - y),
    };
    this.bounds = converted;
    for (const tab of this.tabs.values()) tab.view.setBounds(converted);
  }

  isVisibilityRequested(): boolean {
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.cancelAnnotationSelection();
      this.setPaused(true);
    }
    this.applyVisibility();
    if (visible && this.mode === 'annotate') this.startAnnotationLoop();
    this.emitState();
  }

  setViewBlocked(reason: string, blocked: boolean): void {
    const key = reason.trim().slice(0, 100);
    if (!key) return;
    if (blocked) this.viewBlockers.add(key);
    else this.viewBlockers.delete(key);
    this.applyVisibility();
    if (!blocked && this.mode === 'annotate') this.startAnnotationLoop();
    this.emitState();
  }

  setPaused(paused: boolean): void {
    const changed = this.paused !== paused;
    if (paused || changed) this.cancelActions();
    this.paused = paused;
    if (paused) {
      this.clearAgentNavigationGuards();
      for (const tab of this.tabs.values()) void tab.pointerOverlay.clear();
      this.options.onPaused?.();
    }
    if (changed) {
      this.eventSink?.({
        type: 'work-log',
        tabId: this.activeTabId ?? 'browser-main',
        action: paused ? 'pause' : 'resume',
        target: paused ? 'Agent browser control paused' : 'Agent browser control resumed',
        timestamp: Date.now(),
      });
    }
    this.emitState();
  }

  setControlLevel(level: BrowserControlLevel): void {
    this.policy.setControlLevel(level);
    if (level === 'off') this.cancelAnnotationSelection();
    if (level !== 'interact') this.setPaused(true);
    else this.emitState();
  }

  setSessionFullAccess(enabled: boolean): void {
    if (!this.policy.setSessionFullAccess(enabled)) return;
    this.networkProxy.resetConnections();
    this.emitState();
  }

  setMode(mode: BrowserUiMode): void {
    if (this.mode === mode && (mode === 'annotate' ? Boolean(this.annotationController) : !this.paused && this.policy.getControlLevel() === 'interact')) return;
    this.mode = mode;
    this.cancelAnnotationSelection();
    if (mode === 'annotate') {
      this.policy.setControlLevel('observe');
      this.setPaused(true);
      this.startAnnotationLoop();
    } else {
      this.policy.setControlLevel('interact');
      this.setPaused(false);
    }
    this.emitState();
  }

  beginTask(taskOrRunId: string): void {
    if (this.policy.beginTask(taskOrRunId)) this.networkProxy.resetConnections();
    this.emitState();
  }

  setOriginGrant(grant: BrowserOriginGrant): BrowserOriginGrant {
    const saved = this.policy.setGrant(grant);
    this.eventSink?.({ type: 'work-log', tabId: this.activeTabId ?? 'browser-main', action: 'grant', target: saved.origin, timestamp: Date.now() });
    this.emitState();
    return saved;
  }

  revokeOriginGrant(origin: string): boolean {
    const removed = this.policy.revokeGrant(origin);
    if (removed) {
      this.networkProxy.resetConnections();
      this.eventSink?.({ type: 'work-log', tabId: this.activeTabId ?? 'browser-main', action: 'revoke', target: safeLogUrl(origin), timestamp: Date.now() });
    }
    this.emitState();
    return removed;
  }

  endTask(): void {
    this.policy.clearScopedGrants('once');
    this.policy.clearScopedGrants('task');
    this.networkProxy.resetConnections();
    this.setPaused(true);
  }

  async navigate(tabId: string, value: string, source: BrowserNavigationSource = 'user', signal?: AbortSignal): Promise<void> {
    const tab = this.tab(tabId);
    if (source === 'user') this.clearAgentNavigationGuard(tabId);
    const destination = await this.resolveNavigation(tab, value, source);
    if (source === 'agent') {
      this.assertAgentReady();
      const activeSignal = signal ? AbortSignal.any([this.actionController.signal, signal]) : this.actionController.signal;
      assertBrowserOperationActive(activeSignal);
      const action = {
        kind: 'navigate' as const,
        origin: destination.origin,
        frameOrigin: destination.origin,
        destinationUrl: destination.url,
        consequence: navigationConsequence(destination.url),
      };
      const decision = tab.gate.evaluate(action);
      if (decision.outcome === 'block') throw new BrowserError('ACTION_BLOCKED', decision.reason);
      if (decision.outcome === 'confirm' && (!this.options.confirmAction || !await this.options.confirmAction(action, decision.reason, {
        tabId,
        documentEpoch: tab.documentEpoch,
      }))) {
        throw new BrowserError('ACTION_BLOCKED', 'The browser navigation was not confirmed.');
      }
      assertBrowserOperationActive(activeSignal);
      assertNavigationStillAuthorized(tab.gate, action, decision.outcome === 'confirm');
      // Resolve only after grants and any confirmation are established. This
      // prevents blocked tool calls from leaking model-controlled DNS lookups.
      if (destination.network && destination.url !== 'about:blank') {
        await resolveTarget(new URL(destination.url), this.policy, activeSignal);
      }
      assertBrowserOperationActive(activeSignal);
      assertNavigationStillAuthorized(tab.gate, action, decision.outcome === 'confirm');
      const releaseNavigationGuard = this.beginAgentNavigationGuard(tabId, action, false);
      this.activeAgentNavigations.add(tabId);
      try {
        await tab.view.webContents.loadURL(destination.url);
        assertBrowserOperationActive(activeSignal);
      } finally {
        this.activeAgentNavigations.delete(tabId);
        releaseNavigationGuard();
      }
      if (tab.gate.consume(action)) this.networkProxy.resetConnections();
      this.logNavigation(tab, destination.url);
      return;
    }
    const releaseUserNavigation = source === 'user' ? this.beginUserNavigation(tabId) : null;
    try {
      await tab.view.webContents.loadURL(destination.url);
      this.logNavigation(tab, destination.url);
    } catch (error) {
      // Electron rejects loadURL with ERR_ABORTED when Stop, a redirect, HMR,
      // or a newer address supersedes it. That is browser lifecycle—not a
      // stopped Pi run—and the address bar should simply reflect current state.
      if (source !== 'user' || !isSupersededNavigationError(error)) throw error;
      const currentUrl = tab.view.webContents.getURL();
      if (currentUrl) this.logNavigation(tab, currentUrl);
    } finally {
      releaseUserNavigation?.();
    }
  }

  back(tabId: string): void {
    this.clearAgentNavigationGuard(tabId);
    const history = this.tab(tabId).view.webContents.navigationHistory;
    if (history.canGoBack()) {
      this.beginUserNavigation(tabId);
      history.goBack();
    }
  }
  forward(tabId: string): void {
    this.clearAgentNavigationGuard(tabId);
    const history = this.tab(tabId).view.webContents.navigationHistory;
    if (history.canGoForward()) {
      this.beginUserNavigation(tabId);
      history.goForward();
    }
  }
  reload(tabId: string): void { this.clearAgentNavigationGuard(tabId); this.tab(tabId).view.webContents.reload(); }
  stop(tabId: string): void { this.tab(tabId).view.webContents.stop(); }

  async snapshot(tabId: string, input: { mode?: BrowserSnapshotMode; scopeRef?: string; query?: string } = {}): Promise<SemanticPageSnapshot> {
    const tab = this.tab(tabId);
    const internalUrl = tab.view.webContents.getURL() || 'about:blank';
    const origin = browserSecurityOrigin(internalUrl);
    if (origin !== 'null' && !this.policy.canRead(origin)) throw new BrowserError('ORIGIN_NOT_GRANTED', 'The page origin is not readable.');
    const epoch = tab.documentEpoch;
    const result = await tab.snapshots.capture({
      tabId,
      documentEpoch: epoch,
      url: this.displayUrl(tab),
      title: tab.view.webContents.getTitle(),
      mode: input.mode ?? 'interactive',
      targetId: String(tab.view.webContents.id),
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      ...(input.query ? { query: input.query } : {}),
      canReadOrigin: (frameOrigin) => frameOrigin !== 'opaque' && this.policy.canRead(frameOrigin),
    });
    if (tab.documentEpoch !== epoch) throw new BrowserError('STALE_SNAPSHOT', 'The page navigated while its snapshot was being captured.', true);
    tab.pageRevision = result.revision;
    this.eventSink?.({ type: 'work-log', tabId, action: 'snapshot', target: `${result.nodeCount} semantic nodes`, timestamp: Date.now() });
    return result;
  }

  async selectElementAnnotation(tabId: string, comment: string, signal?: AbortSignal) {
    const tab = this.tab(tabId);
    const controller = this.startAnnotationSelection();
    try {
      const annotation = await tab.annotationService.selectElement({
        tabId, documentEpoch: tab.documentEpoch, pageRevision: Math.max(1, tab.pageRevision),
        url: this.displayUrl(tab),
        origin: browserSecurityOrigin(tab.view.webContents.getURL() || 'about:blank'),
        explicitUserSelection: true,
      }, comment, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal);
      this.eventSink?.({ type: 'work-log', tabId, action: 'annotate', target: redactPotentialSecretText(annotation.target.accessibleName ?? annotation.kind, 1_200), timestamp: Date.now() });
      return annotation;
    } finally {
      if (this.annotationController === controller) this.annotationController = null;
    }
  }

  async selectRegionAnnotation(tabId: string, comment: string, signal?: AbortSignal) {
    const tab = this.tab(tabId);
    const controller = this.startAnnotationSelection();
    try {
      const annotation = await tab.annotationService.selectRegion({
        tabId, documentEpoch: tab.documentEpoch, pageRevision: Math.max(1, tab.pageRevision),
        url: this.displayUrl(tab),
        origin: browserSecurityOrigin(tab.view.webContents.getURL() || 'about:blank'),
        explicitUserSelection: true,
      }, comment, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal);
      this.eventSink?.({ type: 'work-log', tabId, action: 'annotate', target: 'Selected page region', timestamp: Date.now() });
      return annotation;
    } finally {
      if (this.annotationController === controller) this.annotationController = null;
    }
  }

  cancelAnnotationSelection(): void {
    this.annotationLoop += 1;
    this.annotationController?.abort();
    this.annotationController = null;
  }

  async highlightAnnotation(id: string): Promise<boolean> {
    const annotation = this.annotations.get(id);
    if (!annotation) return false;
    const tab = this.tabs.get(annotation.tabId);
    if (!tab || tab.documentEpoch !== annotation.documentEpoch) return false;
    this.activateTab(tab.id);
    const ordered = [...this.annotations.list(tab.id)].reverse();
    const label = Math.max(1, ordered.findIndex((candidate) => candidate.id === annotation.id) + 1);
    await tab.annotationOverlay.add(annotation, label);
    await tab.annotationOverlay.pulse(id);
    return true;
  }

  async dismissAnnotationOverlays(ids: readonly string[]): Promise<void> {
    await Promise.all([...new Set(ids)].slice(0, 24).map(async (id) => {
      const annotation = this.annotations.get(id);
      if (!annotation) return;
      await this.tabs.get(annotation.tabId)?.annotationOverlay.remove(id);
    }));
  }

  listAnnotations(tabId?: string) { return this.annotations.list(tabId); }
  async resolveAnnotations(ids: readonly string[]): Promise<BrowserAnnotation[]> {
    const annotations = this.annotations.resolve(ids);
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    if (!tab) return annotations;
    const context = {
      tabId: tab.id,
      documentEpoch: tab.documentEpoch,
      pageRevision: Math.max(1, tab.pageRevision),
      url: this.displayUrl(tab),
      origin: browserSecurityOrigin(tab.view.webContents.getURL() || 'about:blank'),
    };
    for (const annotation of annotations) {
      if (annotation.tabId !== tab.id) continue;
      try {
        await tab.annotationService.reattachElement(context, annotation);
      } catch {
        tab.annotationService.markUnattached(annotation);
      }
    }
    return this.annotations.resolve(ids);
  }
  updateAnnotationComment(id: string, comment: string) { return this.annotations.updateComment(id, comment); }
  removeAnnotation(id: string): boolean {
    const annotation = this.annotations.get(id);
    const removed = this.annotations.remove(id);
    if (removed && annotation) void this.tabs.get(annotation.tabId)?.annotationOverlay.remove(id);
    return removed;
  }

  async click(tabId: string, input: { ref: string; signal?: AbortSignal }): Promise<BrowserActionResult> {
    this.assertAgentReady();
    const tab = this.tab(tabId);
    return this.withAgentInput(async () => {
      const result = await tab.actions.click(this.actionContext(tab, input.signal), { ref: input.ref });
      this.logAction(result);
      return result;
    });
  }

  async type(tabId: string, input: { ref: string; text: string; signal?: AbortSignal }): Promise<BrowserActionResult> {
    this.assertAgentReady();
    const tab = this.tab(tabId);
    return this.withAgentInput(async () => {
      const result = await tab.actions.type(this.actionContext(tab, input.signal), { ref: input.ref, text: input.text });
      this.logAction(result);
      return result;
    });
  }

  async press(tabId: string, key: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    this.assertAgentReady();
    const tab = this.tab(tabId);
    return this.withAgentInput(async () => {
      const result = await tab.actions.press(this.actionContext(tab, signal), key);
      this.logAction(result);
      return result;
    });
  }

  async scroll(tabId: string, deltaX: number, deltaY: number, signal?: AbortSignal): Promise<BrowserActionResult> {
    this.assertAgentReady();
    const tab = this.tab(tabId);
    return this.withAgentInput(async () => {
      const result = await tab.actions.scroll(this.actionContext(tab, signal), deltaX, deltaY);
      this.logAction(result);
      return result;
    });
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tab(tabId);
    const wasActive = this.activeTabId === tabId;
    this.cancelAnnotationSelection();
    this.endUserNavigation(tabId);
    await this.destroyTab(tab);
    this.tabs.delete(tabId);
    this.refs.clearTab(tabId);
    // Composer attachments are immutable snapshots and must survive their
    // source tab closing. They remain bounded by the repository and can still
    // be resolved into the next prompt, but can no longer be re-highlighted.
    this.localPages.revokeTab(tabId);
    if (wasActive) {
      this.activeTabId = this.tabs.keys().next().value as string | undefined ?? null;
      if (this.mode === 'annotate') {
        this.mode = 'agent';
        this.policy.setControlLevel('interact');
      }
      this.setPaused(true);
    }
    if (this.tabs.size === 0) {
      this.mode = 'agent';
      this.policy.setControlLevel('interact');
      await this.ensureTab();
    } else {
      this.setVisible(this.visible);
    }
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = [];
    this.cancelActions();
    this.cancelAnnotationSelection();
    for (const tab of this.tabs.values()) {
      try { await this.destroyTab(tab); } catch (error) { failures.push(error); }
    }
    for (const [session, listeners] of this.configuredSessions) {
      try {
        session.removeListener('will-download', listeners.download);
        session.setPermissionRequestHandler(null);
        session.setPermissionCheckHandler(null);
        session.webRequest.onBeforeRequest(null);
        await session.setProxy({ mode: 'direct' });
      } catch (error) {
        failures.push(error);
      }
    }
    this.configuredSessions.clear();
    this.localPages.clear();
    this.clearAgentNavigationGuards();
    this.clearUserNavigations();
    try { this.networkProxy.dispose(); } catch (error) { failures.push(error); }
    this.tabs.clear();
    this.tabCreations.clear();
    this.activeTabId = null;
    this.viewBlockers.clear();
    this.eventSink = null;
    if (failures.length > 0) throw new AggregateError(failures, 'The built-in browser did not dispose cleanly.');
  }

  private async configureSession(session: Session): Promise<void> {
    if (this.configuredSessions.has(session)) return;
    const proxyUrl = await this.networkProxy.start();
    await session.setProxy({
      mode: 'fixed_servers',
      proxyRules: proxyUrl,
      proxyBypassRules: '<-loopback>',
    });
    this.localPages.registerSession(session);
    const download = (_event: Electron.Event, item: DownloadItem) => {
      if (this.owner.isDestroyed()) {
        item.cancel();
        return;
      }
      item.pause();
      const fileName = path.basename(item.getFilename()).replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').slice(0, 180) || 'download';
      void dialog.showSaveDialog(this.owner, {
        title: 'Save browser download',
        defaultPath: path.join(app.getPath('downloads'), fileName),
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      }).then((result) => {
        if (result.canceled || !result.filePath) item.cancel();
        else {
          item.setSavePath(result.filePath);
          item.resume();
        }
      }).catch(() => item.cancel());
    };
    this.configuredSessions.set(session, { download });
    session.on('will-download', download);
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      void this.allowNetworkRequest(details.url, details.webContentsId).then(
        (allowed) => callback({ cancel: !allowed }),
        () => callback({ cancel: true }),
      );
    });
  }

  private async allowNetworkRequest(value: string, webContentsId?: number): Promise<boolean> {
    if (!this.agentRequestAllowed(value)) return false;
    const url = policyNetworkUrl(value);
    if (!url || isCloudMetadataHostname(url.hostname)) return false;
    const tab = [...this.tabs.values()].find((candidate) => candidate.view.webContents.id === webContentsId);
    const humanApprovedPrivate = Boolean(tab?.humanNetworkOrigins.has(url.origin));
    const decision = this.policy.inspectUrl(url.href);
    if (!decision.allowed && !(decision.privateNetwork && humanApprovedPrivate)) return false;
    if (isPrivateNetworkHostname(url.hostname)) {
      return humanApprovedPrivate || this.policy.allowsPrivateNetworkForOrigin(url.origin);
    }
    try {
      // Bound the DNS lookup. On macOS, AAAA/IPv6 resolution for some hosts can
      // stall getaddrinfo, and an unbounded lookup here would freeze the
      // webRequest gate (and thus the whole page load) forever. On timeout we
      // ALLOW the request: the explicit proxy's resolveTarget() still enforces
      // the private/cloud policy with its own bounded lookup, so security is
      // preserved — we only stop the request from hanging at this gate.
      const addresses = await Promise.race([
        lookup(url.hostname, { all: true, verbatim: true }),
        new Promise<Array<{ address: string; family: number }>>((resolve) => setTimeout(() => resolve([]), 4_000)),
      ]);
      if (addresses.length === 0) return true;
      if (addresses.some((entry) => isCloudMetadataHostname(entry.address))) return false;
      const resolvesPrivate = addresses.some((entry) => isPrivateNetworkHostname(entry.address));
      return !resolvesPrivate || humanApprovedPrivate || this.policy.allowsPrivateNetworkForOrigin(url.origin);
    } catch { return false; }
  }

  private async resolveNavigation(
    tab: BrowserTab,
    value: string,
    source: BrowserNavigationSource,
  ): Promise<{ url: string; origin: string; network: boolean }> {
    const inheritedLocalDisplay = this.localPages.displayUrl(value, tab.id);
    const address = parseBrowserAddress(inheritedLocalDisplay ?? value, this.options.canonicalProjectPath);
    if (address.kind === 'local-file') {
      if (source === 'page') throw new BrowserError('ACTION_BLOCKED', 'Pages cannot open local files in a new browser tab.');
      const local = await this.localPages.open(tab.id, address.path, source);
      return { url: local.internalUrl, origin: local.origin, network: false };
    }
    if (source === 'agent') {
      const allowed = this.policy.requireAllowedUrl(address.url);
      return { url: allowed.url, origin: allowed.origin, network: allowed.url !== 'about:blank' };
    }
    const parsed = new URL(address.url);
    const explicitlyApprovedPrivate = parsed.href === 'about:blank' || source !== 'user'
      ? new Set<string>()
      : new Set(isPrivateNetworkHostname(parsed.hostname) ? [parsed.origin] : []);
    const decision = inspectBrowserUrl(address.url, explicitlyApprovedPrivate);
    if (!decision.allowed || !decision.normalizedUrl || !decision.origin) {
      throw new BrowserError(decision.privateNetwork ? 'PRIVATE_NETWORK_BLOCKED' : 'INVALID_URL', decision.reason);
    }
    if (source === 'user' && decision.privateNetwork) tab.humanNetworkOrigins.add(decision.origin);
    return { url: decision.normalizedUrl, origin: decision.origin, network: decision.normalizedUrl !== 'about:blank' };
  }

  private inspectNavigation(tab: BrowserTab, value: string): ReturnType<typeof inspectBrowserUrl> {
    if (this.localPages.isAuthorized(value, tab.id)) {
      const url = new URL(value);
      return {
        allowed: true,
        normalizedUrl: url.href,
        origin: `fate-local://${url.hostname}`,
        privateNetwork: false,
        reason: 'Authorized local page is allowed.',
      };
    }
    try {
      if (new URL(value).protocol === 'fate-local:') {
        return { allowed: false, privateNetwork: false, reason: 'That local-page capability does not belong to this tab.' };
      }
    } catch { /* The shared URL policy returns the canonical parse error. */ }
    const decision = this.policy.inspectUrl(value);
    if (decision.allowed || !decision.privateNetwork || !decision.origin || !tab.humanNetworkOrigins.has(decision.origin)) return decision;
    return { ...decision, allowed: true, reason: 'The user opened this private-network origin.' };
  }

  private displayUrl(tab: BrowserTab): string {
    const internalUrl = tab.view.webContents.getURL() || 'about:blank';
    return this.localPages.displayUrl(internalUrl, tab.id) ?? internalUrl;
  }

  private logNavigation(tab: BrowserTab, internalUrl: string): void {
    const displayUrl = this.localPages.displayUrl(internalUrl, tab.id) ?? internalUrl;
    this.eventSink?.({ type: 'work-log', tabId: tab.id, action: 'navigate', target: safeLogUrl(displayUrl), timestamp: Date.now() });
  }

  private configureNavigation(tab: BrowserTab): void {
    const contents = tab.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (this.localPages.isAuthorized(contents.getURL(), tab.id)) {
        this.navigationBlocked(tab.id, url, 'Local previews cannot open external pages. Enter the address directly to leave the preview.');
        return { action: 'deny' };
      }
      void this.createPageTab(url).catch((error: unknown) => {
        this.navigationBlocked(tab.id, url, error instanceof Error ? error.message : 'The new tab could not be opened.');
      });
      return { action: 'deny' };
    });
    contents.on('will-frame-navigate', (event) => {
      const leavingLocalPreview = this.localPages.isAuthorized(contents.getURL(), tab.id)
        && !this.localPages.isAuthorized(event.url, tab.id)
        && !this.activeUserNavigations.has(tab.id)
        && !this.activeAgentNavigations.has(tab.id);
      const decision = this.inspectNavigation(tab, event.url);
      const guardAllowed = decision.allowed && this.agentNavigationAllowed(tab.id, event.url);
      if (leavingLocalPreview || !decision.allowed || !guardAllowed) {
        event.preventDefault();
        this.navigationBlocked(
          tab.id,
          event.url,
          leavingLocalPreview
            ? 'Local previews cannot navigate externally. Enter the address directly to leave the preview.'
            : decision.allowed
              ? 'The agent action did not authorize navigation to this origin.'
              : decision.reason,
        );
      }
    });
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (this.agentInputDepth === 0 && !this.paused) this.setPaused(true);
      const key = input.key.toLocaleLowerCase();
      const primary = input.control || input.meta;
      if (primary && key === 'l') {
        event.preventDefault();
        this.options.onAppShortcut?.('focus-address');
      } else if (primary && key === 'r') {
        event.preventDefault();
        contents.reload();
      } else if (primary && key === 'w') {
        event.preventDefault();
        void this.closeTab(tab.id).catch(() => undefined);
      } else if (primary && input.shift && key === 'b') {
        event.preventDefault();
        this.options.onAppShortcut?.('toggle-browser');
      } else if (primary && key === 'k') {
        event.preventDefault();
        this.options.onAppShortcut?.('open-palette');
      } else if (input.key === 'Escape') {
        event.preventDefault();
        if (this.mode === 'annotate') {
          this.mode = 'agent';
          this.policy.setControlLevel('interact');
          this.cancelAnnotationSelection();
          this.setPaused(true);
        } else {
          this.setPaused(true);
        }
        this.options.onAppShortcut?.('pause-browser');
      }
    });
    contents.on('before-mouse-event', (_event, mouse) => {
      if (this.agentInputDepth === 0 && !this.paused && (mouse.type === 'mouseDown' || mouse.type === 'mouseWheel')) this.setPaused(true);
    });
    contents.on('did-start-navigation', (event) => {
      if (!event.isMainFrame) return;
      this.cancelAnnotationSelection();
      if (!this.activeAgentNavigations.has(tab.id)) this.cancelActions();
      if (!event.isSameDocument) {
        tab.documentEpoch += 1;
        this.refs.invalidateTab(tab.id, tab.documentEpoch);
      }
    });
    contents.on('did-navigate', (_event, url) => {
      this.localPages.retainForNavigation(tab.id, url);
      const committedOrigin = networkOrigin(url);
      for (const origin of [...tab.humanNetworkOrigins]) if (origin !== committedOrigin) tab.humanNetworkOrigins.delete(origin);
      if (isRestorableBrowserUrl(url)) this.options.onNavigated?.(url);
    });
    contents.on('did-start-loading', () => this.emitState());
    contents.on('did-stop-loading', () => {
      this.endUserNavigation(tab.id);
      if (this.mode === 'annotate' && this.activeTabId === tab.id) this.startAnnotationLoop();
      this.emitState();
    });
    contents.on('did-fail-load', () => this.endUserNavigation(tab.id));
    contents.on('page-title-updated', () => this.emitState());
  }

  private allowsPrivateNetworkAuthority(origin: string): boolean {
    let requested: URL;
    try { requested = new URL(origin); } catch { return false; }
    const authorityMatches = (candidate: string) => {
      try {
        const approved = new URL(candidate);
        return approved.hostname === requested.hostname && effectivePort(approved) === effectivePort(requested);
      } catch { return false; }
    };
    if (this.policy.allowsPrivateNetworkForOrigin(origin)) return true;
    for (const grant of this.policy.listGrants()) {
      if (grant.allowPrivateNetwork && authorityMatches(grant.origin)) return true;
    }
    return [...this.tabs.values()].some((tab) => [...tab.humanNetworkOrigins].some(authorityMatches));
  }

  private beginUserNavigation(tabId: string): () => void {
    this.endUserNavigation(tabId);
    this.activeUserNavigations.add(tabId);
    const timer = setTimeout(() => this.endUserNavigation(tabId), 30_000);
    timer.unref?.();
    this.userNavigationTimers.set(tabId, timer);
    return () => {
      if (this.userNavigationTimers.get(tabId) === timer) this.endUserNavigation(tabId);
    };
  }

  private endUserNavigation(tabId: string): void {
    const timer = this.userNavigationTimers.get(tabId);
    if (timer) clearTimeout(timer);
    this.userNavigationTimers.delete(tabId);
    this.activeUserNavigations.delete(tabId);
  }

  private clearUserNavigations(): void {
    for (const tabId of [...this.activeUserNavigations]) this.endUserNavigation(tabId);
  }

  private async withAgentInput<T>(operation: () => Promise<T>): Promise<T> {
    this.agentInputDepth += 1;
    try {
      return await operation();
    } finally {
      this.agentInputDepth = Math.max(0, this.agentInputDepth - 1);
    }
  }

  private beginAgentNavigationGuard(
    tabId: string,
    action: ProposedBrowserAction,
    restrictRequests: boolean,
  ): () => void {
    const allowedOrigins = new Set<string>();
    for (const value of [action.origin, action.frameOrigin, action.destinationUrl]) {
      const origin = networkOrigin(value);
      if (origin) allowedOrigins.add(origin);
    }
    const token = Symbol(`browser-action:${tabId}`);
    const guard: AgentNavigationGuard = {
      token,
      allowedOrigins,
      dispatching: true,
      restrictRequests,
    };
    this.agentNavigationGuards.set(tabId, guard);
    return () => {
      const current = this.agentNavigationGuards.get(tabId);
      if (!current || current.token !== token) return;
      // Keep the authorized-origin guard until the next browser action or
      // explicit human takeover. A page must not bypass the ActionGate by
      // scheduling a delayed cross-origin navigation after input returns.
      current.dispatching = false;
    };
  }

  private agentNavigationAllowed(tabId: string, value: string): boolean {
    const guard = this.agentNavigationGuards.get(tabId);
    if (!guard) return true;
    const origin = networkOrigin(value);
    return Boolean(origin && guard.allowedOrigins.has(origin));
  }

  private agentRequestAllowed(value: string): boolean {
    const active = [...this.agentNavigationGuards.values()].filter((guard) => guard.dispatching && guard.restrictRequests);
    if (active.length === 0) return true;
    const origin = networkOrigin(value);
    return Boolean(origin && active.some((guard) => guard.allowedOrigins.has(origin)));
  }

  private clearAgentNavigationGuard(tabId: string): void {
    this.agentNavigationGuards.delete(tabId);
  }

  private clearAgentNavigationGuards(): void {
    for (const tabId of this.agentNavigationGuards.keys()) this.clearAgentNavigationGuard(tabId);
  }

  private actionContext(tab: BrowserTab, signal?: AbortSignal) {
    const url = tab.view.webContents.getURL() || 'about:blank';
    const origin = browserSecurityOrigin(url);
    const documentEpoch = tab.documentEpoch;
    if (origin === 'null') throw new BrowserError('ACTION_BLOCKED', 'Opaque and blank documents are not agent-interactable.');
    return {
      tabId: tab.id,
      documentEpoch,
      url,
      origin,
      targetId: String(tab.view.webContents.id),
      signal: signal ? AbortSignal.any([this.actionController.signal, signal]) : this.actionController.signal,
      assertCurrent: () => {
        if (tab.documentEpoch !== documentEpoch || (tab.view.webContents.getURL() || 'about:blank') !== url) {
          throw new BrowserError('STALE_SNAPSHOT', 'The browser document changed before the action was dispatched.', true);
        }
      },
    };
  }

  private assertAgentReady(): void {
    if (this.paused) throw new BrowserError('ACTION_BLOCKED', 'Browser agent actions are paused.');
  }

  activateTab(tabId: string): void {
    this.tab(tabId);
    const changed = this.activeTabId !== tabId;
    if (changed) this.cancelAnnotationSelection();
    this.activeTabId = tabId;
    this.applyVisibility();
    if (this.mode === 'annotate') this.startAnnotationLoop();
    this.emitState();
  }

  private applyVisibility(): void {
    const visible = this.visible && this.viewBlockers.size === 0;
    for (const tab of this.tabs.values()) tab.view.setVisible(visible && tab.id === this.activeTabId);
  }

  private cancelActions(): void {
    this.actionController.abort();
    for (const tabId of this.activeAgentNavigations) this.tabs.get(tabId)?.view.webContents.stop();
    this.activeAgentNavigations.clear();
    this.actionController = new AbortController();
  }

  private startAnnotationLoop(): void {
    if (this.mode !== 'annotate' || !this.visible || this.viewBlockers.size > 0 || !this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab || !tab.semanticAvailable || tab.view.webContents.getURL() === 'about:blank') return;
    this.cancelAnnotationSelection();
    const controller = new AbortController();
    const loop = ++this.annotationLoop;
    const annotationOwner = this.options.annotationOwner?.() ?? null;
    this.annotationController = controller;
    void (async () => {
      try {
        if (!annotationOwner) throw new BrowserError('ACTION_BLOCKED', 'Open a conversation before attaching a browser element.');
        const annotation = await tab.annotationService.selectElement({
          tabId: tab.id,
          documentEpoch: tab.documentEpoch,
          pageRevision: Math.max(1, tab.pageRevision),
          url: this.displayUrl(tab),
          origin: browserSecurityOrigin(tab.view.webContents.getURL() || 'about:blank'),
          explicitUserSelection: true,
        }, '', controller.signal);
        if (controller.signal.aborted || this.mode !== 'annotate' || tab.documentEpoch !== annotation.documentEpoch) return;
        const ordered = [...this.annotations.list(tab.id)].reverse();
        const label = Math.max(1, ordered.findIndex((candidate) => candidate.id === annotation.id) + 1);
        await tab.annotationOverlay.add(annotation, label);
        this.eventSink?.({ type: 'annotation-created', ...annotationOwner, annotation });
        this.eventSink?.({
          type: 'work-log',
          tabId: tab.id,
          action: 'annotate',
          target: redactPotentialSecretText(annotation.target.accessibleName ?? annotation.target.role ?? annotation.target.tagName ?? 'Page element', 1_200),
          timestamp: Date.now(),
        });
        // Re-enter on a fresh event-loop turn. Chromium's Overlay domain can
        // stall when setInspectMode is issued re-entrantly after a selection.
        setTimeout(() => {
          if (this.mode === 'annotate' && this.activeTabId === tab.id && loop === this.annotationLoop) this.startAnnotationLoop();
        }, 0);
      } catch (error) {
        if (!isAbortError(error) && loop === this.annotationLoop) {
          const message = error instanceof Error ? error.message : 'The page element could not be attached.';
          this.eventSink?.({ type: 'annotation-error', message: message.slice(0, 1_000) });
          this.mode = 'agent';
          this.policy.setControlLevel('interact');
          this.paused = true;
          this.emitState();
        }
      } finally {
        if (this.annotationController === controller) this.annotationController = null;
      }
    })();
  }

  private startAnnotationSelection(): AbortController {
    this.cancelAnnotationSelection();
    const controller = new AbortController();
    this.annotationController = controller;
    return controller;
  }

  private tab(tabId: string): BrowserTab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new BrowserError('TAB_NOT_FOUND', `Browser tab ${tabId} does not exist.`);
    return tab;
  }

  private async destroyTab(tab: BrowserTab): Promise<void> {
    const failures: unknown[] = [];
    try { await tab.cdp.dispose(); } catch (error) { failures.push(error); }
    if (!this.owner.isDestroyed()) {
      try { this.owner.contentView.removeChildView(tab.view); } catch (error) { failures.push(error); }
    }
    try {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, `Browser tab ${tab.id} did not dispose cleanly.`);
  }

  private navigationBlocked(tabId: string, url: string, reason: string): void {
    this.eventSink?.({ type: 'navigation-blocked', tabId, url: safeLogUrl(url), reason: reason.slice(0, 1_000) });
    this.eventSink?.({ type: 'work-log', tabId, action: 'blocked', target: reason.slice(0, 1_200), timestamp: Date.now() });
  }
  private logAction(result: BrowserActionResult): void {
    if (result.kind !== 'click' && result.kind !== 'type' && result.kind !== 'press' && result.kind !== 'scroll') return;
    this.eventSink?.({ type: 'work-log', tabId: result.tabId, action: result.kind, target: result.target, timestamp: Date.now() });
  }
  private emitState(): void { this.eventSink?.({ type: 'state', state: this.getState() }); }
}

export function projectProfilePartition(canonicalProjectPath: string, profileId = 'project'): string {
  const normalized = path.normalize(canonicalProjectPath).normalize('NFC');
  const identity = process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 32);
  const profile = createHash('sha256').update(profileId).digest('hex').slice(0, 12);
  return `persist:fate-browser-${digest}-${profile}`;
}

function navigationConsequence(value: string): BrowserConsequence {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (/(?:^|\.)(?:bank|banking|payments?|paypal|stripe)(?:\.|$)/u.test(host)) return 'financial';
    if (/(?:^|\.)(?:health|healthcare|medical|insurance)(?:\.|$)/u.test(host)) return 'account';
  } catch { /* URL validation happens before classification. */ }
  return 'none';
}

export const inspectBrowserNetworkUrl = inspectBrowserUrl;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function safeLogUrl(value: string): string {
  return redactSnapshotUrl(value).slice(0, 8_192);
}

function browserSecurityOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'fate-local:' && /^[a-f0-9]{48}$/u.test(url.hostname)) return `fate-local://${url.hostname}`;
    return url.origin;
  } catch {
    return 'null';
  }
}

function networkOrigin(value: string | undefined): string | null {
  if (!value) return null;
  const networkUrl = policyNetworkUrl(value);
  if (networkUrl) return networkUrl.origin;
  const origin = browserSecurityOrigin(value);
  return origin === 'null' ? null : origin;
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === 'http:' || url.protocol === 'ws:' ? '80' : '443');
}

function policyNetworkUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isSupersededNavigationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown };
  return candidate.code === 'ERR_ABORTED'
    || candidate.errno === -3
    || (typeof candidate.message === 'string' && /\bERR_ABORTED\b/u.test(candidate.message));
}

function assertNavigationStillAuthorized(
  gate: BrowserActionGate,
  action: Parameters<BrowserActionGate['evaluate']>[0],
  confirmed: boolean,
): void {
  const current = gate.evaluate(action);
  if (current.outcome === 'block' || (current.outcome === 'confirm' && !confirmed)) {
    throw new BrowserError('ACTION_BLOCKED', `The browser navigation is no longer allowed: ${current.reason}`);
  }
}

function assertBrowserOperationActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Browser action aborted.', 'AbortError');
}
