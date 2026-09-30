import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type {
  BrowserConfirmation,
  BrowserEvent,
  ProjectState,
  ProposedBrowserAction,
  AppCommand,
  PermissionLevel,
} from '../../shared/contracts/ipc';
import type { BrowserRuntimeBridge } from '../pi/BrowserRuntimeBridge';
import { BrowserAnnotationRepository } from './BrowserAnnotationRepository';
import { BrowserError } from './BrowserErrors';
import type { BrowserConfirmationBinding } from './BrowserActionExecutor';
import { BrowserService } from './BrowserService';
import { BrowserHistoryRepository } from './BrowserHistoryRepository';
import { redactSnapshotUrl } from './SemanticSnapshotEngine';

const CONFIRMATION_TTL_MS = 30_000;
const MAX_PERSISTED_ANNOTATION_STORES = 24;
const INACTIVE_SESSION_BLOCKER = 'inactive-session';

type ServiceEntry = {
  owner: BrowserWindow;
  projectPath: string;
  sessionId: string;
  service: BrowserService;
  ready: boolean;
};

interface PendingConfirmation {
  confirmation: BrowserConfirmation;
  digest: string;
  binding: BrowserConfirmationBinding;
  leaseOwner: string;
  entry: ServiceEntry;
  timer: ReturnType<typeof setTimeout>;
  resolve: (approved: boolean) => void;
}

export interface BrowserHostOptions {
  currentProject(): ProjectState | null;
  currentPermissionLevel?(): PermissionLevel;
  /** Authority for this exact Pi session. Background sessions must never
   *  inherit the foreground conversation's permission level. */
  sessionPermissionLevel?(projectPath: string, sessionId: string): PermissionLevel;
  bridge: Pick<BrowserRuntimeBridge, 'currentRoot' | 'syncService'> & Partial<Pick<BrowserRuntimeBridge, 'permissionForSession'>>;
  emit(owner: BrowserWindow, event: BrowserEvent): void;
  command(owner: BrowserWindow, command: Extract<AppCommand, 'focus-address' | 'toggle-browser' | 'open-palette'>): void;
  /** Per-project, per-session last-URL store. */
  history?: BrowserHistoryRepository;
}

export class BrowserHost {
  private readonly services = new Map<string, ServiceEntry>();
  private foreground: ServiceEntry | null = null;
  private pending: PendingConfirmation | null = null;
  private ensuring: { key: string; ownerId: number; promise: Promise<BrowserService> } | null = null;
  private generation = 0;
  private appOverlayBlocked = false;
  private paneVisible = false;
  /** Composer drafts hold annotation ids beyond service disposal. Stores are
   *  retained per project AND session, never shared across conversations. */
  private readonly annotationStores = new Map<string, BrowserAnnotationRepository>();

  constructor(private readonly options: BrowserHostOptions) {}

  /** Hide the previous session's native view as soon as Pi changes roots. */
  onRootChanged(): void {
    this.syncForeground();
  }

  /** Only the focused conversation can drive the renderer's browser UI. */
  current(owner?: BrowserWindow): BrowserService | null {
    this.syncForeground();
    const entry = this.foreground;
    if (!entry?.ready || (owner && owner.webContents.id !== entry.owner.webContents.id)) return null;
    this.syncSessionAccess(entry);
    return entry.service;
  }

  /** Explicit lookup for a Pi session. Never returns another session's tabs,
   *  grants, annotations, proxy, or Chromium storage. Does not change focus. */
  currentForSession(projectPath: string, sessionId: string): BrowserService | null {
    if (!this.isAuthorizedSession(projectPath, sessionId)) return null;
    const entry = this.services.get(sessionKey(projectPath, sessionId));
    if (!entry?.ready || entry.owner.isDestroyed()) return null;
    this.syncSessionAccess(entry);
    return entry.service;
  }

  async ensure(owner: BrowserWindow): Promise<BrowserService> {
    if (owner.isDestroyed()) throw new BrowserError('ACTION_BLOCKED', 'The application window is unavailable.');
    const project = this.options.currentProject();
    const root = this.options.bridge.currentRoot();
    if (!project?.trusted || !root || !samePath(root.projectPath, project.path) || !root.sessionId) {
      throw new BrowserError('ACTION_BLOCKED', 'Open a trusted project and conversation before using the built-in browser.');
    }
    const service = await this.ensureForSession(owner, project.path, root.sessionId);
    // A focus switch during startup cannot return a former conversation to
    // foreground UI code, even when that former service still exists.
    if (this.current(owner) !== service) throw new BrowserError('ACTION_BLOCKED', 'The active browser conversation changed while starting.');
    return service;
  }

