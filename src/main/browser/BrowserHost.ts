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
import { BrowserError } from './BrowserErrors';
import type { BrowserConfirmationBinding } from './BrowserActionExecutor';
import { BrowserService } from './BrowserService';
import { BrowserHistoryRepository } from './BrowserHistoryRepository';
import { redactSnapshotUrl } from './SemanticSnapshotEngine';

const CONFIRMATION_TTL_MS = 30_000;

interface PendingConfirmation {
  confirmation: BrowserConfirmation;
  digest: string;
  binding: BrowserConfirmationBinding;
  leaseOwner: string;
  owner: BrowserWindow;
  timer: ReturnType<typeof setTimeout>;
  resolve: (approved: boolean) => void;
}

export interface BrowserHostOptions {
  currentProject(): ProjectState | null;
  currentPermissionLevel?(): PermissionLevel;
  bridge: Pick<BrowserRuntimeBridge, 'currentRoot' | 'syncService'>;
  emit(owner: BrowserWindow, event: BrowserEvent): void;
  command(owner: BrowserWindow, command: Extract<AppCommand, 'focus-address' | 'toggle-browser' | 'open-palette'>): void;
  /** Per-project last-URL store. When omitted, reopen starts on the home page. */
  history?: BrowserHistoryRepository;
}

export class BrowserHost {
  private service: BrowserService | null = null;
  private owner: BrowserWindow | null = null;
  private projectPath: string | null = null;
  private pending: PendingConfirmation | null = null;
  private ensuring: { ownerId: number; projectPath: string; promise: Promise<BrowserService> } | null = null;
  private appOverlayBlocked = false;

  constructor(private readonly options: BrowserHostOptions) {}

  current(owner?: BrowserWindow): BrowserService | null {
    if (!this.service || !this.owner || this.owner.isDestroyed()) return null;
    if (owner && owner.webContents.id !== this.owner.webContents.id) return null;
    const project = this.options.currentProject();
    if (!project?.trusted || !samePath(project.path, this.projectPath)) return null;
    this.syncSessionAccess(this.service);
    return this.service;
  }

  async ensure(owner: BrowserWindow): Promise<BrowserService> {
    if (owner.isDestroyed()) throw new BrowserError('ACTION_BLOCKED', 'The application window is unavailable.');
    const project = this.options.currentProject();
    if (!project?.trusted) throw new BrowserError('ACTION_BLOCKED', 'Open and trust a project before using the built-in browser.');
    const current = this.current(owner);
    if (current) {
      if (current.getState().tabs.length === 0) await current.ensureTab();
      this.options.bridge.syncService();
      return current;
    }
    const pending = this.ensuring;
    if (pending) {
      if (pending.ownerId === owner.webContents.id && samePath(project.path, pending.projectPath)) return pending.promise;
      await pending.promise.catch(() => undefined);
      return this.ensure(owner);
    }
    const operation = this.createService(owner, project);
    this.ensuring = { ownerId: owner.webContents.id, projectPath: project.path, promise: operation };
    try {
      return await operation;
    } finally {
      if (this.ensuring?.promise === operation) this.ensuring = null;
    }
  }

