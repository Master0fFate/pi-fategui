import { z } from 'zod';
import { permissionLevelSchema } from './ipc';
import { MAX_PROJECT_RELATIVE_PATH_LENGTH, projectRelativePathSchema, toolActorSchema } from './provenance';

/**
 * Mutation attestations record ONLY that a Fate-controlled direct `write`/`edit`
 * completed and produced the recorded written-content hash (with a prior hash
 * only when one was captured). A direct write may rewrite identical content, so
 * an equal pre/post hash is a valid completed row, not proof that file state
 * changed. They MUST NOT be read as sole authorship, tool-call causality,
 * current diff ownership, shell/formatter/external-editor coverage, or
 * requirement/commit linkage. Bash bypasses the controlled choke point
 * entirely and is never recorded.
 */
export const MUTATION_ATTESTATION_SCHEMA_VERSION = 1;

export const ATTESTATION_ID_MAX = 100;
export const ATTESTATION_SESSION_ID_MAX = 500;
export const ATTESTATION_QUERY_LIMIT_MAX = 1_000;

/** 64 lowercase hex characters. */
export const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'SHA-256 hashes must be 64 lowercase hex characters.');

/** A safe project-relative prefix for query filters (optional trailing slash, no traversal/absolute/backslash/dot segments). */
export const projectRelativePathPrefixSchema = z
  .string()
  .min(1)
  .max(MAX_PROJECT_RELATIVE_PATH_LENGTH)
  .refine((value) => !value.includes('\\'), 'Project-relative prefixes must use forward slashes.')
  .refine((value) => !value.includes('\0'), 'Project-relative prefixes cannot contain NUL.')
  .refine((value) => !value.startsWith('/') && !/^[A-Za-z]:/u.test(value) && !value.startsWith('//'), 'Project-relative prefixes cannot be absolute.')
  .refine((value) => value.replace(/\/+$/, '').split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'), 'Project-relative prefixes cannot contain empty, dot, or traversal segments.')
  .transform((value) => value.replace(/\/+$/, ''));

export const mutationAttestationSchema = z
  .object({
    id: z.string().min(1).max(ATTESTATION_ID_MAX),
    schemaVersion: z.literal(MUTATION_ATTESTATION_SCHEMA_VERSION),
    recordedAt: z.number().int().nonnegative(),
    projectPathHash: sha256HexSchema,
    /** Null only when a session id is genuinely unavailable; never inferred. */
    sessionId: z.string().min(1).max(ATTESTATION_SESSION_ID_MAX).nullable(),
    actor: toolActorSchema,
    /** Null only when the permission level is genuinely unavailable; never inferred. */
    permissionLevel: permissionLevelSchema.nullable(),
    operation: z.enum(['write', 'edit']),
    path: projectRelativePathSchema,
    /** Null when the prior state was missing or oversize. */
    preHash: sha256HexSchema.nullable(),
    postHash: sha256HexSchema,
    preState: z.enum(['missing', 'hashed', 'oversize']),
    captureKind: z.literal('direct-file-tool'),
  })
  .strict()
  .superRefine((value, context) => {
    // preState and preHash must agree: only a hashed prior state has a preHash.
    if (value.preState === 'hashed') {
      if (value.preHash === null) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'A hashed preState requires a preHash.', path: ['preHash'] });
      }
    } else if (value.preHash !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'A missing or oversize preState requires a null preHash.', path: ['preHash'] });
    }
  });

export const attestationQueryInputSchema = z
  .object({
    projectPath: z.string().min(1).max(32_768),
    limit: z.number().int().min(1).max(ATTESTATION_QUERY_LIMIT_MAX).default(256),
    pathPrefix: projectRelativePathPrefixSchema.optional(),
  })
  .strict();

/**
 * Renderer-side attestation query. The active project is resolved main-side from
 * the trusted runtime state, so this schema intentionally omits `projectPath`
 * and rejects every unknown key. The renderer can never select another project's
 * ledger or attach an absolute/storage path.
 */
export const attestationQueryRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(ATTESTATION_QUERY_LIMIT_MAX).default(256),
    pathPrefix: projectRelativePathPrefixSchema.optional(),
  })
  .strict();

export const attestationRowSchema = mutationAttestationSchema;

export const attestationQueryResultSchema = z.object({
  rows: z.array(attestationRowSchema),
  truncated: z.boolean(),
}).strict();

export type MutationAttestation = z.infer<typeof mutationAttestationSchema>;
export type AttestationQueryInput = z.infer<typeof attestationQueryInputSchema>;
export type AttestationQueryRequest = z.infer<typeof attestationQueryRequestSchema>;
/** Input shape for the renderer request (limit is optional and defaulted on parse). */
export type AttestationQueryRequestInput = z.input<typeof attestationQueryRequestSchema>;
export type AttestationQueryResult = z.infer<typeof attestationQueryResultSchema>;
