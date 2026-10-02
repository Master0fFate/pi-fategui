import type { StatePersistenceBackend } from '../shared/v2FeaturePolicy';
import type { AgentsService } from '../main/agents/AgentsService';
import type { LearningService } from '../main/learning/LearningService';
import type { AppLogService } from '../main/logging/AppLogService';
import type { MultiProjectPiRuntime } from '../main/pi/MultiProjectPiRuntime';
import type { SessionPermissionPersistence } from '../main/pi/SessionPermissionStore';
import type { MutationAttestationLedger } from '../main/pi/provenance/MutationAttestationLedger';
import type { SettingsService } from '../main/settings/SettingsService';
import type { FatePaths } from './FatePaths';
import type { RecoveryCoordinator, RecoveryResult } from './recovery/RecoveryCoordinator';
import type { WorkspaceEventHub } from './events/WorkspaceEventHub';
import type { ProjectTrustService } from './projects/ProjectTrustService';
import type { WorkspaceRegistry } from './workspaces/WorkspaceRegistry';
import type { CoreClient, CoreClientResources, CoreLifecycle, CoreShutdownResult } from './lifecycle/CoreLifecycle';

/** Host-internal handles, not an RPC surface or a generic service reflection API. */
export interface FateCore {
  readonly paths: FatePaths;
  readonly statePersistence: StatePersistenceBackend;
  readonly executionRecoveryMode: 'ordinary' | 'explicit-work-only';
  /** Read-only startup projection; never permission to resume an uncertain run. */
  readonly recovery: RecoveryCoordinator;
  readonly recovered: RecoveryResult;
  readonly logs: AppLogService;
  readonly settings: SettingsService;
  readonly projects: ProjectTrustService;
  readonly learning: LearningService;
  readonly sessionPermissions: SessionPermissionPersistence;
  readonly attestations: MutationAttestationLedger;
  /** The sole existing multi-project runtime owner created by this factory. */
  readonly runtime: MultiProjectPiRuntime;
  /** Dormant until a trusted transport resolves workspace membership; no listener. */
  readonly events: WorkspaceEventHub;
  /** Absent unless the trusted host supplies registration and membership sources. */
  readonly workspaces: WorkspaceRegistry | null;
  /** Absent unless the host explicitly owns saved Agents/Routines in this core. */
  readonly savedAgents: AgentsService | null;
  /** Transport cleanup is separate from core ownership and cannot stop shared work. */
  readonly lifecycle: CoreLifecycle;
  createClient(resources?: CoreClientResources): CoreClient;
  disposeClient(client: CoreClient): Promise<void>;
  /** Idempotently fence admissions, request stop, flush state, and report a bounded honest result. */
  shutdownCore(): Promise<CoreShutdownResult>;
  /** Await actual owned-resource cleanup; rejects while ownership remains uncertain. */
  dispose(): Promise<void>;
}
