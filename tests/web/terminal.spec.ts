import { randomUUID } from 'node:crypto';
import { test, expect, object } from './fixture';
import type { NativePtyObservation } from '../v2/helpers/nativePtyPort';

test.use({ terminalEnabled: true });

test('opt-in browser terminal requires consent and control, writes only its real host root, and does not replay on reconnect', async ({ host }) => {
  const client = await host.login();
  const creates = () => host.proxy.frames.filter((frame) => frame.direction === 'client' && frame.value.type === 'terminal.create');
  const created = () => host.proxy.frames.filter((frame) => frame.direction === 'server' && frame.value.type === 'terminal.created');
  await client.page.getByRole('button', { name: 'Open terminal', exact: true }).click();
  let terminal = client.page.getByRole('region', { name: 'Manual integrated terminal', exact: true });
  await expect(terminal).toContainText('unsandboxed shell on the execution host');
  await expect(terminal.getByRole('button', { name: 'Start manual shell', exact: true })).toBeDisabled();
  expect(creates()).toHaveLength(0);
  await terminal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await host.claim(client.page);
  await client.page.getByRole('button', { name: 'Open terminal', exact: true }).click();
  terminal = client.page.getByRole('region', { name: 'Manual integrated terminal', exact: true });
  await expect(terminal).toContainText('T42 private test host');
  expect(creates()).toHaveLength(0);
  await terminal.getByRole('button', { name: 'Start manual shell', exact: true }).click();
  await expect.poll(() => created().length).toBe(1);
  const actual = object(created()[0]!.value.result);
  expect(actual.cwd).toBe(host.ready.workspaces.a.path);
  expect(actual.shell).toEqual(expect.any(String));
  const marker = `terminal-proof-${randomUUID()}`;
  const command = process.platform === 'win32' ? `echo ${marker}>terminal-proof.txt` : `printf '${marker}\\n' > terminal-proof.txt`;
  await terminal.locator('.xterm-helper-textarea').focus();
  await client.page.keyboard.type(command);
  await client.page.keyboard.press('Enter');
  await expect.poll(async () => (await host.rpc<{ a: string | null; b: string | null }>({ type: 'terminalProof' })).a?.trim()).toBe(marker);
  expect(await host.rpc({ type: 'terminalProof' })).toMatchObject({ b: null });
  expect((await host.inspect()).invocations.filter((entry) => entry.kind === 'prompt')).toHaveLength(0);
  expect(creates()).toHaveLength(1);
  // A natural exit is native proof, not a requested kill or synthetic -1 event.
  await client.page.keyboard.type('exit');
  await client.page.keyboard.press('Enter');
  await expect.poll(async () => (await host.rpc<NativePtyObservation[]>({ type: 'terminalStatus' }))[0]?.teardownConfirmed).toBe(true);
  const first = (await host.rpc<NativePtyObservation[]>({ type: 'terminalStatus' }))[0]!;
  expect(first.ptyPid).toBeGreaterThan(0);
  expect(first.nativeExitCode).toBe(0);
  expect(first.driverClosed).toBe(true);
  expect(first.driverForceKillRequested).toBe(false);
  await terminal.getByRole('button', { name: 'Close terminal', exact: true }).click();
  await client.page.getByRole('button', { name: 'Open terminal', exact: true }).click();
  // The shell starts only for a connected controller. Say what the page and the host show when it cannot.
  const restart = terminal.getByRole('button', { name: 'Start manual shell', exact: true });
  try { await expect(restart).toBeEnabled({ timeout: 20_000 }); }
  catch (cause) {
    const frames = host.proxy.frames.slice(-30).map((frame) => `${frame.direction}:${JSON.stringify(frame.value).slice(0, 140)}`);
    const commands = host.proxy.commands.slice(-10).map((entry) => `${entry.method}:${JSON.stringify(entry.response).slice(0, 200)}`);
    const page = (await client.page.locator('body').innerText()).replace(/\s+/gu, ' ').slice(0, 2000);
    throw new Error(['The manual shell cannot start again.', `PAGE: ${page}`, 'COMMANDS:', ...commands, 'FRAMES:', ...frames].join('\n'), { cause });
  }
  await restart.click();
  await expect.poll(() => created().length).toBe(2);
  await expect.poll(async () => (await host.rpc<NativePtyObservation[]>({ type: 'terminalStatus' }))[1]?.ptyPid ?? 0).toBeGreaterThan(0);
  // Real socket loss closes the connection-bound shell. View reconnection must
  // neither recreate that process nor queue/replay its input on a replacement.
  host.proxy.disconnectEvents();
  await expect(client.page.getByRole('button', { name: 'Claim control', exact: true })).toBeEnabled();
  await host.claim(client.page);
  await expect(terminal.getByRole('button', { name: 'Start manual shell', exact: true })).toBeVisible();
  expect(creates()).toHaveLength(2);
  await expect.poll(async () => (await host.rpc<NativePtyObservation[]>({ type: 'terminalStatus' }))[1]?.teardownConfirmed).toBe(true);
  expect((await host.rpc<{ a: string | null; b: string | null }>({ type: 'terminalProof' })).a?.trim()).toBe(marker);
  await terminal.getByRole('button', { name: 'Cancel', exact: true }).click();
});
