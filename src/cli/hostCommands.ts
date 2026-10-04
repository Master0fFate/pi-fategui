import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CliCommand } from './args';
import { initializeHostProfile, readHostProfile, assertPrivateOutputPath, writePrivateHostOutput } from './profile';
import { createHostAdminClient, type HostAdminClient } from './adminClient';
import { createProviderLoginIo, runProviderLogin } from './providerLogin';
import { writeClientCredentialReference } from '../server/auth/AuthStore';
import { runForegroundHost } from './foreground';
import { startAuthenticatedNodeServer, startProductionWebNodeServer } from '../server/main';
import { permissionLevelSchema } from '../shared/contracts/ipc';
import { statePersistenceBackendSchema } from '../shared/v2FeaturePolicy';

type HostCommand = Exclude<CliCommand, { mode: 'desktop' | 'connect' }>;
function option(command: HostCommand, name: string): string | undefined {
  const value = command.options[name]; return typeof value === 'string' ? value : undefined;
}
/** A login-page URL only, with direct platform argument arrays. Failure prints instructions. */
function openLoginPage(url: string): void {
  const executable = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(executable, args, { shell: false, stdio: 'ignore', windowsHide: true, detached: false });
    child.once('error', () => { process.stderr.write('Open the displayed login page in your browser.\n'); });
    child.once('exit', (code) => { if (code !== 0) process.stderr.write('Open the displayed login page in your browser.\n'); });
  } catch { process.stderr.write('Open the displayed login page in your browser.\n'); }
}
export async function issueAccessKey(client: HostAdminClient, workspace: string, outFile: string): Promise<{ clientId: string; expiresAt: number }> {
  await assertPrivateOutputPath(outFile);
  const root = await fs.realpath(path.resolve(workspace));
  const response = await client.execute({ method: 'client.issue', input: { workspaceRoots: [root] } });
  if (response.method !== 'client.issue') throw new Error('Host response mismatch.');
  try { await writeClientCredentialReference(outFile, response.result.credential); }
  catch {
    try { await client.execute({ method: 'client.revoke', input: { clientId: response.result.clientId } }); }
    catch { throw new Error('Private key write and revocation are unconfirmed. Inspect host access status.'); }
    throw new Error('Private client key output failed. The issued client key was revoked.');
  }
  return { clientId: response.result.clientId, expiresAt: response.result.expiresAt };
}
export async function issueBootstrapCode(client: HostAdminClient, outFile: string | undefined, interactive: boolean,
  write: (text: string) => void = (text) => { process.stdout.write(text); }): Promise<void> {
  if (outFile) await assertPrivateOutputPath(outFile);
  else if (!interactive) throw new Error('Choose a private --out-file, or use an interactive host terminal.');
  const response = await client.execute({ method: 'auth.bootstrap.create', input: {} });
  if (response.method !== 'auth.bootstrap.create') throw new Error('Host response mismatch.');
  if (outFile) {
    try { await writePrivateHostOutput(outFile, response.result.code); }
    catch {
      try { await client.execute({ method: 'auth.bootstrap.revoke', input: { code: response.result.code } }); }
      catch { throw new Error('Private code output and revocation are unconfirmed. Inspect host access status.'); }
      throw new Error('Private code output failed. The issued code was revoked.');
    }
    write('One-time access code saved to the selected private file. It expires in five minutes.\n');
  } else write(`One-time access code: ${response.result.code}\n`);
}
/** Server start is explicit. Every administrative command uses the running owner. */
export async function runHostCommand(command: HostCommand): Promise<void> {
  const workspace = option(command, 'workspace');
  const portText = option(command, 'port');
  if (command.mode === 'init') {
    if (!workspace) throw new Error('Workspace is required.');
    const statePersistence = statePersistenceBackendSchema.optional().parse(option(command, 'state-persistence'));
    const maxPermission = permissionLevelSchema.parse(option(command, 'max-permission') ?? 'read-only');
    const profile = await initializeHostProfile({ profileId: command.profile, workspace, trustAccepted: command.options['trust-workspace'] === true,
      ...(portText === undefined ? {} : { port: Number(portText) }),
      ...(statePersistence === undefined ? {} : { statePersistence }), maxPermission,
      manualTerminal: command.options['manual-terminal'] === true, acceptUnsandboxedShell: command.options['accept-unsandboxed-shell'] === true });
    process.stdout.write(`Host profile initialized with ${profile.config.maxPermission} permission. No agent was started.\n`);
    if (profile.config.flags.terminal) process.stdout.write('Manual terminal enabled: unsandboxed execution-host shell. Agent permissions do not limit shell commands.\n');
    return;
  }
  if (command.mode === 'web') {
    if (!workspace) throw new Error('Workspace is required.');
    try { await readHostProfile(command.profile); }
    catch (error) {
      // Init only when the actual private descriptor is absent. Never replace corruption or unsafe storage.
      const { createServerProfile } = await import('../core/storage/ServerProfile');
      const paths = await createServerProfile({ profileId: command.profile });
      try { await fs.lstat(path.join(path.dirname(paths.dataRoot), 'server.json')); throw error; }
      catch (readError) {
        if (!(readError instanceof Error) || !('code' in readError) || readError.code !== 'ENOENT') throw readError;
      }
      await initializeHostProfile({ profileId: command.profile, workspace, trustAccepted: command.options['trust-workspace'] === true,
        ...(portText === undefined ? {} : { port: Number(portText) }) });
    }
  }
  const profile = await readHostProfile(command.profile);
  if (command.mode === 'serve' || command.mode === 'web') {
    if (command.mode === 'web' && (!workspace || !profile.config.workspaces.includes(await fs.realpath(path.resolve(workspace))))) {
      throw new Error('The web workspace is not registered in this host profile.');
    }
    if (portText && Number(portText) !== profile.config.port) throw new Error('The selected port does not match the host profile.');
    const server = command.mode === 'web' ? await startProductionWebNodeServer(profile.input) : await startAuthenticatedNodeServer(profile.input);
    const url = `http://127.0.0.1:${server.http.port}/`;
    const workspaces = profile.config.workspaces.flatMap((root) => {
      const origin = server.core.runtime.workspaceOrigin(root);
      return origin ? [{ workspaceId: origin.workspaceId, workspaceGeneration: origin.workspaceGeneration }] : [];
    });
    process.stdout.write(`${JSON.stringify({ ready: true, host: '127.0.0.1', port: server.http.port, profile: command.profile,
      hostId: server.hostId, serverEpoch: server.serverEpoch, workspaces })}\n`);
    if (command.mode === 'web') process.stderr.write(`Open the login page: ${url}\n`);
    if (command.mode === 'web') openLoginPage(url);
    await runForegroundHost(server); return;
  }
  const client = createHostAdminClient(profile.paths, profile.config.port);
  if (command.mode === 'auth-code') {
    const outFile = option(command, 'out-file');
    await issueBootstrapCode(client, outFile ? path.resolve(outFile) : undefined, process.stdout.isTTY === true && process.stdin.isTTY === true);
    return;
  }
  if (command.mode === 'access-key') {
    if (command.verb === 'create') {
      const outFile = option(command, 'out-file');
      if (!workspace || !outFile) throw new Error('Workspace and private output file are required.');
      const issued = await issueAccessKey(client, workspace, path.resolve(outFile));
      process.stdout.write(`${JSON.stringify({ saved: true, ...issued })}\n`);
    } else {
      const clientId = option(command, 'client-id');
      if (!clientId) throw new Error('Client ID is required.');
      const response = await client.execute({ method: 'client.revoke', input: { clientId } });
      if (response.method !== 'client.revoke') throw new Error('Host response mismatch.');
      process.stdout.write(response.result.revoked ? 'Client access revoked.\n' : 'No current client access matched that ID.\n');
    }
    return;
  }
  if (command.mode === 'provider') {
    if (command.verb === 'login') {
      const providerId = option(command, 'provider-id');
      const method = option(command, 'method');
      if (method && method !== 'api_key' && method !== 'oauth') throw new Error('Unsupported provider login method.');
      const selectedMethod: 'api_key' | 'oauth' | undefined = method === 'api_key' || method === 'oauth' ? method : undefined;
      await runProviderLogin(client, { ...(providerId === undefined ? {} : { providerId }), ...(selectedMethod === undefined ? {} : { method: selectedMethod }) }, createProviderLoginIo());
    } else if (command.verb === 'cancel') {
      await client.execute({ method: 'provider.cancel', input: {} }); process.stdout.write('Provider cancellation requested. Wait for SDK settlement before retry.\n');
    } else {
      const response = await client.execute({ method: 'provider.initialize', input: {} });
      if (response.method !== 'provider.initialize') throw new Error('Host response mismatch.');
      process.stdout.write(`${JSON.stringify({ providers: response.result.providers, authorization: 'SDK configured status; no paid validation performed.' })}\n`);
    }
    return;
  }
  throw new Error('Use the read-only doctor command for host observations.');
}
