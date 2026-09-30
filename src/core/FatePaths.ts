import os from 'node:os';
import path from 'node:path';
import type { FatePathConfiguration } from './ports';

function absolutePath(value: string): string {
  if (!value || value.includes('\0') || !path.isAbsolute(value)) throw new Error('Fate paths must be explicit absolute host paths.');
  return path.normalize(value);
}

/** Pure path description. In particular, never pre-create the provider data root. */
export class FatePaths implements FatePathConfiguration {
  readonly dataRoot: string;
  readonly piAgentDir: string;
  readonly sessionsRoot: string;
  readonly attachmentRoot: string;
  readonly lockRoot: string;
  readonly profileId: string;
  readonly profileKind: 'desktop' | 'server';

  constructor(configuration: FatePathConfiguration) {
    this.dataRoot = absolutePath(configuration.dataRoot);
    this.piAgentDir = absolutePath(configuration.piAgentDir);
    this.sessionsRoot = absolutePath(configuration.sessionsRoot);
    this.attachmentRoot = absolutePath(configuration.attachmentRoot);
    this.lockRoot = absolutePath(configuration.lockRoot);
    if (!configuration.profileId.trim() || configuration.profileId.includes('\0')) throw new Error('A host profile identity is required.');
    this.profileId = configuration.profileId;
    this.profileKind = configuration.profileKind ?? 'server';
    Object.freeze(this);
  }
}

export interface DesktopFatePathsOptions {
  readonly home?: string;
  readonly temporaryDirectory?: string;
  readonly dataRoot?: string;
  /** Pass the desktop SDK's resolved agent directory when composing the runtime. */
  readonly piAgentDir?: string;
  readonly profileId?: string;
}

export function desktopFateDataRoot(home = os.homedir(), configured = process.env.FATE_GUI_DATA_DIR): string {
  // Match the existing project/settings desktop defaults, including relative overrides.
  return configured ? path.resolve(configured) : path.join(home, '.pi', 'fateGUI');
}

/** Existing desktop defaults only. Server defaults and migration belong to T26. */
export function createDesktopFatePaths(options: DesktopFatePathsOptions = {}): FatePaths {
  const home = options.home ?? os.homedir();
  const configuredAgent = process.env.PI_CODING_AGENT_DIR;
  const defaultAgent = configuredAgent
    ? configuredAgent.replace(/^~(?=$|[/\\])/u, home)
    : path.join(home, '.pi', 'agent');
  const piAgentDir = path.resolve(options.piAgentDir ?? defaultAgent);
  const dataRoot = options.dataRoot ? path.resolve(options.dataRoot) : desktopFateDataRoot(home);
  return new FatePaths({
    dataRoot,
    piAgentDir,
    sessionsRoot: path.join(piAgentDir, 'sessions'),
    // Reserved, not created or used by existing desktop attachment handling.
    attachmentRoot: path.join(options.temporaryDirectory ?? os.tmpdir(), 'fate-ui-attachments'),
    // Separate from dataRoot: acquiring a future lock must not suppress provider first-run import.
    lockRoot: path.join(home, '.pi', 'fate-locks'),
    profileId: options.profileId ?? 'desktop',
    profileKind: 'desktop',
  });
}
