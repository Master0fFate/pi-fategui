import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { FateCoreOptions } from '../core/createFateCore';
import type { FateCore } from '../core/FateCore';
import type { CoreShutdownResult } from '../core/lifecycle/CoreLifecycle';
import { CommandJournal } from '../core/commands/CommandJournal';
import { assertPrivateWindowsTree } from '../core/storage/WindowsPrivateAcl';
import { fateProviderStoragePaths } from '../main/pi/FateProviderStorage';
import { parseServerConfig, type ServerConfig } from './config';
import { AuthService } from './auth/AuthService';
import type { RequestContext } from '../core/dispatch/RequestContext';

export interface NodeServerReadiness {
  readonly ready: true;
  readonly profileLock: 'held';
  readonly workspaceRegistry: 'ready';
  readonly permissionStore: 'healthy';
  readonly commandJournal: 'healthy';
  readonly authentication: 'ready';
  /** File presence does not prove valid provider authorization. */
  readonly provider: 'auth-required' | 'unverified';
  readonly listener: 'disabled';
  readonly host: '127.0.0.1';
  readonly configuredPort: number;
  readonly browserOrigins: readonly string[];
  readonly registeredWorkspaces: readonly string[];
  readonly maxPermission: ServerConfig['maxPermission'];
  readonly terminalEnabled: boolean;
}

export interface NodeServer {
  readonly core: FateCore;
  /** Host-only authority object. Never serialize it into public readiness. */
  readonly auth: AuthService;
  readonly journal: CommandJournal;
  readonly readiness: NodeServerReadiness;
  stop(): Promise<CoreShutdownResult>;
}

/** Internal composition seam; only tests inject an alternate core factory. */
export async function startNodeServerWithFactory(
  input: unknown,
  makeCore: (options: FateCoreOptions) => Promise<FateCore>,
  workspaceMembership: (identity: RequestContext, workspaceId: string) => boolean = () => false,
): Promise<NodeServer> {
  const config = await parseServerConfig(input);
  const registered = new Set(config.workspaces.map((workspace) => process.platform === 'win32' ? workspace.toLowerCase() : workspace));
  const isRegistered = (workspace: string): boolean => registered.has(process.platform === 'win32' ? workspace.toLowerCase() : workspace);
  let core: FateCore | null = null;
  try {
    core = await makeCore({
      paths: config.paths,
      ...(config.statePersistence === undefined ? {} : { statePersistence: config.statePersistence }),
      workspaceRegistration: { isRegistered },
      // The default denies all membership. Only a trusted network adapter may
      // supply a live credential-to-workspace resolver; request JSON never can.
      workspaceMembership,
      browserIntegration: null,
      permissionHost: { mode: 'network', maximumLevel: config.maxPermission },
    });
    if (!core.workspaces) throw new Error('The host workspace registry was not created.');
    // The profile lock is still held while validating both durable stores.
    // No runtime or provider session is opened during this preflight.
    await core.sessionPermissions.checkHealth();
    const journal = new CommandJournal({ root: path.join(config.paths.dataRoot, 'commands', 'v1'), serverEpoch: core.events.serverEpoch });
    await journal.checkHealth();
    // The profile-owner lock is held. A missing pair initializes once; a
    // partial, corrupt or unsafe credential store blocks startup, not auth.
    const auth = await AuthService.open(config.paths, config.workspaces);
    const authPath = fateProviderStoragePaths(config.paths.dataRoot).authPath;
    const provider = await fs.lstat(authPath).then((stat): NodeServerReadiness['provider'] => {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Provider credential path is not a regular private file.');
      return 'unverified';
    }, (error: NodeJS.ErrnoException): NodeServerReadiness['provider'] => {
      if (error.code === 'ENOENT') return 'auth-required';
      throw error;
    });
    // Provider auth, session permissions, write intents, journals and lock
    // files can each have an unsafe explicit Windows ACL under a private root.
    // Refuse the entire existing tree before any listener becomes ready.
    await assertPrivateWindowsTree(path.dirname(config.paths.dataRoot));
    await assertPrivateWindowsTree(config.paths.lockRoot);
    const readiness: NodeServerReadiness = Object.freeze({ ready: true, profileLock: 'held', workspaceRegistry: 'ready',
      permissionStore: 'healthy', commandJournal: 'healthy', authentication: 'ready', provider, listener: 'disabled', host: config.host,
      configuredPort: config.port, browserOrigins: config.browserOrigins,
      registeredWorkspaces: config.workspaces, maxPermission: config.maxPermission, terminalEnabled: config.flags.terminal });
    const owner = core;
    return { core: owner, auth, journal, readiness, stop: () => { auth.close(); return owner.shutdownCore(); } };
  } catch (error) {
    if (core) {
      try { await core.dispose(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Node server startup failed and profile ownership remains uncertain.'); }
    }
    throw error;
  }
}
