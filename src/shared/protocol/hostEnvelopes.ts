import { z } from 'zod';
import { hostMethodCatalog } from './hostOperations';
import { uuidSchema, millisecondsSchema, mutationRequestIdSchema } from './requestIds';
const revision = z.number().int().nonnegative().safe();
const common = { protocol: z.literal(1), requestId: uuidSchema, serverEpoch: uuidSchema, issuedAt: millisecondsSchema };
const workspace = { workspaceId: uuidSchema, workspaceGeneration: revision };
const selected = { ...common, ...workspace, expectedSessionId: uuidSchema, selectionRevision: revision };
const mutation = { ...selected, requestId: mutationRequestIdSchema, controlGeneration: revision };
const read = <N extends string, S extends z.ZodType<unknown>>(method: N, input: S) => z.object({ ...selected,
  method: z.literal(method), input }).strict();
const mutate = <N extends string, S extends z.ZodType<unknown>>(method: N, input: S) => z.object({ ...mutation,
  method: z.literal(method), input }).strict();
/** Explicit discriminants and schemas, never runtime reflection or a generic invoke envelope. */
export const hostRequestSchemas = [
  read('session.list', hostMethodCatalog['session.list'].inputSchema),
  read('runtime.models', hostMethodCatalog['runtime.models'].inputSchema),
  read('runtime.queueRead', hostMethodCatalog['runtime.queueRead'].inputSchema),
  read('team.read', hostMethodCatalog['team.read'].inputSchema),
  read('agent.read', hostMethodCatalog['agent.read'].inputSchema),
  read('git.diff', hostMethodCatalog['git.diff'].inputSchema),
  read('git.combinedDiff', hostMethodCatalog['git.combinedDiff'].inputSchema),
  read('git.commitDetails', hostMethodCatalog['git.commitDetails'].inputSchema),
  read('workspace.monitorDetail', hostMethodCatalog['workspace.monitorDetail'].inputSchema),
  read('text.upload', hostMethodCatalog['text.upload'].inputSchema),
  read('text.cancel', hostMethodCatalog['text.cancel'].inputSchema),
  mutate('session.create', hostMethodCatalog['session.create'].inputSchema),
  mutate('runtime.setModel', hostMethodCatalog['runtime.setModel'].inputSchema),
  mutate('runtime.setThinking', hostMethodCatalog['runtime.setThinking'].inputSchema),
  mutate('runtime.queue', hostMethodCatalog['runtime.queue'].inputSchema),
  mutate('goal.create', hostMethodCatalog['goal.create'].inputSchema),
  mutate('goal.control', hostMethodCatalog['goal.control'].inputSchema),
  mutate('goal.update', hostMethodCatalog['goal.update'].inputSchema),
  mutate('goal.clear', hostMethodCatalog['goal.clear'].inputSchema),
  mutate('goal.editSteering', hostMethodCatalog['goal.editSteering'].inputSchema),
  mutate('goal.removeSteering', hostMethodCatalog['goal.removeSteering'].inputSchema),
  mutate('task.create', hostMethodCatalog['task.create'].inputSchema),
  mutate('task.update', hostMethodCatalog['task.update'].inputSchema),
  mutate('task.reorder', hostMethodCatalog['task.reorder'].inputSchema),
  mutate('task.delete', hostMethodCatalog['task.delete'].inputSchema),
  mutate('task.clear', hostMethodCatalog['task.clear'].inputSchema),
  mutate('agent.control', hostMethodCatalog['agent.control'].inputSchema),
  mutate('team.control', hostMethodCatalog['team.control'].inputSchema),
  mutate('agent.workspace', hostMethodCatalog['agent.workspace'].inputSchema),
] as const;
const resultCommon = { protocol: z.literal(1), ok: z.literal(true), requestId: uuidSchema, serverEpoch: uuidSchema,
  scope: z.object(workspace).strict() };
const result = <N extends string, S extends z.ZodType<unknown>>(method: N, schema: S) => z.object({ ...resultCommon,
  method: z.literal(method), result: schema }).strict();
const receipt = <N extends string, S extends z.ZodType<unknown>>(method: N, schema: S) => z.object({ ...resultCommon,
  requestId: mutationRequestIdSchema, method: z.literal(method), result: schema }).strict();
export const hostResponseSchemas = [
  result('session.list', hostMethodCatalog['session.list'].wireResultSchema),
  result('runtime.models', hostMethodCatalog['runtime.models'].wireResultSchema),
  result('runtime.queueRead', hostMethodCatalog['runtime.queueRead'].wireResultSchema),
  result('team.read', hostMethodCatalog['team.read'].wireResultSchema),
  result('agent.read', hostMethodCatalog['agent.read'].wireResultSchema),
  result('git.diff', hostMethodCatalog['git.diff'].wireResultSchema),
  result('git.combinedDiff', hostMethodCatalog['git.combinedDiff'].wireResultSchema),
  result('git.commitDetails', hostMethodCatalog['git.commitDetails'].wireResultSchema),
  result('workspace.monitorDetail', hostMethodCatalog['workspace.monitorDetail'].wireResultSchema),
  result('text.upload', hostMethodCatalog['text.upload'].wireResultSchema),
  result('text.cancel', hostMethodCatalog['text.cancel'].wireResultSchema),
  receipt('session.create', hostMethodCatalog['session.create'].wireResultSchema),
  receipt('runtime.setModel', hostMethodCatalog['runtime.setModel'].wireResultSchema),
  receipt('runtime.setThinking', hostMethodCatalog['runtime.setThinking'].wireResultSchema),
  receipt('runtime.queue', hostMethodCatalog['runtime.queue'].wireResultSchema),
  receipt('goal.create', hostMethodCatalog['goal.create'].wireResultSchema),
  receipt('goal.control', hostMethodCatalog['goal.control'].wireResultSchema),
  receipt('goal.update', hostMethodCatalog['goal.update'].wireResultSchema),
  receipt('goal.clear', hostMethodCatalog['goal.clear'].wireResultSchema),
  receipt('goal.editSteering', hostMethodCatalog['goal.editSteering'].wireResultSchema),
  receipt('goal.removeSteering', hostMethodCatalog['goal.removeSteering'].wireResultSchema),
  receipt('task.create', hostMethodCatalog['task.create'].wireResultSchema),
  receipt('task.update', hostMethodCatalog['task.update'].wireResultSchema),
  receipt('task.reorder', hostMethodCatalog['task.reorder'].wireResultSchema),
  receipt('task.delete', hostMethodCatalog['task.delete'].wireResultSchema),
  receipt('task.clear', hostMethodCatalog['task.clear'].wireResultSchema),
  receipt('agent.control', hostMethodCatalog['agent.control'].wireResultSchema),
  receipt('team.control', hostMethodCatalog['team.control'].wireResultSchema),
  receipt('agent.workspace', hostMethodCatalog['agent.workspace'].wireResultSchema),
] as const;