  async ensureForSession(owner: BrowserWindow, projectPath: string, sessionId: string): Promise<BrowserService> {
    if (owner.isDestroyed()) throw new BrowserError('ACTION_BLOCKED', 'The application window is unavailable.');
    if (!this.isAuthorizedSession(projectPath, sessionId)) {
      throw new BrowserError('ACTION_BLOCKED', 'Open and trust this project before using its browser session.');
    }
    const focused = this.options.currentProject();
    const project: ProjectState = focused?.trusted && samePath(focused.path, projectPath)
      ? focused : { path: projectPath, name: path.basename(projectPath), trusted: true };
    const key = sessionKey(project.path, sessionId);
    const pending = this.ensuring;
    if (pending) {
      if (pending.key === key && pending.ownerId === owner.webContents.id) return pending.promise;
      await pending.promise.catch(() => undefined);
      return this.ensureForSession(owner, projectPath, sessionId);
    }
    this.syncForeground();
    const entry = this.services.get(key);
    if (entry && entry.owner.webContents.id === owner.webContents.id && !entry.owner.isDestroyed()) {
      if (entry.service.getState().tabs.length === 0) await this.ensureServiceTab(entry.service, project, sessionId);
      if (this.services.get(key) !== entry || !this.isAuthorizedSession(project.path, sessionId)) {
        throw new BrowserError('ACTION_BLOCKED', 'The trusted project changed while the built-in browser was starting.');
      }
      this.syncForeground();
      this.syncSessionAccess(entry);
      if (this.foreground === entry) this.options.bridge.syncService();
      return entry.service;
    }
    // A replacement window needs new native views. A project or conversation
    // focus switch keeps other sessions alive and hidden.
    const operation = this.createService(owner, project, sessionId, key);
    this.ensuring = { key, ownerId: owner.webContents.id, promise: operation };
    try {
      return await operation;
    } finally {
      if (this.ensuring?.promise === operation) this.ensuring = null;
    }
  }

  private async createService(owner: BrowserWindow, project: ProjectState, sessionId: string, key: string): Promise<BrowserService> {
    if ([...this.services.values()].some((entry) => entry.owner.webContents.id !== owner.webContents.id)) {
      await this.reset();
    }
    const generation = this.generation;
    const stillCurrent = () => this.generation === generation && !owner.isDestroyed()
      && this.isAuthorizedSession(project.path, sessionId);
    if (!stillCurrent()) throw new BrowserError('ACTION_BLOCKED', 'The trusted project changed while the built-in browser was starting.');
    const remembered = await this.options.history?.loadSession(project.path, sessionId).catch(() => null) ?? null;
    if (!stillCurrent()) throw new BrowserError('ACTION_BLOCKED', 'The trusted project changed while the built-in browser was starting.');
    let entry!: ServiceEntry;
    const service = new BrowserService(owner, {
      canonicalProjectPath: project.path,
      browserSessionId: sessionId,
      confirmAction: (action, reason, binding) => this.requestConfirmation(entry, action, reason, binding),
      annotationOwner: () => ({ projectPath: project.path, sessionId }),
      onAppShortcut: (command) => {
        if (this.isForeground(entry)) this.options.command(owner, command);
      },
      onTabsChanged: (tabs, activeIndex) => {
        if (this.services.get(key) !== entry) return;
        void this.options.history?.save(project.path, tabs.length ? { tabs: [...tabs], activeIndex } : null, sessionId).catch(() => undefined);
      },
      ...(remembered?.tabs.length ? { restoreTabs: remembered.tabs, restoreActiveIndex: remembered.activeIndex } : {}),
      annotations: this.annotationStoreFor(project.path, sessionId),
    });
    entry = { owner, projectPath: project.path, sessionId, service, ready: false };
    // Block the native view before any tab is created. An unfocused Pi run
    // may initialize its browser, but it cannot display over the focused UI.
    service.setViewBlocked(INACTIVE_SESSION_BLOCKER, true);
    this.services.set(key, entry);
    service.setEventSink((event) => {
      if (this.isForeground(entry)) this.emitScoped(entry, event);
    });
    this.syncForeground();
    try {
      await this.ensureServiceTab(service, project, sessionId);
      if (!stillCurrent() || this.services.get(key) !== entry) throw new BrowserError('ACTION_BLOCKED', 'The built-in browser was replaced while starting.');
      service.setMode('agent');
      entry.ready = true;
      this.syncForeground();
      this.syncSessionAccess(entry);
      if (this.foreground === entry) this.options.bridge.syncService();
      return service;
    } catch (error) {
      if (this.services.get(key) === entry) {
        this.services.delete(key);
        if (this.foreground === entry) this.foreground = null;
      }
      await service.dispose().catch(() => undefined);
      throw error;
    }
  }

