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
      description: 'Report bounded progress to the GoalMax control plane. The model may update phase, attach current evidence IDs to criteria, assign criterion ownership, report an exact blocker, or request verification. It cannot pause, cancel, clear, budget, elevate permissions, or mark the goal completed.',
      promptGuidelines: [
        'Use only evidence IDs returned by goalmax_status; prose claims are not evidence.',
        'Request completion only after every required criterion appears satisfied and current verification evidence exists.',
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
  ] as ToolDefinition[];
}
