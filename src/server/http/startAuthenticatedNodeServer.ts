import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { uuidSchema } from '../../shared/protocol/requestIds';
import { TextAttachmentStore } from '../../core/attachments/TextAttachmentStore';
import { assertPrivateWindowsAcl } from '../../core/storage/WindowsPrivateAcl';
import type { NetworkDispatcherOptions } from './NetworkDispatcher';
import type { FateCoreOptions } from '../../core/createFateCore';
import type { RequestContext } from '../../core/dispatch/RequestContext';
import type { WorkspaceHandle } from '../../core/workspaces/WorkspaceHandle';
import type { FateCore } from '../../core/FateCore';
import type { CoreShutdownResult } from '../../core/lifecycle/CoreLifecycle';
import type { AuthService } from '../auth/AuthService';
import { startNodeServerWithFactory, type NodeServer } from '../compose';
import { createHttpServer, type HttpService } from './createHttpServer';
import { createNetworkDispatcher } from './NetworkDispatcher';
import { ClientTickets } from '../auth/ClientTickets';
import { EventConnection } from '../ws/EventConnection';
import { createTerminalBridge } from '../ws/TerminalBridge';
import { RedactedLog } from '../logging/RedactedLog';

export interface AuthenticatedNodeServer {
  readonly core: FateCore;
  readonly auth: AuthService;
  readonly http: HttpService;
  readonly tickets: ClientTickets;
  readonly serverEpoch: string;
  readonly readiness: Readonly<{ ready: true; listener: 'bound'; host: '127.0.0.1'; port: number }>;
  stop(): Promise<CoreShutdownResult>;
}

