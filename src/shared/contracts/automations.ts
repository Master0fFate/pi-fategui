import { z } from 'zod';

export const AUTOMATION_NAME_MAX_LENGTH = 80;
export const AUTOMATION_PROMPT_MAX_LENGTH = 200_000;
export const AUTOMATION_LIST_LIMIT = 500;

const automationIdSchema = z.string().uuid();
const automationNameSchema = z.string()
  .trim()
  .min(1)
  .max(AUTOMATION_NAME_MAX_LENGTH)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Automation names cannot contain control characters.');
const automationPromptSchema = z.string().trim().min(1).max(AUTOMATION_PROMPT_MAX_LENGTH);

export const automationPermissionLevelSchema = z.enum(['read-only', 'edit']);
export const automationLaunchOutcomeSchema = z.enum(['accepted', 'failed']);

export const automationDefinitionSchema = z.object({
  id: automationIdSchema,
  projectPath: z.string().min(1).max(32_000),
  name: automationNameSchema,
  prompt: automationPromptSchema,
  permissionLevel: automationPermissionLevelSchema,
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
  lastLaunchedAt: z.number().int().nonnegative().safe().nullable(),
  lastLaunchOutcome: automationLaunchOutcomeSchema.nullable(),
  launchCount: z.number().int().nonnegative().max(1_000_000_000),
}).strict();

export const automationListSchema = z.array(automationDefinitionSchema).max(AUTOMATION_LIST_LIMIT);
export const automationCreateInputSchema = z.object({
  name: automationNameSchema,
  prompt: automationPromptSchema,
  permissionLevel: automationPermissionLevelSchema.default('read-only'),
}).strict();
export const automationUpdateInputSchema = automationCreateInputSchema.extend({ id: automationIdSchema }).strict();
export const automationIdInputSchema = z.object({ id: automationIdSchema }).strict();
export const automationLaunchRecordInputSchema = automationIdInputSchema.extend({
  outcome: automationLaunchOutcomeSchema,
}).strict();
export const automationDeleteResultSchema = z.object({ deleted: z.literal(true) }).strict();

export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type AutomationCreateInput = z.infer<typeof automationCreateInputSchema>;
export type AutomationUpdateInput = z.infer<typeof automationUpdateInputSchema>;
export type AutomationPermissionLevel = z.infer<typeof automationPermissionLevelSchema>;
export type AutomationLaunchOutcome = z.infer<typeof automationLaunchOutcomeSchema>;
