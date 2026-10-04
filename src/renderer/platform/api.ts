import type { PiDesktopApi } from '../../shared/contracts/ipc';
import { selectFateMethods, type FateApi } from '../../client/FateApi';
import type { NetworkWorkspaceApi } from '../../client/NetworkWorkspaceApi';
import type { DesktopConnectionApi, DesktopConnectionState } from '../../shared/contracts/connections';
import type { RemoteDesktopFateApi } from './RemoteDesktopFateApi';
import { bootstrapDesktopFateApi, createDesktopFateApi, readDesktopBridge, selectDesktopMethods, type DesktopFateApi, type DesktopOnlyApi } from './DesktopFateApi';
import { desktopClientCapabilities, desktopHostCapabilities, type ClientCapabilities, type Feature, type FeatureSupport, type HostCapabilities } from '../../shared/protocol/capabilities';
import { capabilityAvailable, negotiateCapabilities } from './capabilityPolicy';
import type { ManualTerminalApi } from '../../shared/contracts/terminal';

export type RendererFateApi = FateApi & { readonly desktop?: DesktopOnlyApi; readonly web?: NetworkWorkspaceApi;
  readonly connections?: DesktopConnectionApi; readonly remote?: RemoteDesktopFateApi; readonly capabilities?: FeatureSupport;
  readonly terminal?: ManualTerminalApi };
const browserFeatureSupport: FeatureSupport = Object.freeze({
  monitor: false, nativeBrowser: false, microphone: false, hotkeys: false, updater: false,
  ambientAudio: false, manualTerminal: false, localFileOpen: false, clipboardText: false,
});
type EventChannel = 'onEvents' | 'onGoalMaxEvents' | 'onTaskEvents';
type NativeEventChannel = 'onWindowState' | 'onBrowserLinkOpen' | 'onBrowserEvents'
  | 'onUpdatesProgress' | 'onSpeechDownload' | 'onSpeechStreamUpdate'
  | 'onVoiceHotkey' | 'onMusicDurations' | 'onTerminalEvent'
  | 'onAppCommand' | 'onAgentLibraryChanged' | 'onLearningChanged';

let current: RendererFateApi | null = null;
let bridge: PiDesktopApi | null = null;
let releaseCurrent: (() => void) | null = null;
let explicitlyInstalled = false;
let activeCapabilities: FeatureSupport | null = null;
let connectionState: DesktopConnectionState | null = null;
let releaseConnectionState: (() => void) | null = null;
let connectionRevision = 0;
let connectionInitialization = 0;
const connectionListeners = new Set<() => void>();
export function subscribeDesktopConnection(listener: () => void): () => void {
  connectionListeners.add(listener); return () => { connectionListeners.delete(listener); };
}
export function getDesktopConnectionRevision(): number { return connectionRevision; }
export function getDesktopConnectionState(): DesktopConnectionState | null { return connectionState; }
function updateConnectionState(state: DesktopConnectionState): void {
  connectionState = state; connectionRevision++;
  for (const listener of connectionListeners) listener();
}
/** Resolve persisted selection BEFORE a desktop App can hydrate local host data. Failure never selects local. */
export async function initializeDesktopConnections(): Promise<void> {
  const api = getFateApiOptional();
  if (!api?.remote || typeof api.connections?.getConnectionState !== 'function') return;
  const initialization = ++connectionInitialization;
  const revision = connectionRevision;
  const currentInitialization = () => initialization === connectionInitialization && getFateApiOptional() === api;
  releaseConnectionState?.();
  releaseConnectionState = api.connections.onConnectionState((state) => {
    if (currentInitialization() && (!connectionState || state.generation >= connectionState.generation)) updateConnectionState(state);
  });
  try {
    const state = await api.remote.initialize();
    // A newer event or explicit host selection wins over this delayed initial read.
    if (currentInitialization() && connectionRevision === revision) updateConnectionState(state);
  } catch {
    if (!currentInitialization() || connectionRevision !== revision) return;
    connectionState = null; connectionRevision++;
    for (const listener of connectionListeners) listener();
    throw new Error('Connection selection is unavailable. Local execution was not selected.');
  }
}

