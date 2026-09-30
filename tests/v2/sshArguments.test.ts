import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sshConnectionProfileSchema } from '../../src/shared/protocol/connectionProfiles';
import { buildSshArguments, buildSshEnvironment, classifySshFailure, reserveTunnelPort, stopOwnedSshChild, SshTunnel } from '../../src/main/connections/SshTunnel';
import { ConnectionProfileStore } from '../../src/main/connections/ConnectionProfileStore';
import { DesktopConnectionRouter } from '../../src/main/connections/DesktopConnectionRouter';

const profile = { id: randomUUID(), label: 'Fixture host', hostId: randomUUID(), approved: true as const, transport: 'ssh' as const,
  sshAlias: 'fixture-only', remotePort: 44221, credentialRef: path.join(process.env.FATE_V2_TEST_ROOT!, 'client-reference'),
  workspaceId: randomUUID(), workspaceGeneration: 3 };

describe('SSH argument and ownership unit checks; not SSH acceptance', () => {
  it('keeps system SSH in an array with strict tunnel-only flags and no multiplex master', () => {
    const args = buildSshArguments(profile, 44222);
    for (const option of ['-N', '-T', '-a', '-x', 'BatchMode=yes', 'StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes',
      'ForwardAgent=no', 'PermitLocalCommand=no', 'RemoteCommand=none', 'ControlMaster=no', 'ControlPersist=no', 'ControlPath=none']) expect(args).toContain(option);
    expect(args.slice(-2)).toEqual(['--', 'fixture-only']);
    expect(args).toContain('127.0.0.1:44222:127.0.0.1:44221');
    expect(args).not.toContain('ClearAllForwardings=yes'); expect(args).not.toContain(profile.credentialRef);
  });
  it.each(['-Fanything', 'x y', 'x;echo', 'x\nHost', 'x@y', 'x$(echo)', '`id`'])('rejects unsafe alias %j', (sshAlias) => {
    expect(() => buildSshArguments({ ...profile, sshAlias }, 44222)).toThrow();
  });
  it.each([0, -1, 65536, 1.5, '22'])('rejects invalid remote port %j', (remotePort) => {
    expect(sshConnectionProfileSchema.safeParse({ ...profile, remotePort }).success).toBe(false);
  });
  it('retains old direct M4 profiles and returns no private SSH fields to the renderer', () => {
    const direct = { id: randomUUID(), label: 'Direct host', hostId: randomUUID(), approved: true as const,
      baseUrl: 'http://127.0.0.1:44223', credentialRef: profile.credentialRef };
    const store = new ConnectionProfileStore([direct, profile]);
    expect(store.resolve(direct.id)).toEqual(direct); expect(store.resolve(profile.id)).toEqual(profile);
    expect(store.list()).toEqual([{ id: direct.id, label: direct.label, hostId: direct.hostId }, { id: profile.id, label: profile.label, hostId: profile.hostId }]);
    expect(JSON.stringify(store.list())).not.toContain(profile.credentialRef); expect(JSON.stringify(store.list())).not.toContain(profile.sshAlias);
  });
  it('keeps configured SSH agent access but does not copy provider/askpass environment to ssh', () => {
    expect(buildSshEnvironment({ PATH: '/usr/bin', HOME: '/fixture/home', SSH_AUTH_SOCK: '/fixture/agent',
      OPENAI_API_KEY: 'fixture-only-secret', SSH_ASKPASS: '/fixture/prompt', NODE_OPTIONS: '--inspect' }))
      .toEqual({ PATH: '/usr/bin', HOME: '/fixture/home', SSH_AUTH_SOCK: '/fixture/agent', LANG: 'C', LC_ALL: 'C' });
  });
  it.each([
    ['Host key verification failed.', 'host-verification-required'],
    ['WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', 'host-verification-required'],
    ['Permission denied (publickey).', 'authentication-failed'],
    ['bind [127.0.0.1]:123: Address already in use', 'port-collision'],
  ])('classifies bounded private stderr %j without returning its bytes', (stderr, code) => {
    const error = classifySshFailure(stderr); expect(error.code).toBe(code); expect(error.message).not.toContain(stderr);
  });
  it('uses a real local socket to refuse a port collision', async () => {
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture socket is unavailable.');
    try { await expect(reserveTunnelPort(address.port)).rejects.toMatchObject({ code: 'port-collision' }); }
    finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it('reports missing real ssh executable without accepting a listener', async () => {
    const tunnel = new SshTunnel(profile, { executable: path.join(process.env.FATE_V2_TEST_ROOT!, 'absent-ssh') });
    await expect(tunnel.open(new AbortController().signal)).rejects.toMatchObject({ code: 'ssh-unavailable' });
    expect(tunnel.ownedPid).toBeNull(); await tunnel.close();
  });
  it('keeps a failed SSH selection remote and does not admit a local workspace operation', async () => {
    const router = new DesktopConnectionRouter(new ConnectionProfileStore([profile], async () => `fc1_${'x'.repeat(43)}`), {}, {
      tunnelOptions: { executable: path.join(process.env.FATE_V2_TEST_ROOT!, 'absent-ssh') },
    });
    try {
      await router.select({ kind: 'remote', profileId: profile.id });
      await router.connect({ generation: router.state.generation }, () => true);
      expect(router.state).toMatchObject({ kind: 'remote', status: 'error', message: 'ssh-unavailable', scope: null });
      await expect(router.routeLegacy('project:open', () => undefined)).rejects.toThrow(/local desktop/u);
    } finally { await router.close(); }
  });
  it('cancels before a delayed main credential read can create a tunnel', async () => {
    let finish!: (credential: string) => void, entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const store = new ConnectionProfileStore([profile], () => { entered(); return new Promise<string>((resolve) => { finish = resolve; }); });
    const opening = vi.spyOn(SshTunnel.prototype, 'open');
    const router = new DesktopConnectionRouter(store);
    try {
      await router.select({ kind: 'remote', profileId: profile.id });
      const pending = router.connect({ generation: router.state.generation }, () => true); await reading;
      router.disconnect({ generation: router.state.generation }); finish(`fc1_${'x'.repeat(43)}`); await pending;
      expect(opening).not.toHaveBeenCalled(); expect(router.state).toMatchObject({ kind: 'remote', status: 'disconnected', scope: null });
    } finally { opening.mockRestore(); await router.close(); }
  });
  it('closes one real child and leaves the separate original host PID alive', async () => {
    const owned = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', shell: false });
    const host = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', shell: false });
    try {
      await Promise.all([once(owned, 'spawn'), once(host, 'spawn')]);
      await stopOwnedSshChild(owned, 1000, 1000); expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
      if (!host.pid) throw new Error('Independent fixture PID is unavailable.'); process.kill(host.pid, 0);
    } finally { await Promise.all([stopOwnedSshChild(owned, 1000, 1000), stopOwnedSshChild(host, 1000, 1000)]); }
  });
  it('uses a unit kill-refusal seam to prove stalled stop does not clear actual child state', async () => {
    const owned = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', shell: false });
    await once(owned, 'spawn'); const kill = vi.spyOn(owned, 'kill').mockReturnValue(false);
    try {
      await expect(stopOwnedSshChild(owned, 1, 1)).rejects.toMatchObject({ code: 'stop-pending' });
      expect(owned.exitCode).toBeNull(); expect(owned.signalCode).toBeNull();
    } finally { kill.mockRestore(); await stopOwnedSshChild(owned, 1000, 1000); }
  });
});
