import { clientCapabilitySchema, desktopClientCapabilities, desktopHostCapabilities, hostCapabilitySchema,
  intersectCapabilities, supportsHostOperation, type ClientCapabilities, type Feature, type FeatureSupport, type HostCapabilities } from '../../shared/protocol/capabilities';

/** Parse external negotiation at installation. Never infer server support from the presence of a method. */
export function negotiateCapabilities(host: HostCapabilities = desktopHostCapabilities,
  client: ClientCapabilities = desktopClientCapabilities, workspaceId?: string): FeatureSupport {
  const verified = hostCapabilitySchema.parse(host);
  const common = intersectCapabilities(verified, clientCapabilitySchema.parse(client));
  // Remote monitoring cannot be inferred from a host-wide flag. Until a trusted
  // adapter binds a workspace ID, a registered host must fail closed.
  return { ...common, monitor: common.monitor && (verified.workspaces.length === 0
    ? verified === desktopHostCapabilities || host === desktopHostCapabilities
    : workspaceId !== undefined && supportsHostOperation(verified, 'monitor', workspaceId)) };
}
export function capabilityAvailable(available: FeatureSupport | undefined, feature: Feature): boolean {
  return available?.[feature] === true;
}
export const unavailableExplanation: Readonly<Record<Feature, string>> = {
  monitor: 'Monitoring is unavailable on this host.',
  nativeBrowser: 'The built-in browser is available only on local desktop.',
  microphone: 'Voice capture is unavailable on this client or host.',
  hotkeys: 'Native voice hotkeys are unavailable on this client or host.',
  updater: 'Application updates are managed on the local desktop.',
  ambientAudio: 'Ambient audio is available only on local desktop.',
  manualTerminal: 'The manual terminal is not enabled on this host.',
  localFileOpen: 'This file is on the host. Open it in the host file view, not on this computer.',
  clipboardText: 'Clipboard access is unavailable on this client.',
};