function managed(api: RendererFateApi): { api: RendererFateApi; release: () => void } {
  const subscriptions = new Map<EventChannel, () => void>();
  const nativeSubscriptions = new Set<() => void>();
  const desktop = api.desktop;
  const terminal = api.terminal;
  const wrappedTerminal: ManualTerminalApi | undefined = terminal && {
    createTerminal: (cols, rows) => terminal.createTerminal(cols, rows),
    writeTerminal: (id, data) => terminal.writeTerminal(id, data),
    acknowledgeTerminal: (id, characters) => terminal.acknowledgeTerminal(id, characters),
    resizeTerminal: (id, cols, rows) => terminal.resizeTerminal(id, cols, rows),
    closeTerminal: (id) => terminal.closeTerminal(id),
    onTerminalEvent: (listener) => {
      const unsubscribe = terminal.onTerminalEvent(listener);
      const cleanup = () => { if (nativeSubscriptions.delete(cleanup)) unsubscribe(); };
      nativeSubscriptions.add(cleanup);
      return cleanup;
    },
  };
  const trackNative = <K extends NativeEventChannel>(channel: K): DesktopOnlyApi[K] => {
    const subscribe = desktop![channel];
    return ((listener: never) => {
      const unsubscribe = subscribe.call(desktop, listener);
      let active = true;
      const cleanup = () => {
        if (!active) return;
        active = false;
        nativeSubscriptions.delete(cleanup);
        unsubscribe();
      };
      nativeSubscriptions.add(cleanup);
      return cleanup;
    }) as DesktopOnlyApi[K];
  };
  const wrappedDesktop = desktop && {
    ...selectDesktopMethods(desktop),
    ...(typeof desktop.onWindowState === 'function' ? { onWindowState: trackNative('onWindowState') } : {}),
    ...(typeof desktop.onBrowserLinkOpen === 'function' ? { onBrowserLinkOpen: trackNative('onBrowserLinkOpen') } : {}),
    ...(typeof desktop.onBrowserEvents === 'function' ? { onBrowserEvents: trackNative('onBrowserEvents') } : {}),
    ...(typeof desktop.onUpdatesProgress === 'function' ? { onUpdatesProgress: trackNative('onUpdatesProgress') } : {}),
    ...(typeof desktop.onSpeechDownload === 'function' ? { onSpeechDownload: trackNative('onSpeechDownload') } : {}),
    ...(typeof desktop.onSpeechStreamUpdate === 'function' ? { onSpeechStreamUpdate: trackNative('onSpeechStreamUpdate') } : {}),
    ...(typeof desktop.onVoiceHotkey === 'function' ? { onVoiceHotkey: trackNative('onVoiceHotkey') } : {}),
    ...(typeof desktop.onMusicDurations === 'function' ? { onMusicDurations: trackNative('onMusicDurations') } : {}),
    ...(typeof desktop.onTerminalEvent === 'function' ? { onTerminalEvent: trackNative('onTerminalEvent') } : {}),
    ...(typeof desktop.onAppCommand === 'function' ? { onAppCommand: trackNative('onAppCommand') } : {}),
    ...(typeof desktop.onAgentLibraryChanged === 'function' ? { onAgentLibraryChanged: trackNative('onAgentLibraryChanged') } : {}),
    ...(typeof desktop.onLearningChanged === 'function' ? { onLearningChanged: trackNative('onLearningChanged') } : {}),
  };
  const wrap = <K extends EventChannel>(channel: K): FateApi[K] => {
    // The three signatures differ in listener payload; preserve each through
    // its own typed assignment below rather than accepting a generic channel.
    return ((listener: never) => {
      if (subscriptions.has(channel)) throw new Error(`${channel} already subscribed`);
      let active = true;
      const unsubscribe = api[channel](listener);
      const cleanup = () => {
        if (!active) return;
        active = false;
        subscriptions.delete(channel);
        unsubscribe();
      };
      subscriptions.set(channel, cleanup);
      return cleanup;
    }) as FateApi[K];
  };
  return {
    api: {
      ...selectFateMethods(api),
      ...(wrappedDesktop ? { desktop: wrappedDesktop } : {}),
      ...(api.web ? { web: api.web } : {}),
      ...(wrappedTerminal ? { terminal: wrappedTerminal } : {}),
      ...(api.connections ? { connections: api.connections } : {}),
      ...(api.remote ? { remote: api.remote } : {}),
      ...(typeof api.onEvents === 'function' ? { onEvents: wrap('onEvents') } : {}),
      ...(typeof api.onGoalMaxEvents === 'function' ? { onGoalMaxEvents: wrap('onGoalMaxEvents') } : {}),
      ...(typeof api.onTaskEvents === 'function' ? { onTaskEvents: wrap('onTaskEvents') } : {}),
    },
    release: () => {
      for (const cleanup of [...subscriptions.values()]) cleanup();
      for (const cleanup of [...nativeSubscriptions]) cleanup();
      api.web?.close();
      api.remote?.close();
    },
  };
}