  private async createService(owner: BrowserWindow, project: ProjectState): Promise<BrowserService> {
    await this.reset();
    const latest = this.options.currentProject();
    if (owner.isDestroyed() || !latest?.trusted || !samePath(project.path, latest.path)) {
      throw new BrowserError('ACTION_BLOCKED', 'The trusted project changed while the built-in browser was starting.');
    }
    const lastUrl = await this.options.history?.load(project.path).catch(() => null) ?? null;
    const service = new BrowserService(owner, {
      canonicalProjectPath: project.path,
      confirmAction: (action, reason, binding) => this.requestConfirmation(owner, action, reason, binding),
      annotationOwner: () => this.options.bridge.currentRoot(),
      onAppShortcut: (command) => this.options.command(owner, command),
      onNavigated: (url) => { void this.options.history?.save(project.path, url).catch(() => undefined); },
      restoreUrl: lastUrl,
    });
    this.service = service;
    this.owner = owner;
    this.projectPath = project.path;
    this.syncSessionAccess(service);
    service.setEventSink((event) => {
      if (this.service === service && this.owner?.webContents.id === owner.webContents.id && !owner.isDestroyed()) this.options.emit(owner, event);
    });
    try {
      await service.ensureTab();
      if (this.service !== service) throw new BrowserError('ACTION_BLOCKED', 'The built-in browser was replaced while starting.');
      this.options.bridge.syncService();
      return service;
    } catch (error) {
      if (this.service === service) await this.reset();
      else await service.dispose().catch(() => undefined);
      throw error;
    }
  }

  setAppOverlay(owner: BrowserWindow, blocked: boolean): void {
    const service = this.current(owner);
    if (!service || this.appOverlayBlocked === blocked) return;
    this.appOverlayBlocked = blocked;
    // App dialogs cover the renderer, so the native browser view is hidden
    // behind them. The agent stays fully available the whole time; the view
    // returns the moment the dialog closes.
    service.setViewBlocked('app-overlay', blocked);
  }

  respondToConfirmation(owner: BrowserWindow, id: string, approved: boolean): boolean {
    const pending = this.pending;
    const service = this.current(owner);
    if (!pending || pending.owner.webContents.id !== owner.webContents.id || pending.confirmation.id !== id || !service) return false;
    const tab = service.getState().tabs.find((candidate) => candidate.id === pending.confirmation.tabId);
    const lease = service.lease.getState();
    const currentDigest = confirmationDigest(pending.confirmation.action, pending.binding);
    const valid = Date.now() <= pending.confirmation.expiresAt
      && tab?.documentEpoch === pending.confirmation.documentEpoch
      && lease?.ownerSessionId === pending.leaseOwner
      && currentDigest === pending.digest;
    this.clearConfirmation(Boolean(approved && valid));
    return valid;
  }

  async reset(): Promise<void> {
    this.clearConfirmation(false);
    const service = this.service;
    this.service = null;
    this.owner = null;
    this.projectPath = null;
    this.appOverlayBlocked = false;
    if (service) await service.dispose();
  }

  private requestConfirmation(
    owner: BrowserWindow,
    action: ProposedBrowserAction,
    reason: string,
    binding: BrowserConfirmationBinding,
  ): Promise<boolean> {
    const service = this.current(owner);
    const tab = service?.getState().tabs.find((candidate) => candidate.id === binding.tabId);
    const lease = service?.lease.getState();
    if (!service || !tab || tab.documentEpoch !== binding.documentEpoch || !lease) return Promise.resolve(false);
    this.clearConfirmation(false);
    const id = randomUUID();
    const confirmation: BrowserConfirmation = {
      id,
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
        owner,
        timer,
        resolve,
      };
      // This strip is laid out below the native viewport, so the page can
      // remain visible while the user reviews the exact target.
      this.options.emit(owner, { type: 'confirmation-requested', confirmation });
    });
  }

  private clearConfirmation(approved: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (!pending.owner.isDestroyed()) {
      this.options.emit(pending.owner, { type: 'confirmation-cleared', id: pending.confirmation.id, approved });
    }
    pending.resolve(approved);
  }

  private syncSessionAccess(service: BrowserService): void {
    service.setSessionFullAccess(this.options.currentPermissionLevel?.() === 'full-access');
  }
}

function confirmationDigest(
  action: BrowserConfirmation['action'],
  binding: BrowserConfirmationBinding,
): string {
  return createHash('sha256').update(JSON.stringify({ action, ...binding })).digest('hex');
}

function samePath(left: string, right: string | null): boolean {
  if (!right) return false;
  const normalize = (value: string) => {
    const resolved = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return normalize(left) === normalize(right);
}
