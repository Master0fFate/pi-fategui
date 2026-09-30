import { z } from 'zod';
import { uuidSchema } from './requestIds';
import { capabilitySchema, type Capability } from './methods';

/** Availability is a support claim, not authority. Trust, control and permission are checked separately. */
export const featureSupportSchema = z.object({
  monitor: z.boolean(), nativeBrowser: z.boolean(), microphone: z.boolean(), hotkeys: z.boolean(),
  updater: z.boolean(), ambientAudio: z.boolean(), manualTerminal: z.boolean(), localFileOpen: z.boolean(), clipboardText: z.boolean(),
}).strict();
export type Feature = keyof z.infer<typeof featureSupportSchema>;
export type FeatureSupport = z.infer<typeof featureSupportSchema>;
const workspaceSchema = z.object({
  workspaceId: uuidSchema, label: z.string().min(1).max(128),
  supported: z.object({ monitor: z.boolean(), operations: z.array(capabilitySchema).max(6)
    .refine((items) => new Set(items).size === items.length) }).strict(),
}).strict();
export const hostCapabilitySchema = z.object({
  version: z.literal(1), protocol: z.literal(1), hostId: uuidSchema, serverEpoch: uuidSchema,
  platform: z.enum(['win32', 'linux', 'darwin']),
  supported: featureSupportSchema, workspaces: z.array(workspaceSchema).max(8),
}).strict().refine((host) => new Set(host.workspaces.map((workspace) => workspace.workspaceId)).size === host.workspaces.length);
export type HostCapabilities = z.infer<typeof hostCapabilitySchema>;
export const clientCapabilitySchema = z.object({ version: z.literal(1), supported: featureSupportSchema }).strict();
export type ClientCapabilities = z.infer<typeof clientCapabilitySchema>;

export const desktopClientCapabilities: ClientCapabilities = Object.freeze({ version: 1, supported: Object.freeze({
  monitor: true, nativeBrowser: true, microphone: true, hotkeys: true, updater: true, ambientAudio: true,
  manualTerminal: true, localFileOpen: true, clipboardText: true,
}) });
/** Local-only default. An authenticated server must supply its own real host identity and epoch. */
export const desktopHostCapabilities: HostCapabilities = Object.freeze({
  version: 1, protocol: 1, hostId: '00000000-0000-4000-8000-000000000001',
  serverEpoch: '00000000-0000-4000-8000-000000000002', platform: 'win32',
  supported: desktopClientCapabilities.supported, workspaces: [],
});
export function intersectCapabilities(host: HostCapabilities, client: ClientCapabilities): FeatureSupport {
  const h = hostCapabilitySchema.parse(host).supported;
  const c = clientCapabilitySchema.parse(client).supported;
  return {
    monitor: h.monitor && c.monitor, nativeBrowser: h.nativeBrowser && c.nativeBrowser,
    microphone: h.microphone && c.microphone, hotkeys: h.hotkeys && c.hotkeys,
    updater: h.updater && c.updater, ambientAudio: h.ambientAudio && c.ambientAudio,
    manualTerminal: h.manualTerminal && c.manualTerminal,
    localFileOpen: h.localFileOpen && c.localFileOpen, clipboardText: h.clipboardText && c.clipboardText,
  };
}
export function supportsWorkspaceOperation(host: HostCapabilities, workspaceId: string, capability: Capability): boolean {
  const verified = hostCapabilitySchema.parse(host);
  return verified.workspaces.some((workspace) => workspace.workspaceId === workspaceId && workspace.supported.operations.includes(capability));
}

export function supportsHostOperation(host: HostCapabilities, feature: Feature, workspaceId?: string): boolean {
  const verified = hostCapabilitySchema.parse(host);
  if (!verified.supported[feature]) return false;
  if (feature !== 'monitor' || workspaceId === undefined) return true;
  return verified.workspaces.some((workspace) => workspace.workspaceId === workspaceId && workspace.supported.monitor);
}
