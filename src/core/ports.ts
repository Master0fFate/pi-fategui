import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/** Host-owned configuration, never derived from a client workspace path. */
export interface FatePathConfiguration {
  readonly dataRoot: string;
  readonly piAgentDir: string;
  readonly sessionsRoot: string;
  readonly attachmentRoot: string;
  readonly lockRoot: string;
  readonly profileId: string;
  /** Trusted startup policy, independent of the display/profile name. */
  readonly profileKind?: 'desktop' | 'server';
}

export interface ClockPort {
  now(): number;
}

export interface LogPort {
  write(level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string): void;
}

export type ProjectTrustDecision = 'trust' | 'open-without-pi' | 'cancel';
export interface ProjectTrustRequest {
  readonly path: string;
  readonly name: string;
}

/** Supplied by the trusted host, not project content or an RPC payload. */
export interface ProjectTrustPort {
  decide(request: ProjectTrustRequest): Promise<ProjectTrustDecision>;
}

/** Host configuration owns this allowlist; clients cannot register filesystem paths. */
export interface ProjectRegistrationPort {
  isRegistered(canonicalPath: string): boolean;
}

/** Provenance is chosen by the host adapter, not inferred from a path string. */
export interface HostFileReference {
  readonly origin: 'local' | 'remote';
  readonly path: string;
}

/** Only the desktop host supplies this port. Empty openPath result means success. */
export interface LocalFileActionsPort {
  openPath(file: HostFileReference): Promise<string>;
  showItemInFolder(file: HostFileReference): void | Promise<void>;
}

/** Host-local presentation only. The runtime validates HTTPS before invoking it. */
export interface ProviderAuthUrlPort {
  present(url: string): void | Promise<void>;
}

export interface AttentionPort {
  sessionSettled(): void;
}

export interface ActiveBrowserRoot {
  projectPath: string;
  sessionId: string;
}

/** The existing Pi browser seam, owned here so public ports do not depend on native implementations. */
export interface BrowserIntegrationPort {
  createTools(): ToolDefinition[];
  appendAnnotationContext(text: string, annotationIds: readonly string[], sessionId?: string): Promise<string>;
  /** A user-tagged saved session may share a bounded, read-only view of its live browser. */
  readTaggedBrowserContext?(root: ActiveBrowserRoot): Promise<string | null>;
  /** Register only live, trusted root sessions; background roots may use their own browser. */
  registerSession?(root: ActiveBrowserRoot, permissionLevel?: 'read-only' | 'edit' | 'full-access'): void;
  revokeSession?(root: ActiveBrowserRoot): void;
  currentRoot(): ActiveBrowserRoot | null;
  setActiveRoot(root: ActiveBrowserRoot | null): void;
  clearActiveRoot?(projectPath: string): void;
  setFocusedProjectPath?(projectPath: string | null): void;
}

export class UnsupportedHostCapabilityError extends Error {
  readonly code = 'UNSUPPORTED_CAPABILITY';

  constructor(readonly capability: string) {
    super(`Unsupported host capability: ${capability}. This action requires the local desktop host.`);
    this.name = 'UnsupportedHostCapabilityError';
  }
}
