import { z } from 'zod';

export const monitorSectionSchema = z.enum(['overview', 'runs', 'teams', 'tasks', 'activity']);
export const monitorReadInputSchema = z.object({
  section: monitorSectionSchema.default('overview'),
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(100).default(10),
  sinceRevision: z.string().max(80).optional(),
}).strict();

export const monitorItemSchema = z.object({
  id: z.string().max(250),
  source: z.enum(['runs', 'teams', 'tasks', 'activity']),
  state: z.enum(['normal', 'active', 'attention']),
  title: z.string().max(200),
  detail: z.string().max(500),
  updatedAt: z.number().finite(),
  /** Existing run/node/task/event identifiers for a detailed investigation. */
  ref: z.object({ kind: z.enum(['run', 'team-node', 'task', 'event']), id: z.string().max(250), teamId: z.string().max(250).optional() }).strict(),
}).strict();
export const monitorDashboardSchema = z.object({
  projectPath: z.string().min(1),
  sessionId: z.string().nullable(),
  checkedAt: z.number().finite(),
  revision: z.string().min(1).max(64),
  overall: z.enum(['normal', 'active', 'attention', 'unknown']),
  /** A source failure is not a clean bill of health. */
  sources: z.object({
    runs: z.enum(['ready', 'partial', 'unknown']),
    teams: z.enum(['ready', 'unknown']),
    tasks: z.enum(['ready', 'unknown']),
    activity: z.enum(['ready', 'unknown']),
  }).strict(),
  sourceCheckedAt: z.object({ runs: z.number().finite().nullable(), teams: z.number().finite().nullable(), tasks: z.number().finite().nullable(), activity: z.number().finite().nullable() }).strict(),
  counts: z.object({ active: z.number().int().nonnegative(), attention: z.number().int().nonnegative(), runs: z.number().int().nonnegative(), teams: z.number().int().nonnegative(), tasks: z.number().int().nonnegative(), activity: z.number().int().nonnegative() }).strict(),
  section: monitorSectionSchema,
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  unchanged: z.boolean(),
  items: z.array(monitorItemSchema).max(100),
}).strict();

export type MonitorReadInput = z.input<typeof monitorReadInputSchema>;
export type MonitorDashboard = z.infer<typeof monitorDashboardSchema>;
export type MonitorItem = z.infer<typeof monitorItemSchema>;
