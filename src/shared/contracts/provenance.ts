import { z } from 'zod';

export const MAX_PROVENANCE_PATHS = 16;
export const MAX_PROJECT_RELATIVE_PATH_LENGTH = 4_096;

export const projectRelativePathSchema = z.string()
  .min(1)
  .max(MAX_PROJECT_RELATIVE_PATH_LENGTH)
  .refine((value) => !value.includes('\\'), 'Project-relative paths must use forward slashes.')
  .refine((value) => !value.includes('\0'), 'Project-relative paths cannot contain NUL.')
  .refine((value) => !value.startsWith('/') && !/^[A-Za-z]:/u.test(value) && !value.startsWith('//'), 'Project-relative paths cannot be absolute.')
  .refine((value) => value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'), 'Project-relative paths cannot contain empty, dot, or traversal segments.');

export const affectedPathSchema = z.object({
  path: projectRelativePathSchema,
  operation: z.enum(['read', 'write', 'edit']),
}).strict();

const provenanceIdSchema = z.string().min(1).max(500);

export const toolActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root') }).strict(),
  z.object({
    kind: z.literal('legacy'),
    runId: provenanceIdSchema,
    parentToolCallId: provenanceIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('team'),
    teamId: provenanceIdSchema,
    nodeId: provenanceIdSchema,
    taskId: provenanceIdSchema.optional(),
  }).strict(),
]);

export const toolProvenanceSchema = z.object({
  actor: toolActorSchema,
  affectedPaths: z.array(affectedPathSchema).min(1).max(MAX_PROVENANCE_PATHS),
}).strict().superRefine((value, context) => {
  const paths = new Set<string>();
  value.affectedPaths.forEach((reference, index) => {
    if (paths.has(reference.path)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provenance paths must be unique.',
        path: ['affectedPaths', index, 'path'],
      });
    }
    paths.add(reference.path);
  });
});

export type ProjectRelativePath = z.infer<typeof projectRelativePathSchema>;
export type AffectedPath = z.infer<typeof affectedPathSchema>;
export type ToolActor = z.infer<typeof toolActorSchema>;
export type ToolProvenance = z.infer<typeof toolProvenanceSchema>;