  /** A dead remembered local preview falls back to an empty tab in only its
   *  owning session; no other conversation's history is touched. */
  private async ensureServiceTab(service: BrowserService, project: ProjectState, sessionId: string): Promise<void> {
    try {
      await service.ensureTab();
    } catch (error) {
      if (!(error instanceof BrowserError) || error.code !== 'INVALID_URL') throw error;
      await this.options.history?.save(project.path, null, sessionId).catch(() => undefined);
      await service.ensureTab('browser-main', 'about:blank');
    }
  }

  setAppOverlay(owner: BrowserWindow, blocked: boolean): void {
    const service = this.current(owner);
    if (!service) return;
    this.appOverlayBlocked = blocked;
    service.setViewBlocked('app-overlay', blocked);
  }

  respondToConfirmation(owner: BrowserWindow, id: string, approved: boolean): boolean {
    const pending = this.pending;
    const entry = this.foreground;
    if (!pending || !entry || pending.entry !== entry || entry.owner.webContents.id !== owner.webContents.id
      || pending.confirmation.id !== id || this.current(owner) !== entry.service) return false;
    const tab = entry.service.getState().tabs.find((candidate) => candidate.id === pending.confirmation.tabId);
    const lease = entry.service.lease.getState();
    const valid = Date.now() <= pending.confirmation.expiresAt
      && tab?.documentEpoch === pending.confirmation.documentEpoch
      && lease?.ownerSessionId === pending.leaseOwner
      && confirmationDigest(pending.confirmation.action, pending.binding) === pending.digest;
    this.clearConfirmation(Boolean(approved && valid));
    return valid;
  }

  async reset(): Promise<void> {
    this.generation += 1;
    this.clearConfirmation(false);
    const entries = [...this.services.values()];
    this.services.clear();
    this.foreground = null;
    this.appOverlayBlocked = false;
    this.paneVisible = false;
    // Draft annotations survive a reset, but only in their original session.
    await Promise.all(entries.map((entry) => entry.service.dispose()));
  }

  private annotationStoreFor(projectPath: string, sessionId: string): BrowserAnnotationRepository {
    const key = sessionKey(projectPath, sessionId);
    const existing = this.annotationStores.get(key);
    if (existing) {
      this.annotationStores.delete(key);
      this.annotationStores.set(key, existing);
      return existing;
    }
    const created = new BrowserAnnotationRepository();
    this.annotationStores.set(key, created);
    while (this.annotationStores.size > MAX_PERSISTED_ANNOTATION_STORES) {
      const oldest = this.annotationStores.keys().next().value as string | undefined;
      if (!oldest) break;
      this.annotationStores.delete(oldest);
    }
    return created;
  }

