import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { GOALMAX_MAX_CRITERIA } from '../../../shared/contracts/goalmaxxing';
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
  taskPlan?: Array<{ title: string; detail: string; required?: boolean }>;
  pendingTaskChanges?: {
    add?: Array<{ title: string; detail: string; required?: boolean }>;
    removeCriterionIds?: string[];
  };
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
      description: 'Report bounded interim progress to the GoalMax control plane. During intake, the model may replace provisional criteria with a concrete taskPlan. It may also update phase, attach current evidence IDs to criteria, assign criterion ownership, or report an exact blocker. The completion-candidate outcome remains available for compatibility; prefer goalmax_complete for the final handoff. This tool cannot pause, cancel, clear, budget, elevate permissions, or mark the goal completed.',
      promptGuidelines: [
        'At the first GoalMax turn, submit taskPlan before implementation. Use 2-12 ordered implementation tasks, or more only when necessary.',
        'Give every planned task a distinct action title and a detailed observable completion condition. Do not copy the full objective, use placeholders, duplicate tasks, or add the final verification task.',
        'When new user steering changes remaining scope, use pendingTaskChanges. It may add new pending tasks or remove untouched pending criteria only; it never rewrites the active or completed work.',
        'Use only evidence IDs returned by goalmax_status; prose claims are not evidence.',
        'Use goalmax_complete, not a prose claim, when all work and checks are finished.',
        'Report an exact blocker instead of looping on the same failed action.',
      ],
      parameters: Type.Object({
        outcome: enumString(['progress', 'blocked', 'completion-candidate'], 'Control-plane interpretation of this report.'),
        summary: Type.String({ minLength: 1, maxLength: 4_000 }),
        phase: Type.Optional(enumString(phaseValues, 'Current execution phase.')),
        blocker: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
        taskPlan: Type.Optional(Type.Array(Type.Object({
          title: Type.String({ minLength: 4, maxLength: 240 }),
          detail: Type.String({ minLength: 8, maxLength: 2_000 }),
          required: Type.Optional(Type.Boolean()),
        }, { additionalProperties: false }), { minItems: 2, maxItems: GOALMAX_MAX_CRITERIA - 1 })),
        pendingTaskChanges: Type.Optional(Type.Object({
          add: Type.Optional(Type.Array(Type.Object({
            title: Type.String({ minLength: 4, maxLength: 240 }),
            detail: Type.String({ minLength: 8, maxLength: 2_000 }),
            required: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false }), { maxItems: GOALMAX_MAX_CRITERIA - 1 })),
          removeCriterionIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: GOALMAX_MAX_CRITERIA - 1 })),
        }, { additionalProperties: false })),
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
      promptSnippet: 'Atomically complete GoalMax when current evidence proves the objective',
      description: 'Use exactly once at the end of a GoalMax objective, after implementation and the strongest available checks are finished. The control plane refreshes evidence and atomically marks the goal completed only when every completion condition passes. An incomplete request remains active and returns exact next work without creating a warning state.',
      promptGuidelines: [
        'Call goalmax_status first and use only its current evidence IDs.',
        'Call this only when every user-work criterion has current non-verifier evidence. GoalMax owns the final atomic completion criterion.',
        'If the result says GoalMax completed, stop using tools and end the current root turn.',
        'If completion is not accepted, continue the active goal and resolve the returned items; do not report success in prose.',
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
