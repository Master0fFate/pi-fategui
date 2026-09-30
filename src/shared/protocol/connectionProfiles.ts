import { z } from 'zod';
import { uuidSchema } from './requestIds';

export const sshAliasSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u);
export const connectionPortSchema = z.number().int().min(1).max(65535);
export const forwardedHostSchema = z.string().regex(/^127\.0\.0\.1:[1-9][0-9]{0,4}$/u)
  .refine((value) => Number(value.slice('127.0.0.1:'.length)) <= 65535);
const label = z.string().min(1).max(128).refine((value) => !/[\\/:\u0000-\u001f\u007f]/u.test(value)
  && !/(?:fo1|fc1|fb1|fs1|ft1|fx1)_/u.test(value));

/** Main-owned private profile, never the renderer's public profile DTO. */
export const sshConnectionProfileSchema = z.object({ id: uuidSchema, label, hostId: uuidSchema,
  approved: z.literal(true), transport: z.literal('ssh'), sshAlias: sshAliasSchema,
  remotePort: connectionPortSchema, localPort: connectionPortSchema.optional(),
  credentialRef: z.string().min(1).max(4096), workspaceId: uuidSchema,
  workspaceGeneration: z.number().int().nonnegative().safe(),
}).strict();
export type SshConnectionProfile = z.infer<typeof sshConnectionProfileSchema>;
export const remoteHandshakePinSchema = z.object({ hostId: uuidSchema, workspaceId: uuidSchema,
  workspaceGeneration: z.number().int().nonnegative().safe() }).strict();
export type RemoteHandshakePin = z.infer<typeof remoteHandshakePinSchema>;
