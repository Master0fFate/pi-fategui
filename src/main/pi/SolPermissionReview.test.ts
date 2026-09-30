// Independent permission gate probe. Fixture files remain entirely inside a private temp root.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSessionRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it } from 'vitest';
import { PiRuntimeService } from './PiRuntimeService';
import { InMemorySessionPermissionStore } from './SessionPermissionStore';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

it('revokes a retained full-access write handle after changing to Open without Pi', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sol-permission-stale-tool-')));
  roots.push(root);
  const trustedPath = path.join(root, 'trusted');
  const untrustedPath = path.join(root, 'untrusted');
  await fs.mkdir(trustedPath);
  await fs.mkdir(untrustedPath);
  const sentinel = path.join(root, 'outside-original-project.txt');
  await fs.writeFile(sentinel, 'unchanged');
  const runtime = new PiRuntimeService(undefined, undefined, new InMemorySessionPermissionStore());
  try {
    await runtime.openProject({ path: trustedPath, name: 'trusted', trusted: true });
    await runtime.setPermissionLevel('full-access');
    const old = (runtime as unknown as { selectedSlot: { runtime: AgentSessionRuntime } }).selectedSlot.runtime.session;
    const retained = old.agent.state.tools.find((tool) => tool.name === 'write');
    expect(retained).toBeDefined();
    expect(await runtime.openProject({ path: untrustedPath, name: 'untrusted', trusted: false }))
      .toMatchObject({ status: 'disconnected', error: { code: 'PROJECT_NOT_TRUSTED' } });
    await expect(retained!.execute('old-full-access-handle', { path: sentinel, content: 'changed by stale handle' }))
      .rejects.toThrow(/stale|authority|project|trust|permission/i);
    expect(await fs.readFile(sentinel, 'utf8')).toBe('unchanged');
  } finally { await runtime.dispose(); }
});
