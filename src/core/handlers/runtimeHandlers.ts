import type { PiRuntimeService } from '../../main/pi/PiRuntimeService';
import { WorkspaceAdmissionError, type AdmissionAuthority, type SessionAdmission } from '../workspaces/WorkspaceAdmissionQueue';
import type { WorkspaceHandle } from '../workspaces/WorkspaceHandle';
import {
  abortResultSchema, emptyInputSchema, promptAcceptanceSchema, promptInputSchema,
  queueMutationInputSchema, queueMutationResultSchema, runtimeStateSchema,
  setModelInputSchema, setThinkingInputSchema,
} from '../../shared/contracts/ipc';

/** Existing Pi admission/queue and permission rules stay in this captured runtime. */
export function createRuntimeHandlers(runtime: PiRuntimeService, resolveReferencePath?: (path: string) => Promise<string>) {
  return {
    async prompt(input: unknown, expectedSessionId = runtime.getState(false).sessionId, reauthorize?: () => void) {
      const parsed = promptInputSchema.parse(input);
      const sessionReferences = parsed.sessionReferences
        ? await Promise.all(parsed.sessionReferences.map(async (reference) => {
          if (!resolveReferencePath) throw new Error('Session references require host-side path validation.');
          return { ...reference, projectPath: await resolveReferencePath(reference.projectPath) };
        })) : undefined;
      if (runtime.getState(false).sessionId !== expectedSessionId) throw new WorkspaceAdmissionError('STALE_SESSION');
      reauthorize?.();
      return promptAcceptanceSchema.parse(await runtime.prompt({ ...parsed, ...(sessionReferences ? { sessionReferences } : {}) }));
    },
    async abort(input: unknown) {
      emptyInputSchema.parse(input);
      return abortResultSchema.parse(await runtime.abort());
    },
    async setModel(input: unknown) {
      const { provider, id } = setModelInputSchema.parse(input);
      return runtimeStateSchema.parse(await runtime.setModel(provider, id));
    },
    setThinking(input: unknown) {
      const { level } = setThinkingInputSchema.parse(input);
      return runtimeStateSchema.parse(runtime.setThinkingLevel(level));
    },
    async mutateQueue(input: unknown) {
      return queueMutationResultSchema.parse(await runtime.mutateQueuedMessage(queueMutationInputSchema.parse(input)));
    },
  };
}

/** The host must first resolve this handle through registry membership and generation checks. */
export function createScopedRuntimeHandlers(handle: WorkspaceHandle, authorize: () => AdmissionAuthority,
  resolveReferencePath?: (path: string) => Promise<string>) {
  const handlers = createRuntimeHandlers(handle.runtime, resolveReferencePath);
  const admission = handle.admission;
  return {
    prompt(command: SessionAdmission, input: unknown) {
      return admission.run(command, authorize, ({ sessionId }) => handlers.prompt(input, sessionId,
        () => { admission.assertCurrent(command, authorize); }));
    },
    abort(command: SessionAdmission, input: unknown) { return admission.run(command, authorize, () => handlers.abort(input), false, true); },
    setModel(command: SessionAdmission, input: unknown) { return admission.run(command, authorize, () => handlers.setModel(input)); },
    setThinking(command: SessionAdmission, input: unknown) { return admission.run(command, authorize, () => handlers.setThinking(input)); },
    mutateQueue(command: SessionAdmission, input: unknown) { return admission.run(command, authorize, () => handlers.mutateQueue(input)); },
  };
}
