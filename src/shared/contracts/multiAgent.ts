import { z } from 'zod';
import { toolProvenanceSchema } from './provenance';

export const AGENT_TEAM_MAX_DEPTH = 2;
export const AGENT_TEAM_MAX_NODES = 16;
export const AGENT_TEAM_MAX_ACTIVE_TURNS = 3;
export const AGENT_TEAM_MAX_MESSAGES = 256;
export const AGENT_TEAM_MAX_MESSAGE_BYTES = 32 * 1024;
export const AGENT_TEAM_DEFAULT_WAIT_MS = 30_000;
export const AGENT_TEAM_MAX_WAIT_MS = 5 * 60_000;

const id = z.string().min(1).max(160);
const boundedText = z.string().max(AGENT_TEAM_MAX_MESSAGE_BYTES);
const permission = z.enum(['read-only', 'edit', 'full-access']);
const thinking = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const toolName = z.enum(['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash', 'generate_image']);
const model = z.object({
  provider: z.string().min(1).max(200),
  id: z.string().min(1).max(500),
  name: z.string().min(1).max(500),
  reasoning: z.boolean(),
  contextWindow: z.number().int().positive(),
  supportsImages: z.boolean().optional(),
}).strict();
const usage = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  contextTokens: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
}).strict();

export const agentTeamLimitsSchema = z.object({
  maxDepth: z.number().int().min(1).max(AGENT_TEAM_MAX_DEPTH),
  maxNodes: z.number().int().min(1).max(AGENT_TEAM_MAX_NODES),
  maxActiveTurns: z.number().int().min(1).max(AGENT_TEAM_MAX_ACTIVE_TURNS),
  maxMessages: z.number().int().min(1).max(AGENT_TEAM_MAX_MESSAGES),
  maxMessageBytes: z.number().int().min(1).max(AGENT_TEAM_MAX_MESSAGE_BYTES),
}).strict();

export const agentTeamNodeStatusSchema = z.enum(['creating', 'ready', 'active', 'interrupted', 'closing', 'closed', 'failed']);
export const agentTeamTaskStatusSchema = z.enum(['queued', 'running', 'waiting-for-children', 'completed', 'interrupted', 'cancelled', 'failed']);
export const agentTeamEnvelopeKindSchema = z.enum(['NEW_TASK', 'MESSAGE', 'FINAL_ANSWER', 'CONTROL']);
export const agentTeamEnvelopeStateSchema = z.enum(['queued', 'delivered', 'consumed', 'failed', 'expired']);

export const agentTeamNodeSchema = z.object({
  id,
  teamId: id,
  parentNodeId: id.nullable(),
  path: z.string().min(1).max(512).regex(/^\/root(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/u),
  handle: z.string().min(1).max(64),
  displayName: z.string().min(1).max(100),
  depth: z.number().int().min(0).max(AGENT_TEAM_MAX_DEPTH),
  role: z.string().min(1).max(80),
  agentName: z.string().min(1).max(100),
  permissionLevel: permission,
  enabledTools: z.array(toolName).max(8),
  model,
  thinkingLevel: thinking,
  status: agentTeamNodeStatusSchema,
  currentTaskId: id.optional(),
  childIds: z.array(id).max(AGENT_TEAM_MAX_NODES),
  unreadMessages: z.number().int().nonnegative().max(AGENT_TEAM_MAX_MESSAGES),
  writer: z.boolean(),
  usage,
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  lastError: z.string().max(4_000).optional(),
}).strict();

export const agentTeamTaskSchema = z.object({
  id,
  teamId: id,
  assigneeNodeId: id,
  requesterNodeId: id,
  inputEnvelopeId: id,
  resultEnvelopeId: id.optional(),
  summary: z.string().min(1).max(2_000),
  status: agentTeamTaskStatusSchema,
  createdAt: z.number().finite(),
  startedAt: z.number().finite().optional(),
  endedAt: z.number().finite().optional(),
  error: z.string().max(4_000).optional(),
}).strict();

export const agentTeamEnvelopeSchema = z.object({
  id,
  teamId: id,
  sequence: z.number().int().positive(),
  kind: agentTeamEnvelopeKindSchema,
  authorNodeId: id,
  recipientNodeId: id,
  taskId: id.optional(),
  content: boundedText,
  triggerTurn: z.boolean(),
  state: agentTeamEnvelopeStateSchema,
  createdAt: z.number().finite(),
  deliveredAt: z.number().finite().optional(),
  error: z.string().max(2_000).optional(),
}).strict();

export const agentTeamOperationReceiptSchema = z.object({
  key: z.string().min(1).max(700),
  operation: z.enum(['spawn', 'message', 'followup']),
  entityId: id,
  createdAt: z.number().finite(),
}).strict();

export const agentTeamTimelineEventSchema = z.object({
  id,
  sequence: z.number().int().nonnegative(),
  type: z.enum(['team.created', 'node.created', 'node.updated', 'task.created', 'task.updated', 'envelope.created', 'envelope.updated', 'node.interrupted', 'node.closed', 'team.restored', 'team.closed', 'tool.started', 'tool.completed', 'message.completed', 'error']),
  nodeId: id.optional(),
  taskId: id.optional(),
  envelopeId: id.optional(),
  toolCallId: id.optional(),
  toolName: z.string().min(1).max(200).optional(),
  messageId: id.optional(),
  provenance: toolProvenanceSchema.optional(),
  summary: z.string().min(1).max(1_000),
  timestamp: z.number().finite(),
}).strict();

export const agentTeamSchema = z.object({
  id,
  rootSessionId: z.string().min(1).max(500),
  protocolVersion: z.literal(2),
  status: z.enum(['active', 'settling', 'closed', 'restored-interrupted']),
  rootNodeId: id,
  limits: agentTeamLimitsSchema,
  activeTurns: z.number().int().nonnegative().max(AGENT_TEAM_MAX_ACTIVE_TURNS),
  writerNodeId: id.nullable(),
  usage,
  nodes: z.array(agentTeamNodeSchema).max(AGENT_TEAM_MAX_NODES + 1),
  tasks: z.array(agentTeamTaskSchema).max(512),
  envelopes: z.array(agentTeamEnvelopeSchema).max(AGENT_TEAM_MAX_MESSAGES),
  operationReceipts: z.array(agentTeamOperationReceiptSchema).max(512),
  timeline: z.array(agentTeamTimelineEventSchema).max(256),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).strict();

export const agentTeamControlInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('message'), target: id, message: boundedText }).strict(),
  z.object({ action: z.literal('followUp'), target: id, message: boundedText }).strict(),
  z.object({ action: z.literal('interrupt'), target: id, reason: z.string().trim().min(1).max(500).optional() }).strict(),
  z.object({ action: z.literal('close'), target: id }).strict(),
  z.object({ action: z.literal('resume'), target: id, message: boundedText }).strict(),
]);

export type AgentTeam = z.infer<typeof agentTeamSchema>;
export type AgentTeamNode = z.infer<typeof agentTeamNodeSchema>;
export type AgentTeamTask = z.infer<typeof agentTeamTaskSchema>;
export type AgentTeamEnvelope = z.infer<typeof agentTeamEnvelopeSchema>;
export type AgentTeamTimelineEvent = z.infer<typeof agentTeamTimelineEventSchema>;
export type AgentTeamLimits = z.infer<typeof agentTeamLimitsSchema>;
export type AgentTeamControlInput = z.infer<typeof agentTeamControlInputSchema>;