function activate(api: RendererFateApi, capabilities: FeatureSupport): void {
  releaseCurrent?.();
  const next = managed(api);
  // Support requires both negotiation and an actual local adapter. A web facade
  // cannot gain native calls merely because a host advertises them.
  const negotiated = next.api.desktop ? capabilities : {
    ...capabilities, nativeBrowser: false, microphone: false, hotkeys: false,
    updater: false, ambientAudio: false, localFileOpen: false,
  };
  const available: FeatureSupport = { ...negotiated, get manualTerminal() {
    if (next.api.web) return Boolean(next.api.terminal && next.api.web.supports('terminal.manual'));
    if (next.api.remote && typeof next.api.connections?.getConnectionState === 'function' && connectionState?.kind !== 'local') return false;
    return Boolean(next.api.desktop && capabilities.manualTerminal);
  } };
  current = { ...next.api, capabilities: available };
  activeCapabilities = available;
  releaseCurrent = next.release;
}

/** Install before stores mount. Duplicate boot cannot register two event sinks. */
export function installFateApi(api: RendererFateApi, host: HostCapabilities = desktopHostCapabilities,
  client: ClientCapabilities = desktopClientCapabilities, workspaceId?: string): () => void {
  if (explicitlyInstalled) throw new Error('Fate API already installed');
  activate(api, negotiateCapabilities(host, client, workspaceId));
  explicitlyInstalled = true;
  const installed = current;
  return () => { if (current === installed) resetFateApi(); };
}

/** Test/renderer teardown; closes subscriptions before another API is installed. */
export function resetFateApi(): void {
  connectionInitialization++;
  releaseConnectionState?.(); releaseConnectionState = null; connectionState = null;
  connectionRevision++;
  releaseCurrent?.();
  releaseCurrent = null;
  current = null;
  activeCapabilities = null;
  bridge = null;
  explicitlyInstalled = false;
}

export function getFateApiOptional(): RendererFateApi | null {
  if (explicitlyInstalled) return current;
  // The desktop preload is read in this platform boundary only. Test fixtures
  // can replace their bridge between cases without retaining stale listeners.
  const available = readDesktopBridge();
  if (!available) {
    if (current) resetFateApi();
    return null;
  }
  if (bridge !== available) {
    bridge = available;
    activate(createDesktopFateApi(available), negotiateCapabilities());
  }
  return current;
}

export function getFateApi(): RendererFateApi {
  const api = getFateApiOptional();
  if (!api) throw new Error('Fate API is unavailable');
  return api;
}

export function getDesktopApiOptional(): DesktopOnlyApi | undefined {
  return getFateApiOptional()?.desktop;
}

/** Browser operations are explicit; no native bridge or fake RuntimeState is installed. */
export function installWebFateApi(web: NetworkWorkspaceApi & { readonly shared: FateApi; readonly terminal?: ManualTerminalApi | undefined }): () => void {
  if (explicitlyInstalled) throw new Error('Fate API already installed');
  activate({ ...web.shared, web, ...(web.terminal ? { terminal: web.terminal } : {}) }, browserFeatureSupport);
  explicitlyInstalled = true;
  const installed = current;
  return () => { if (current === installed) resetFateApi(); };
}
export function getWebApiOptional(): NetworkWorkspaceApi | undefined {
  const api = getFateApiOptional();
  if (api?.web) return api.web;
  // Unknown/unavailable persisted selection is fail-closed remote, not local fallback.
  return api?.remote && typeof api.connections?.getConnectionState === 'function'
    && connectionState?.kind !== 'local' ? api.remote : undefined;
}
export function getDesktopConnectionsOptional(): DesktopConnectionApi | undefined { return getFateApiOptional()?.connections; }

export function getDesktopApi(): DesktopOnlyApi {
  const desktop = getDesktopApiOptional();
  if (!desktop) throw new Error('Desktop-only operation is unavailable');
  return desktop;
}

export function hasCapability(feature: Feature): boolean {
  const api = getFateApiOptional();
  if (feature === 'manualTerminal' && api?.web) return Boolean(api.terminal && api.web.supports('terminal.manual'));
  if (api?.remote && getWebApiOptional()
    && ['nativeBrowser', 'microphone', 'hotkeys', 'ambientAudio', 'manualTerminal', 'localFileOpen'].includes(feature)) return false;
  return capabilityAvailable(activeCapabilities ?? undefined, feature);
}

/** Remote desktop has no terminal transport. Never fall back to a local shell. */
export function getTerminalApiOptional(): ManualTerminalApi | undefined {
  const api = getFateApiOptional();
  if (!api || !hasCapability('manualTerminal')) return undefined;
  if (api.web) return api.terminal;
  if (api.remote && getWebApiOptional()) return undefined;
  return api.desktop;
}

export function hasDesktopApi(): boolean { return Boolean(getDesktopApiOptional()); }
export function createDesktopApi(bridge: PiDesktopApi): DesktopFateApi { return createDesktopFateApi(bridge); }
export function installDesktopFateApi(): void { installFateApi(bootstrapDesktopFateApi()); }
