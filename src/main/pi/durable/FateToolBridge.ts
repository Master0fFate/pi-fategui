import type { Context } from '@earendil-works/chord';
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import { assertNativeJson } from './NativeExecutionFence';

export class NativeCapabilityError extends Error {
  readonly code = 'NATIVE_CAPABILITY_UNSUPPORTED';
  constructor(readonly capability: string) {
    super(`Native Pi execution does not yet support ${capability}. Keep this session on the Pi SDK path; no silent fallback is performed.`);
    this.name = 'NativeCapabilityError';
  }
}

export interface FateToolBinding {
  /** The ORIGINAL confined capability, including its live permission and attestation closures. */
  readonly definition: ToolDefinition;
  /** Supply a real host context. The adapter never fabricates an AgentSession or permission UI. */
  readonly context: (api: ToolExecutionApi, context: Context) => ExtensionToolContext | Promise<ExtensionToolContext>;
}

/**
 * Execute the original Fate/SDK tool, not Pi Durable's unconfined filesystem tools.
 * Native Pi owns validation, scheduling and tool receipts. Fate keeps authority/context.
 */
export function bridgeFateTool(binding: FateToolBinding): ToolRegistration {
  const tool = binding.definition;
  if (tool.prepareLoadout !== undefined) throw new NativeCapabilityError(`tool loadout hooks (${tool.name})`);
  if (tool.exposure !== undefined && tool.exposure !== 'direct') throw new NativeCapabilityError(`non-direct tool exposure (${tool.name})`);
  if (tool.outputSchema !== undefined) throw new NativeCapabilityError(`codemode structured-output contracts (${tool.name})`);
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
    ...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
    // No Fate effect is inferred replayable from a native 'safe' flag.
    replay: 'unsafe',
    executionMode: 'sequential',
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      const ctx = await binding.context(api, context);
      let updates = Promise.resolve();
      let updateError: unknown;
      const result = await tool.execute(api.callId, args, context.abortSignal, (update) => {
        // SDK updates are replacement results, not append-only chunks. Retain the full
        // content (including images) in native running details, without duplicating text.
        const evidence = {
          content: update.content,
          ...(update.details === undefined ? {} : { details: update.details }),
          ...(update.structuredContent === undefined ? {} : { structuredContent: update.structuredContent }),
        };
        updates = updates.then(async () => { assertNativeJson(evidence); await api.details({ fate: evidence }, context); }).catch((error: unknown) => { updateError = error; });
      }, ctx);
      await updates;
      if (updateError !== undefined) throw updateError;
      const details = {
        fate: {
          ...(result.details === undefined ? {} : { details: result.details }),
          ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        },
      };
      const nativeResult = {
        content: result.content,
        details,
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(result.terminate ? { control: { terminate: true as const } } : {}),
      };
      assertNativeJson(nativeResult);
      return nativeResult as ToolExecutionResult;
    },
  };
}