  private requestConfirmation(
    entry: ServiceEntry,
    action: ProposedBrowserAction,
    reason: string,
    binding: BrowserConfirmationBinding,
  ): Promise<boolean> {
    if (!this.isForeground(entry)) return Promise.resolve(false);
    const tab = entry.service.getState().tabs.find((candidate) => candidate.id === binding.tabId);
    const lease = entry.service.lease.getState();
    if (!tab || tab.documentEpoch !== binding.documentEpoch || lease?.ownerSessionId !== entry.sessionId) return Promise.resolve(false);
    this.clearConfirmation(false);
    const confirmation: BrowserConfirmation = {
      id: randomUUID(),
      tabId: binding.tabId,
      documentEpoch: binding.documentEpoch,
      action: {
        kind: action.kind,
        origin: action.origin,
        frameOrigin: action.frameOrigin,
        ...(action.targetRole ? { targetRole: action.targetRole } : {}),
        ...(action.targetName ? { targetName: action.targetName } : {}),
        ...(action.destinationUrl ? { destinationUrl: redactSnapshotUrl(action.destinationUrl) } : {}),
        consequence: action.consequence,
      },
      reason: reason.slice(0, 1_000),
      expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.clearConfirmation(false), CONFIRMATION_TTL_MS);
      timer.unref?.();
      this.pending = {
        confirmation,
        digest: confirmationDigest(confirmation.action, binding),
        binding: { ...binding },
        leaseOwner: lease.ownerSessionId,
        entry,
        timer,
        resolve,
      };
      this.emitScoped(entry, { type: 'confirmation-requested', confirmation });
    });
  }

  private clearConfirmation(approved: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (!pending.entry.owner.isDestroyed()) {
      this.emitScoped(pending.entry, { type: 'confirmation-cleared', id: pending.confirmation.id, approved });
    }
    pending.resolve(approved);
  }

  private emitScoped(entry: ServiceEntry, event: BrowserEvent): void {
    if (!entry.owner.isDestroyed()) this.options.emit(entry.owner, { ...event, projectPath: entry.projectPath, sessionId: entry.sessionId });
  }

  private isAuthorizedSession(projectPath: string, sessionId: string): boolean {
    if (!sessionId) return false;
    const project = this.options.currentProject();
    if (project && samePath(project.path, projectPath) && !project.trusted) return false;
    if (this.options.bridge.permissionForSession?.({ projectPath, sessionId }) != null) return true;
    const root = this.options.bridge.currentRoot();
    return Boolean(project?.trusted && samePath(project.path, projectPath)
      && (!this.options.bridge.permissionForSession || (root?.sessionId === sessionId
        && samePath(root.projectPath, projectPath))));
  }

  private isForeground(entry: ServiceEntry): boolean {
    const root = this.options.bridge.currentRoot();
    const project = this.options.currentProject();
    return entry.ready && this.foreground === entry && this.services.get(sessionKey(entry.projectPath, entry.sessionId)) === entry
      && !entry.owner.isDestroyed() && Boolean(project?.trusted && samePath(project.path, entry.projectPath)
        && root?.sessionId === entry.sessionId && samePath(root.projectPath, entry.projectPath));
  }

  private syncForeground(): void {
    const project = this.options.currentProject();
    const root = this.options.bridge.currentRoot();
    const candidate = project?.trusted && root?.sessionId && samePath(project.path, root.projectPath)
      ? this.services.get(sessionKey(project.path, root.sessionId)) ?? null : null;
    const next = candidate?.ready && !candidate.owner.isDestroyed() ? candidate : null;
    if (this.foreground === next) return;
    this.clearConfirmation(false);
    const previous = this.foreground;
    if (previous) this.paneVisible = previous.service.isVisibilityRequested();
    // Hide old native views BEFORE revealing new ones. Never dispose either
    // service on a conversation focus change.
    previous?.service.setViewBlocked(INACTIVE_SESSION_BLOCKER, true);
    previous?.service.setSessionFullAccess(false);
    this.foreground = next;
    if (previous && !next && !previous.owner.isDestroyed()) {
      this.options.emit(previous.owner, { type: 'state', state: {
        activeTabId: null, visible: false, viewBlocked: false,
        sessionFullAccess: false, controlLevel: 'off', mode: 'agent',
        deviceEmulation: null, tabs: [], grants: [],
      } });
    }
    if (next) {
      next.service.setViewBlocked('app-overlay', this.appOverlayBlocked);
      next.service.setVisible(this.paneVisible);
      this.syncSessionAccess(next);
      next.service.setViewBlocked(INACTIVE_SESSION_BLOCKER, false);
      this.emitScoped(next, { type: 'state', state: next.service.getState() });
    }
  }

  private syncSessionAccess(entry: ServiceEntry): void {
    const level = this.options.sessionPermissionLevel?.(entry.projectPath, entry.sessionId)
      ?? (this.isForeground(entry) ? this.options.currentPermissionLevel?.() : 'read-only');
    entry.service.setSessionFullAccess(level === 'full-access');
  }
}

function confirmationDigest(action: BrowserConfirmation['action'], binding: BrowserConfirmationBinding): string {
  return createHash('sha256').update(JSON.stringify({ action, ...binding })).digest('hex');
}

function samePath(left: string, right: string | null): boolean {
  return right !== null && normalizeProjectKey(left) === normalizeProjectKey(right);
}

function sessionKey(projectPath: string, sessionId: string): string {
  return JSON.stringify([normalizeProjectKey(projectPath), sessionId]);
}

function normalizeProjectKey(value: string): string {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}
