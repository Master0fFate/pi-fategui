import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { GoalMaxCoordinator } from './GoalMaxCoordinator';

const phaseValues = ['intake', 'planning', 'research', 'implementation', 'validation', 'verification', 'handoff'] as const;
const reportStatusValues = ['pending', 'active', 'satisfied', 'failed'] as const;

function enumString(values: readonly string[], description: string) {
  return Type.Unsafe<string>({ type: 'string', enum: values, description });
}

export interface GoalMaxReportInput {
  outcome: 'progress' | 'blocked' | 'completion-candidate';
  summary: string;
  phase?: typeof phaseValues[number];
  blocker?: string;
  criterionUpdates?: Array<{ criterionId: string; status: typeof reportStatusValues[number]; evidenceIds?: string[] }>;
  ownerAssignments?: Array<{ criterionId: string; nodeId: string }>;
}

export interface GoalMaxCompletionInput {
  summary: string;
  criterionEvidence?: Array<{ criterionId: string; evidenceIds: string[] }>;
}

export function createGoalMaxTools(coordinator: GoalMaxCoordinator): ToolDefinition[] {
  return [
    defineTool({
      name: 'goalmax_status',
      label: 'Goal status',
      promptSnippet: 'Inspect the active persistent goal and current evidence',
      description: 'Read the authoritative GoalMax objective, lifecycle, criteria, current evidence IDs, blockers, budget, usage, and child assignments. This tool never mutates control-plane state.',
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: 'parallel',
      execute: async (_toolCallId, _params, _signal, _onUpdate, context) => {
        const status = await coordinator.statusForModel(context.sessionManager.getSessionId());
        return { content: [{ type: 'text' as const, text: status.text }], details: status.details };
      },
    }),
    defineTool({
      name: 'goalmax_report',
      label: 'Goal progress',
      promptSnippet: 'Report evidence-linked goal progress, a blocker, or a completion candidate',
      description: 'Report bounded interim progress to the GoalMax control plane. The model may update phase, attach current evidence IDs to criteria, assign criterion ownership, or report an exact blocker. The completion-candidate outcome remains available for compatibility; prefer goalmax_complete for the final handoff. This tool cannot pause, cancel, clear, budget, elevate permissions, or mark the goal completed.',
      promptGuidelines: [
        'Use only evidence IDs returned by goalmax_status; prose claims are not evidence.',
        'Use goalmax_complete, not a prose claim, when all work and checks are finished.',
        'Report an exact blocker instead of looping on the same failed action.',
      ],
      parameters: Type.Object({
        outcome: enumString(['progress', 'blocked', 'completion-candidate'], 'Control-plane interpretation of this report.'),
        summary: Type.String({ minLength: 1, maxLength: 4_000 }),
        phase: Type.Optional(enumString(phaseValues, 'Current execution phase.')),
        blocker: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
        criterionUpdates: Type.Optional(Type.Array(Type.Object({
          criterionId: Type.String({ minLength: 1, maxLength: 160 }),
          status: enumString(reportStatusValues, 'Proposed criterion state. Satisfaction requires current evidence.'),
          evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 64 })),
        }, { additionalProperties: false }), { maxItems: 32 })),
        ownerAssignments: Type.Optional(Type.Array(Type.Object({
          criterionId: Type.String({ minLength: 1, maxLength: 160 }),
          nodeId: Type.String({ minLength: 1, maxLength: 160 }),
        }, { additionalProperties: false }), { maxItems: 64 })),
      }, { additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (_toolCallId, params, _signal, _onUpdate, context) => {
        const result = await coordinator.report(context.sessionManager.getSessionId(), params as GoalMaxReportInput);
        return { content: [{ type: 'text' as const, text: result.text }], details: result.details };
      },
    }),
    defineTool({
      name: 'goalmax_complete',
      label: 'Complete goal',
      promptSnippet: 'Request the verified GoalMax completion gate when all work is finished',
      description: 'Use exactly once at the end of a GoalMax objective, after implementation and the strongest available checks are finished. This requests the independent completion gate and tells the control plane to stop ordinary continuations. It never bypasses required evidence or directly forces a completed state.',
      promptGuidelines: [
        'Call goalmax_status first and use only its current evidence IDs.',
        'Call this only when every required criterion appears satisfied and current verification evidence exists.',
        'After the request is accepted, stop using tools and end the current root turn so the independent completion gate can run.',
        'If work is incomplete or blocked, use goalmax_report instead.',
      ],
      parameters: Type.Object({
        summary: Type.String({ minLength: 1, maxLength: 4_000, description: 'Concise final handoff describing the finished work and checks.' }),
        criterionEvidence: Type.Optional(Type.Array(Type.Object({
          criterionId: Type.String({ minLength: 1, maxLength: 160 }),
          evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 64 }),
        }, { additionalProperties: false }), { maxItems: 32 })),
      }, { additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (_toolCallId, params, _signal, _onUpdate, context) => {
        const result = await coordinator.requestCompletion(context.sessionManager.getSessionId(), params as GoalMaxCompletionInput);
        return { content: [{ type: 'text' as const, text: result.text }], details: result.details };
      },
    }),
  ] as ToolDefinition[];
}
