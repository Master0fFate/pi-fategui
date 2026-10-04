import { z } from 'zod';

const id = z.string().uuid();
const dimensions = { cols: z.number().int().min(2).max(400), rows: z.number().int().min(1).max(200) };
export const terminalScopeSchema = z.object({ workspaceId: id,
  workspaceGeneration: z.number().int().positive().safe(), controlGeneration: z.number().int().positive().safe() }).strict();
export type TerminalScope = z.infer<typeof terminalScopeSchema>;

/** Shared wire bounds. IDs are connection-bound host output, never owner identities. */
export const terminalClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ protocol: z.literal(1), type: z.literal('terminal.create'), ...terminalScopeSchema.shape, ...dimensions }).strict(),
  z.object({ protocol: z.literal(1), type: z.literal('terminal.write'), id, data: z.string().max(16_384) }).strict(),
  z.object({ protocol: z.literal(1), type: z.literal('terminal.resize'), id, ...dimensions }).strict(),
  z.object({ protocol: z.literal(1), type: z.literal('terminal.ack'), id,
    sequence: z.number().int().positive().safe(), characters: z.number().int().positive().max(65_536) }).strict(),
  z.object({ protocol: z.literal(1), type: z.literal('terminal.close'), id }).strict(),
]);
export type TerminalClientFrame = z.infer<typeof terminalClientFrameSchema>;
export const terminalCreatedSchema = z.object({ id, shell: z.string().min(1).max(32_768),
  cwd: z.string().min(1).max(32_768), warning: z.string().min(1).max(1_024) }).strict();
export type TerminalCreated = z.infer<typeof terminalCreatedSchema>;
export const terminalServerFrameSchema = z.discriminatedUnion('type', [
  z.object({ protocol: z.literal(1), type: z.literal('terminal.created'), result: terminalCreatedSchema }).strict(),
  z.object({ protocol: z.literal(1), type: z.literal('terminal.event'), event: z.discriminatedUnion('type', [
    z.object({ type: z.literal('data'), id, sequence: z.number().int().positive().safe(), data: z.string().min(1).max(65_536) }).strict(),
    z.object({ type: z.literal('exit'), id, exitCode: z.number().int().safe(), signal: z.number().int().safe().optional() }).strict(),
  ]) }).strict(),
]);
