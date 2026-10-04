import { statePersistenceBackendSchema, type StatePersistenceBackend } from '../shared/v2FeaturePolicy';
import path from 'node:path';
import { z } from 'zod';
import { canonicalizeProjectPath } from '../core/projects/ProjectTrustService';
import { createServerProfile } from '../core/storage/ServerProfile';
import type { FatePaths } from '../core/FatePaths';
import type { PermissionLevel } from '../shared/contracts/ipc';

const profileSchema = z.object({
  profileId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u),
  home: z.string().min(1).optional(),
  profileRoot: z.string().min(1).optional(),
}).strict();

const serverConfigSchema = z.object({
  profile: profileSchema,
  statePersistence: statePersistenceBackendSchema.optional(),
  workspaces: z.array(z.string().min(1).max(32_768)).min(1).max(8),
  host: z.literal('127.0.0.1'),
  port: z.number().int().safe().min(1).max(65_535),
  // Exact approved browser origins, including a future explicitly configured SSH local forward.
  browserOrigins: z.array(z.string().regex(/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/u)).max(8).optional(),
  // Terminal enablement is host-local and requires a second explicit acknowledgement
  // of its unsandboxed OS-user authority. Clients cannot enable it with a frame.
  flags: z.object({ terminal: z.boolean().default(false), terminalWarningAccepted: z.literal(true).optional(), browser: z.literal(false) })
    .strict().refine((flags) => !flags.terminal || flags.terminalWarningAccepted === true,
      'Enabling the host manual terminal requires terminalWarningAccepted: true.'),
  maxPermission: z.enum(['read-only', 'edit', 'full-access']).default('edit'),
}).strict();

export interface ServerConfig {
  readonly paths: FatePaths;
  readonly statePersistence?: StatePersistenceBackend;
  readonly workspaces: readonly string[];
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly browserOrigins: readonly string[];
  readonly flags: Readonly<{ terminal: boolean; terminalWarningAccepted?: true | undefined; browser: false }>;
  readonly maxPermission: PermissionLevel;
}

/** Trusted host-local configuration, never a request body or project file. */
export async function parseServerConfig(input: unknown): Promise<ServerConfig> {
  const parsed = serverConfigSchema.parse(input);
  if (parsed.profile.home && (!path.isAbsolute(parsed.profile.home) || parsed.profile.home.includes('\0'))) {
    throw new Error('Server home must be an absolute host path.');
  }
  const paths = await createServerProfile({ profileId: parsed.profile.profileId,
    ...(parsed.profile.home === undefined ? {} : { home: parsed.profile.home }),
    ...(parsed.profile.profileRoot === undefined ? {} : { profileRoot: parsed.profile.profileRoot }) });
  const workspaces = await Promise.all(parsed.workspaces.map(async (workspace) => {
    if (!path.isAbsolute(workspace) || workspace.includes('\0') || path.normalize(workspace) !== workspace) {
      throw new Error('Registered workspace paths must be absolute host paths.');
    }
    return canonicalizeProjectPath(workspace);
  }));
  const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
  const inside = (root: string, candidate: string): boolean => {
    const relative = path.relative(key(root), key(candidate));
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const profileRoot = path.dirname(paths.dataRoot);
  if (workspaces.some((workspace) => inside(workspace, profileRoot) || inside(profileRoot, workspace)
    || inside(workspace, paths.lockRoot) || inside(paths.lockRoot, workspace))) {
    throw new Error('Registered workspaces must not overlap server profile or ownership storage.');
  }
  if (new Set(workspaces.map(key)).size !== workspaces.length) throw new Error('Duplicate registered workspace path or alias.');
  const browserOrigins = parsed.browserOrigins ?? [`http://${parsed.host}:${parsed.port}`];
  if (!browserOrigins.length || new Set(browserOrigins).size !== browserOrigins.length
    || browserOrigins.some((origin) => { const port = Number(origin.slice(origin.lastIndexOf(':') + 1)); return port < 1 || port > 65_535; })) {
    throw new Error('Browser origins must be unique numeric-loopback HTTP origins with valid ports.');
  }
  return Object.freeze({ paths, ...(parsed.statePersistence === undefined ? {} : { statePersistence: parsed.statePersistence }), workspaces: Object.freeze(workspaces), host: parsed.host, port: parsed.port,
    browserOrigins: Object.freeze(browserOrigins), flags: Object.freeze(parsed.flags), maxPermission: parsed.maxPermission });
}
