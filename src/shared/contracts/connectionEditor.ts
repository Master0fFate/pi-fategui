import { z } from 'zod';
import { connectionProfileSchema } from './connections';
const port = z.number().int().min(1).max(65535);
export const credentialSelectionSchema = z.object({ selectionId: z.string().uuid() }).strict().nullable();
/** Public fields only. Native main resolves the opaque credential choice. */
export const saveSshProfileSchema = z.object({
  label: connectionProfileSchema.shape.label, hostId: z.string().uuid(),
  sshAlias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u), remotePort: port, localPort: port.optional(),
  workspaceId: z.string().uuid(), workspaceGeneration: z.number().int().safe().nonnegative(),
  selectionId: z.string().uuid(), trust: z.literal(true),
}).strict();
export type SaveSshProfile = z.infer<typeof saveSshProfileSchema>;
