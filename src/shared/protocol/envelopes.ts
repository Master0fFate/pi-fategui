import { z } from 'zod';
import { safeErrorSchema, type ErrorCode } from './errors';
import { MAX_COMMAND_BYTES, methodCatalog, revisionSchema, type MethodName, type MutationMethodName } from './methods';
import { millisecondsSchema, mutationIdentityMatches, mutationRequestIdSchema, requestIdSchema, uuidSchema } from './requestIds';
import { hostRequestSchemas, hostResponseSchemas } from './hostEnvelopes';

const common = { protocol: z.literal(1), requestId: uuidSchema, serverEpoch: uuidSchema, issuedAt: millisecondsSchema };
const workspace = { workspaceId: uuidSchema, workspaceGeneration: revisionSchema };
const mutation = { ...common, ...workspace, requestId: mutationRequestIdSchema, expectedSessionId: uuidSchema, selectionRevision: revisionSchema, controlGeneration: revisionSchema };
const approval = { ...common, ...workspace, selectionRevision: revisionSchema, controlGeneration: revisionSchema };
const requestUnion = z.discriminatedUnion('method', [
  ...hostRequestSchemas,
  z.object({ ...common, method: z.literal('host.info'), input: methodCatalog['host.info'].inputSchema }).strict(),
  z.object({ ...common, method: z.literal('workspace.list'), input: methodCatalog['workspace.list'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, method: z.literal('workspace.snapshot'), input: methodCatalog['workspace.snapshot'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, method: z.literal('workspace.snapshotPage'), input: methodCatalog['workspace.snapshotPage'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, expectedSessionId: uuidSchema, selectionRevision: revisionSchema,
    method: z.literal('workspace.monitor'), input: methodCatalog['workspace.monitor'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, expectedSessionId: uuidSchema, selectionRevision: revisionSchema,
    method: z.literal('goal.get'), input: methodCatalog['goal.get'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, expectedSessionId: uuidSchema, selectionRevision: revisionSchema,
    method: z.literal('task.list'), input: methodCatalog['task.list'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, expectedSessionId: uuidSchema, selectionRevision: revisionSchema,
    method: z.literal('git.status'), input: methodCatalog['git.status'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, expectedSessionId: uuidSchema, selectionRevision: revisionSchema,
    method: z.literal('git.history'), input: methodCatalog['git.history'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, method: z.literal('control.claim'), input: methodCatalog['control.claim'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, method: z.literal('control.renew'), input: methodCatalog['control.renew'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, method: z.literal('control.release'), input: methodCatalog['control.release'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, method: z.literal('control.takeover'), input: methodCatalog['control.takeover'].inputSchema }).strict(),
  z.object({ ...approval, method: z.literal('permission.issue'), input: methodCatalog['permission.issue'].inputSchema }).strict(),
  z.object({ ...approval, requestId: mutationRequestIdSchema, method: z.literal('permission.confirm'), input: methodCatalog['permission.confirm'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, method: z.literal('command.status'), input: methodCatalog['command.status'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, method: z.literal('file.list'), input: methodCatalog['file.list'].inputSchema }).strict(),
  z.object({ ...common, ...workspace, method: z.literal('file.previewText'), input: methodCatalog['file.previewText'].inputSchema }).strict(),
  z.object({ ...mutation, method: z.literal('runtime.prompt'), input: methodCatalog['runtime.prompt'].inputSchema }).strict(),
  z.object({ ...mutation, method: z.literal('runtime.abort'), input: methodCatalog['runtime.abort'].inputSchema }).strict(),
  z.object({ ...mutation, expectedSessionId: uuidSchema.nullable(), method: z.literal('session.select'), input: methodCatalog['session.select'].inputSchema }).strict(),
]);
export const requestEnvelopeSchema = requestUnion.superRefine((request, context) => {
  const category = methodCatalog[request.method].mutation;
  if ((category === 'runtime' || category === 'selection' || category === 'grant') && !mutationIdentityMatches(request)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['requestId'], message: 'Mutation identity must match the envelope.' });
  }
});
export type WireRequest = z.output<typeof requestEnvelopeSchema>;
export type RequestOf<M extends MethodName> = Extract<WireRequest, { method: M }>;
export type MutationRequest = RequestOf<MutationMethodName>;
/** Permission confirmation shares durable original-ID admission, not the runtime handler category. */
export type JournaledMutationRequest = MutationRequest | RequestOf<'permission.confirm'>;
// Compile-time coverage of both the explicit wire discriminants and the catalog.
const requestCoverage: { [M in MethodName]: Extract<WireRequest, { method: M }>['method'] } = {
  'host.info': 'host.info', 'workspace.list': 'workspace.list',
  'workspace.snapshot': 'workspace.snapshot', 'workspace.snapshotPage': 'workspace.snapshotPage', 'workspace.monitor': 'workspace.monitor',
  'goal.get': 'goal.get', 'task.list': 'task.list', 'git.status': 'git.status', 'git.history': 'git.history',
  'control.claim': 'control.claim', 'control.renew': 'control.renew', 'control.release': 'control.release', 'control.takeover': 'control.takeover',
  'permission.issue': 'permission.issue', 'permission.confirm': 'permission.confirm', 'command.status': 'command.status', 'file.list': 'file.list', 'file.previewText': 'file.previewText',
  'runtime.prompt': 'runtime.prompt', 'runtime.abort': 'runtime.abort', 'session.select': 'session.select',
  'session.history': 'session.history', 'session.list': 'session.list', 'session.create': 'session.create', 'runtime.models': 'runtime.models',
  'runtime.setModel': 'runtime.setModel', 'runtime.setThinking': 'runtime.setThinking', 'runtime.queueRead': 'runtime.queueRead', 'runtime.queue': 'runtime.queue',
  'goal.create': 'goal.create', 'goal.control': 'goal.control', 'goal.update': 'goal.update', 'goal.clear': 'goal.clear',
  'goal.editSteering': 'goal.editSteering', 'goal.removeSteering': 'goal.removeSteering',
  'task.create': 'task.create', 'task.update': 'task.update', 'task.reorder': 'task.reorder', 'task.delete': 'task.delete', 'task.clear': 'task.clear',
  'agent.read': 'agent.read', 'team.read': 'team.read', 'agent.control': 'agent.control', 'team.control': 'team.control', 'agent.workspace': 'agent.workspace',
  'git.diff': 'git.diff', 'git.combinedDiff': 'git.combinedDiff', 'git.commitDetails': 'git.commitDetails',
  'workspace.monitorDetail': 'workspace.monitorDetail', 'text.upload': 'text.upload', 'text.cancel': 'text.cancel',
};
void requestCoverage;

export const responseScopeSchema = z.object(workspace).strict();
const resultCommon = { protocol: z.literal(1), ok: z.literal(true), requestId: uuidSchema, serverEpoch: uuidSchema };
const successSchema = z.discriminatedUnion('method', [
  ...hostResponseSchemas,
  z.object({ ...resultCommon, scope: z.null(), method: z.literal('host.info'), result: methodCatalog['host.info'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: z.null(), method: z.literal('workspace.list'), result: methodCatalog['workspace.list'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('workspace.snapshot'), result: methodCatalog['workspace.snapshot'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('workspace.snapshotPage'), result: methodCatalog['workspace.snapshotPage'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('workspace.monitor'), result: methodCatalog['workspace.monitor'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('goal.get'), result: methodCatalog['goal.get'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('task.list'), result: methodCatalog['task.list'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('git.status'), result: methodCatalog['git.status'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('git.history'), result: methodCatalog['git.history'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('control.claim'), result: methodCatalog['control.claim'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('control.renew'), result: methodCatalog['control.renew'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('control.release'), result: methodCatalog['control.release'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('control.takeover'), result: methodCatalog['control.takeover'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('permission.issue'), result: methodCatalog['permission.issue'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, requestId: mutationRequestIdSchema, scope: responseScopeSchema, method: z.literal('permission.confirm'), result: methodCatalog['permission.confirm'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('command.status'), result: methodCatalog['command.status'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('file.list'), result: methodCatalog['file.list'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, scope: responseScopeSchema, method: z.literal('file.previewText'), result: methodCatalog['file.previewText'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, requestId: mutationRequestIdSchema, scope: responseScopeSchema, method: z.literal('runtime.prompt'), result: methodCatalog['runtime.prompt'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, requestId: mutationRequestIdSchema, scope: responseScopeSchema, method: z.literal('runtime.abort'), result: methodCatalog['runtime.abort'].wireResultSchema }).strict(),
  z.object({ ...resultCommon, requestId: mutationRequestIdSchema, scope: responseScopeSchema, method: z.literal('session.select'), result: methodCatalog['session.select'].wireResultSchema }).strict(),
]).superRefine((response, context) => {
  if ('operation' in response.result && response.result.operation !== response.method) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Operation receipt must match the named method.' });
  }
  if ('requestId' in response.result && response.result.requestId !== response.requestId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Receipt identity must match the response.' });
  }
  if ('requestId' in response.result && !response.requestId.startsWith(`${response.serverEpoch}.`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Receipt epoch must match the response.' });
  }
  if (response.method === 'host.info' && response.result.serverEpoch !== response.serverEpoch) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Host epoch must match the response.' });
  }
});
export const failureEnvelopeSchema = z.object({
  protocol: z.literal(1), ok: z.literal(false), requestId: requestIdSchema.nullable(), serverEpoch: uuidSchema,
  scope: responseScopeSchema.nullable(), error: safeErrorSchema,
  execution: z.enum(['not-started', 'unknown']), operationId: mutationRequestIdSchema.nullable(),
}).strict().refine((response) => response.execution === 'not-started'
  ? response.operationId === null
  : response.operationId !== null && response.operationId === response.requestId);
export const responseEnvelopeSchema = z.union([successSchema, failureEnvelopeSchema]);
export type ProtocolResponse = z.output<typeof responseEnvelopeSchema>;
export type FailureResponse = z.output<typeof failureEnvelopeSchema>;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

type DecodedRequest = { ok: true; request: WireRequest } | { ok: false; code: ErrorCode; requestId: string | null };
/** The transport must also limit bytes while receiving; this bound is before JSON.parse. */
export function decodeRequestJson(body: string): DecodedRequest {
  if (typeof body !== 'string' || body.length > MAX_COMMAND_BYTES || utf8Bytes(body) > MAX_COMMAND_BYTES) {
    return { ok: false, code: 'INVALID_REQUEST', requestId: null };
  }
  try {
    const value: unknown = JSON.parse(body);
    // Narrow extraction is only for safe error correlation, never for admission.
    const correlation = z.object({ requestId: requestIdSchema }).safeParse(value);
    const requestId = correlation.success ? correlation.data.requestId : null;
    const version = z.object({ protocol: z.number() }).safeParse(value);
    if (version.success && version.data.protocol !== 1) return { ok: false, code: 'PROTOCOL_MISMATCH', requestId };
    const parsed = requestEnvelopeSchema.safeParse(value);
    if (!parsed.success) return { ok: false, code: 'INVALID_REQUEST', requestId };
    Object.freeze(parsed.data.input);
    Object.freeze(parsed.data);
    return { ok: true, request: parsed.data };
  } catch {
    return { ok: false, code: 'INVALID_REQUEST', requestId: null };
  }
}
