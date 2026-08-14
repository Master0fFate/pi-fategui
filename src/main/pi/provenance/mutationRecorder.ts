import type { PermissionLevel } from '../../../shared/contracts/ipc';
import type { AppLogService } from '../../logging/AppLogService';
import type { MutationAttestation } from '../../../shared/contracts/mutationAttestation';
import {
  buildAttestation,
  type AttestationContext,
  type AttestationRecordInput,
  type AttestationSink,
} from './attestationRecord';
import type { MutationAttestationLedger } from './MutationAttestationLedger';

/**
 * Narrow recorder threaded through the runtime layers. The concrete ledger is
 * imported only by {@link createMutationRecorder}; every other layer depends on
 * this function type, never on the repository.
 */
export type MutationRecorder = (input: AttestationRecordInput) => void;

/**
 * Build a recorder that validates, hashes, and enqueues an attestation. A ledger
 * failure is logged but never propagated: the tool write already succeeded and
 * attestation is best-effort. Logs follow the existing safe conventions (no
 * content, paths, or credentials).
 */
export function createMutationRecorder(ledger: MutationAttestationLedger, logs: AppLogService): MutationRecorder {
  return (input) => {
    let attestation: MutationAttestation | null;
    try {
      attestation = buildAttestation(input);
    } catch (error) {
      logs.write('warn', 'attestations', `Attestation build failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!attestation) return;
    void ledger.record(attestation).catch((error) => {
      logs.write('warn', 'attestations', `Attestation record failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
}

export interface RootAttestationSinkDeps {
  /** Active root AgentSession id at write time, or null when unavailable. */
  resolveSessionId: () => string | null;
  /** Current root permission level at write time (tracks setPermissionLevel). */
  resolvePermissionLevel: () => PermissionLevel | null;
  /** Whether a project is open; the root actor is skipped otherwise. */
  hasProject: () => boolean;
  record: MutationRecorder;
}

export function buildRootAttestationSink(deps: RootAttestationSinkDeps): AttestationSink {
  const context = (): AttestationContext | null => (
    deps.hasProject()
      ? { actor: { kind: 'root' }, sessionId: deps.resolveSessionId(), permissionLevel: deps.resolvePermissionLevel() }
      : null
  );
  return { resolveContext: context, record: deps.record };
}

export interface ChildAttestationHandle {
  /** Set to the child AgentSession id once the child session exists. */
  sessionId: string | null;
}

export interface ChildAttestationSinkDeps {
  /** Team identity; when present with teamId+nodeId the actor is a team actor. */
  teamIdentity?: { teamId?: string; nodeId?: string };
  /** Legacy subagent identity. */
  runId?: string;
  parentToolCallId?: string;
  /** Static launch-time permission level; used only when no dynamic resolver is supplied. */
  permissionLevel: PermissionLevel;
  handle: ChildAttestationHandle;
  record: MutationRecorder;
  /** Resolves the node's CURRENT task id at write time (team nodes reuse sessions across tasks). */
  resolveCurrentTaskId?: (teamId: string, nodeId: string) => string | undefined;
  /** Resolves the node's CURRENT permission at write time (team nodes can be capped/lowered). Falls back to permissionLevel. */
  resolvePermissionLevel?: () => PermissionLevel | null;
}

/**
 * Build a child attestation sink. Returns undefined when no truthful identity is
 * available (the write is not attested). The team taskId is resolved dynamically
 * at write time so a node that reuses its session across tasks is not frozen to
 * the first task.
 */
export function buildChildAttestationSink(deps: ChildAttestationSinkDeps): AttestationSink | undefined {
  const team = deps.teamIdentity;
  if (team?.teamId && team?.nodeId) {
    const teamId = team.teamId;
    const nodeId = team.nodeId;
    return {
      resolveContext: () => {
        const taskId = deps.resolveCurrentTaskId?.(teamId, nodeId);
        // When a dynamic resolver exists, use its current value verbatim: a
        // null/undefined result means the node is gone, and the row records
        // permission=null rather than the stale launch-time level. The static
        // launch-time level is used only when no resolver was supplied.
        const permissionLevel = deps.resolvePermissionLevel
          ? (deps.resolvePermissionLevel() ?? null)
          : deps.permissionLevel;
        const actor = taskId ? { kind: 'team' as const, teamId, nodeId, taskId } : { kind: 'team' as const, teamId, nodeId };
        return { actor, sessionId: deps.handle.sessionId, permissionLevel };
      },
      record: deps.record,
    };
  }
  if (deps.runId && deps.parentToolCallId) {
    const runId = deps.runId;
    const parentToolCallId = deps.parentToolCallId;
    return {
      resolveContext: () => {
        // When a dynamic resolver exists, use its current value verbatim: a
        // null/undefined result means the run is gone, and the row records
        // permission=null rather than the stale launch-time level. The static
        // launch-time level is used only when no resolver was supplied.
        const permissionLevel = deps.resolvePermissionLevel
          ? (deps.resolvePermissionLevel() ?? null)
          : deps.permissionLevel;
        return { actor: { kind: 'legacy', runId, parentToolCallId }, sessionId: deps.handle.sessionId, permissionLevel };
      },
      record: deps.record,
    };
  }
  return undefined;
}