export interface AuthenticatedHostPolicy {
  readonly hostName?: string;
  /** Trusted host-local policy, not part of server JSON or a browser request. */
  readonly mayTakeOver?: NetworkDispatcherOptions['mayTakeOver'];
}
async function publicHostId(core: FateCore): Promise<string> {
  const target = path.join(path.dirname(core.paths.dataRoot), 'host-id');
  try {
    const id = randomUUID();
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(id, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try { const directory = await fs.open(path.dirname(target), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Host identity storage is unavailable.'); }
  const before = await fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== 36
    || process.platform !== 'win32' && (before.mode & 0o077) !== 0) throw new Error('Host identity storage is unavailable.');
  await assertPrivateWindowsAcl(target);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const live = await handle.stat();
    if (!live.isFile() || live.nlink !== 1 || live.size !== 36 || live.dev !== before.dev || live.ino !== before.ino) throw new Error('Host identity storage is unavailable.');
    const bytes = Buffer.alloc(37);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== 36) throw new Error('Host identity storage is unavailable.');
    return uuidSchema.parse(bytes.toString('utf8', 0, bytesRead));
  } finally { await handle.close(); }
}

/** Explicit production network entry; ordinary desktop and the M2 core entry stay non-listening. */
export async function startAuthenticatedNodeServerWithFactory(input: unknown,
  makeCore: (options: FateCoreOptions) => Promise<FateCore>,
  diagnosticSink: (entry: string) => void = (entry) => { process.stderr.write(`${entry}\n`); },
  builtWebDirectory?: string, hostPolicy: AuthenticatedHostPolicy = {}): Promise<AuthenticatedNodeServer> {
  let tickets: ClientTickets | null = null;
  const handles = new Map<string, WorkspaceHandle>();
  const membership = (identity: RequestContext, workspaceId: string): boolean => {
    const handle = handles.get(workspaceId);
    return Boolean(handle && tickets?.isMember(identity, handle.root));
  };
  const base: NodeServer = await startNodeServerWithFactory(input, makeCore, membership);
  let http: HttpService | null = null;
  let events: EventConnection | null = null;
  let terminal: ReturnType<typeof createTerminalBridge> | null = null;
  let attachments: TextAttachmentStore | null = null;
  let expiryTimer: ReturnType<typeof setInterval> | null = null;
  try {
    // Reuse the sole profile-owned authority store; never open a second writer.
    const auth = base.auth;
    const serverEpoch = base.core.events.serverEpoch;
    tickets = new ClientTickets(auth);
    if (!base.core.workspaces) throw new Error('Workspace registry is unavailable.');
    for (const root of base.readiness.registeredWorkspaces) {
      const handle = await base.core.workspaces.registerHostPath(root);
      handles.set(handle.id, handle);
    }
    const liveTickets = tickets;
    // Existing profile ownership/private-tree preflight precedes this host-owned store.
    attachments = await TextAttachmentStore.open(base.core.paths.attachmentRoot);
    const liveAttachments = attachments;
    expiryTimer = setInterval(() => { void liveAttachments.sweepExpired().catch(() => { /* Store operations continue to fail closed. */ }); }, 30_000);
    expiryTimer.unref();
    const commands = createNetworkDispatcher({ core: base.core, tickets: liveTickets, serverEpoch,
      journal: base.journal, registeredRoots: base.readiness.registeredWorkspaces,
      hostId: await publicHostId(base.core), appVersion: '1.1.0', maxPermission: base.readiness.maxPermission,
      terminalEnabled: base.readiness.terminalEnabled, textAttachments: liveAttachments,
      ...(hostPolicy.hostName === undefined ? {} : { hostName: hostPolicy.hostName }),
      ...(hostPolicy.mayTakeOver === undefined ? {} : { mayTakeOver: hostPolicy.mayTakeOver }) });
    if (base.readiness.terminalEnabled) {
      terminal = createTerminalBridge({ registry: base.core.workspaces, control: commands.control,
        permission: commands.terminalPermission,
        resolveShell: () => process.platform === 'win32' ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe')
          : (process.env.SHELL ?? '/bin/sh') });
    }
    const liveTerminal = terminal;
    events = new EventConnection({ auth, tickets: liveTickets, events: base.core.events, serverEpoch,
      onDisconnect: (connectionId) => { liveTerminal?.onDisconnect(connectionId); commands.onDisconnect(connectionId); },
      ...(liveTerminal ? { onTerminalFrame: liveTerminal.onFrame } : {}),
      resolveScope: (principal, workspaceId, generation, connectionId) => {
        const handle = handles.get(workspaceId);
        if (!handle || handle.generation !== generation || !principal.workspaceRoots.includes(handle.root)
          || base.core.runtime.peekWorkspace(handle.root) !== handle.runtime) return null;
        return { principalId: principal.principalId, clientId: connectionId, workspaceId, workspaceGeneration: generation,
          serverEpoch, sessionId: handle.admission.snapshot().selectedSessionId ?? 'no-session', projectPath: handle.root };
      } });
    const liveEvents = events;
    http = await createHttpServer({ auth, host: base.readiness.host, port: base.readiness.configuredPort,
      profileId: base.core.paths.dataRoot, allowedOrigins: base.readiness.browserOrigins, serverEpoch, ready: () => true,
      logger: new RedactedLog(diagnosticSink), ...(builtWebDirectory === undefined ? {} : { staticDirectory: builtWebDirectory }),
      onCommand: commands.onCommand,
      onUpgrade: (request, socket, head, config, cookieName) => liveEvents.handleUpgrade(request, socket, head, config, cookieName) });
    const listener = http;
    let stopping: Promise<CoreShutdownResult> | null = null;
    return { core: base.core, auth, http: listener, tickets: liveTickets, serverEpoch,
      readiness: Object.freeze({ ready: true, listener: 'bound', host: base.readiness.host, port: listener.port }),
      stop: () => stopping ??= (async () => {
        if (expiryTimer) clearInterval(expiryTimer);
        liveEvents.close(); liveTerminal?.close(); liveTickets.close(); await listener.stop();
        let attachmentFailure: unknown;
        try { await liveAttachments.close(); } catch (error) { attachmentFailure = error; }
        const result = await base.stop();
        if (attachmentFailure) throw new AggregateError([attachmentFailure], 'Private text cleanup is incomplete.');
        return result;
      })() };
  } catch (error) {
    try { if (expiryTimer) clearInterval(expiryTimer);
      events?.close(); terminal?.close(); tickets?.close(); await http?.stop();
      let attachmentFailure: unknown;
      try { await attachments?.close(); } catch (cleanupError) { attachmentFailure = cleanupError; }
      const shutdown = await base.stop();
      if (shutdown.status !== 'settled') throw new Error('Core shutdown is incomplete; ownership remains held.');
      if (attachmentFailure) throw attachmentFailure; }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Authenticated listener startup failed and owner shutdown was incomplete.'); }
    throw error;
  }
}
