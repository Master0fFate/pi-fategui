import {
  projectRelativePathSchema,
  toolActorSchema,
  toolProvenanceSchema,
  type ToolActor,
  type ToolProvenance,
} from '../../shared/contracts/provenance';

const directFileOperations = new Map<string, 'read' | 'write' | 'edit'>([
  ['read', 'read'],
  ['write', 'write'],
  ['edit', 'edit'],
]);

function validatedProjectPath(value: unknown): string | null {
  const parsed = projectRelativePathSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Extract only attested direct-file arguments. Never inspect output, prose, or commands. */
export function createToolProvenance(toolName: string, rawArguments: unknown, actor: ToolActor): ToolProvenance | undefined {
  const operation = directFileOperations.get(toolName);
  if (!operation || !rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) return undefined;
  const parsedActor = toolActorSchema.safeParse(actor);
  if (!parsedActor.success) return undefined;
  const projectPath = validatedProjectPath((rawArguments as Record<string, unknown>).path);
  if (!projectPath) return undefined;
  const provenance = toolProvenanceSchema.safeParse({
    actor: parsedActor.data,
    affectedPaths: [{ path: projectPath, operation }],
  });
  return provenance.success ? provenance.data : undefined;
}
