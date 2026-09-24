import { z } from 'zod';

/**
 * Legacy Automations archive format. The standalone Automations tab was merged
 * into the Agents library; this schema exists only to read documents written by
 * the retired `~/.pi/fateGUI/automations/v1` store so they can be imported into
 * TaskTemplates. It is intentionally write-free: nothing in the app creates or
 * updates these files anymore.
 */
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

export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type AutomationPermissionLevel = z.infer<typeof automationPermissionLevelSchema>;
