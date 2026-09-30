import { createMutationIdentity } from '../../src/shared/protocol/requestIds';
import type { TaskList } from '../../src/shared/contracts/tasks';
import { test, expect, inspector, actualTaskRow, object } from './fixture';

const promptAdmissions = (entries: Awaited<ReturnType<import('./fixture').WebHost['inspect']>>['invocations'], text: string) =>
  entries.filter((entry) => entry.kind === 'prompt' && entry.input === text);

test('lost HTTP command ACK survives reload and reviews only the original ID with one Pi admission and one file effect', async ({ host }) => {
  const client = await host.login();
  const text = 'Change the sentinel once even when the admission ACK is lost.';
  const after = 'lost ACK edited A once\n';
  await host.rpc({ type: 'planEdit', after });
  await host.rpc({ type: 'barrier', operation: 'hold', name: 'settle' });
  await host.claim(client.page);
  host.proxy.dropNextResponse('runtime.prompt');
  await client.page.getByLabel('Message to selected host session').fill(text);
  await client.page.getByRole('button', { name: 'Send prompt', exact: true }).click();
  await expect(client.page.getByRole('button', { name: 'Review original request', exact: true })).toBeVisible();
  await host.rpc({ type: 'barrier', operation: 'reached', name: 'settle' });
  const submitted = host.proxy.commands.filter((entry) => entry.method === 'runtime.prompt');
  expect(submitted).toHaveLength(1);
  const original = submitted[0]!;
  expect(original.dropped).toBe(true);
  expect(original.response).toMatchObject({ ok: true, result: { requestId: original.request.requestId,
    kind: 'prompt', outcome: 'accepted', durability: 'journaled', sessionId: host.ready.workspaces.a.sessionId } });
  const beforeReload = await host.inspect();
  expect(beforeReload.runtime.activeSessionRunning).toBe(true);
  expect(beforeReload.sentinel).toBe(after);
  expect(promptAdmissions(beforeReload.invocations, text)).toHaveLength(1);
  expect(beforeReload.invocations.filter((entry) => entry.kind === 'toolResult' && entry.name === 'edit')).toHaveLength(1);
  await client.page.reload();
  await expect(client.page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(client.page.getByRole('button', { name: 'Review original request', exact: true })).toBeEnabled();
  await expect(client.page.getByRole('button', { name: 'Send prompt', exact: true })).toBeDisabled();
  const saved = await client.page.evaluate(() => Object.entries(sessionStorage));
  expect(JSON.stringify(saved)).toContain(String(original.request.requestId));
  expect(JSON.stringify(saved)).not.toContain(text);
  expect(JSON.stringify(saved)).not.toContain(client.code);
  expect(JSON.stringify(saved)).not.toContain(client.csrf);
  await client.page.getByRole('button', { name: 'Review original request', exact: true }).click();
  await expect(client.page.getByText(`Original request ${String(original.request.requestId)} was admitted. The run may still be active.`, { exact: true })).toBeVisible();
  const status = host.proxy.commands.filter((entry) => entry.method === 'command.status');
  expect(status.length).toBeGreaterThanOrEqual(2); // automatic status + explicit post-reload review
  expect(status.map((entry) => object(entry.request.input).requestId)).toEqual(Array(status.length).fill(original.request.requestId));
  expect(host.proxy.commands.filter((entry) => entry.method === 'runtime.prompt')).toHaveLength(1);
  await host.rpc({ type: 'barrier', operation: 'release', name: 'settle' });
  await expect.poll(async () => (await host.inspect()).runtime.activeSessionRunning).toBe(false);
  await client.page.reload();
  await expect(client.page.getByRole('button', { name: 'Claim control', exact: true })).toBeEnabled();
  expect(host.proxy.commands.filter((entry) => entry.method === 'runtime.prompt')).toHaveLength(1);
  const final = await host.inspect();
  expect(promptAdmissions(final.invocations, text)).toHaveLength(1);
  expect(final.sentinel).toBe(after);
  expect(final.head).toBe(host.repositories.before.a.head);
  expect((await host.inspect('b')).sentinel).toBe(host.repositories.before.b.sentinel);
});

test('snapshot high-water replays an intervening real task event; a later missing frame forces fresh snapshot recovery', async ({ host }) => {
  const tasks = await host.rpc<TaskList>({ type: 'seedTasks', count: 1 });
  const client = await host.login();
  // Hold only the real HTTP snapshot response after the immutable snapshot and
  // high-water have been captured. A host task changes before browser subscribe.
  const held = host.proxy.holdNextResponse('workspace.snapshot');
  const reload = client.page.reload();
  const captured = await held;
  expect(captured.response?.ok).toBe(true);
  const highWater = object(object(object(captured.response!.result).header).eventStream);
  await host.rpc({ type: 'taskStatus', id: tasks.tasks[0]!.id, status: 'blocked' });
  await host.rpc({ type: 'checkpoint' });
  host.proxy.releaseResponse();
  await reload;
  await expect.poll(() => host.proxy.frames.some((frame) => frame.direction === 'client' && frame.value.type === 'subscribe'
    && object(frame.value.cursor).sequence === highWater.sequence && object(frame.value.cursor).streamId === highWater.streamId)).toBe(true);
  await expect.poll(() => host.proxy.frames.some((frame) => frame.direction === 'server' && frame.value.type === 'event'
    && object(frame.value.event).category === 'task' && object(frame.value.event).streamId === highWater.streamId
    && Number(object(frame.value.event).sequence) > Number(highWater.sequence))).toBe(true);
  await inspector(client.page, 'Run', 'Agents / Tasks');
  await actualTaskRow(client.page, tasks.tasks[0]!.title, 'blocked');
  const readyBefore = host.proxy.frames.filter((frame) => frame.direction === 'server' && frame.value.type === 'ready').length;
  const snapshotBefore = host.proxy.commands.filter((entry) => entry.method === 'workspace.snapshot').length;
  host.proxy.dropNextEvent();
  await host.rpc({ type: 'taskStatus', id: tasks.tasks[0]!.id, status: 'in-progress' });
  await host.rpc({ type: 'taskStatus', id: tasks.tasks[0]!.id, status: 'done' });
  await expect.poll(() => host.proxy.frames.filter((frame) => frame.dropped && frame.value.type === 'event').length).toBe(1);
  await expect.poll(() => host.proxy.frames.filter((frame) => frame.direction === 'server' && frame.value.type === 'ready').length).toBeGreaterThan(readyBefore);
  await expect.poll(() => host.proxy.commands.filter((entry) => entry.method === 'workspace.snapshot').length).toBeGreaterThan(snapshotBefore);
  await actualTaskRow(client.page, tasks.tasks[0]!.title, 'done');
  expect((await host.inspect()).tasks?.tasks[0]?.status).toBe('done');
  expect(host.proxy.commands.filter((entry) => entry.method === 'runtime.prompt')).toHaveLength(0);
});

test('event outage preserves an unsent scoped draft and leaves the actual active run alive until explicit settlement', async ({ host }) => {
  const client = await host.login();
  await host.rpc({ type: 'barrier', operation: 'hold', name: 'settle' });
  const claim = await host.claim(client.page);
  const snapshot = host.captured(client, 'workspace.snapshot');
  const header = object(object(snapshot.response!.result).header);
  const text = 'This actual active run must survive a browser event outage.';
  const response = await host.command(client, claim, { protocol: 1, method: 'runtime.prompt', ...createMutationIdentity(host.ready.serverEpoch),
    workspaceId: host.ready.workspaces.a.workspaceId, workspaceGeneration: host.ready.workspaces.a.workspaceGeneration,
    expectedSessionId: host.ready.workspaces.a.sessionId, selectionRevision: header.selectionRevision,
    controlGeneration: object(claim.response!.result).generation, input: { text } });
  expect(response).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
  await host.rpc({ type: 'barrier', operation: 'reached', name: 'settle' });
  const draft = 'Unsent draft must not become an automatic reconnect prompt.';
  // The raw host command above can still be invalidating the browser's old
  // view. Prove it observed the held run, then prove this draft exists before
  // deliberately cutting events; a resolved fill alone is not that evidence.
  await expect(client.page.getByRole('region', { name: 'Connection status', exact: true })).toContainText('Selected session: running');
  await expect(client.page.getByLabel('Message to selected host session')).toBeEnabled();
  await client.page.getByLabel('Message to selected host session').fill(draft);
  await expect(client.page.getByLabel('Message to selected host session')).toHaveValue(draft);
  host.proxy.pauseEvents();
  await expect(client.page.getByRole('button', { name: 'Send prompt', exact: true })).toBeDisabled();
  await expect(client.page.getByLabel('Message to selected host session')).toHaveValue(draft);
  await expect(client.page.getByRole('region', { name: 'Connection status', exact: true })).toContainText(/last confirmed/i);
  const during = await host.inspect();
  expect(during.runtime.activeSessionRunning).toBe(true);
  expect(promptAdmissions(during.invocations, text)).toHaveLength(1);
  host.proxy.resumeEvents();
  await expect(client.page.getByRole('button', { name: 'Claim control', exact: true })).toBeEnabled();
  await expect(client.page.getByLabel('Message to selected host session')).toHaveValue(draft);
  expect((await host.inspect()).runtime.activeSessionRunning).toBe(true);
  expect(host.proxy.commands.filter((entry) => entry.method === 'runtime.prompt')).toHaveLength(1);
  await host.rpc({ type: 'barrier', operation: 'release', name: 'settle' });
  await expect.poll(async () => (await host.inspect()).runtime.activeSessionRunning).toBe(false);
  expect(host.proxy.commands.filter((entry) => entry.method === 'runtime.prompt')).toHaveLength(1);
});

test('real server process crash changes epoch and recovers interrupted/unknown work without auto-resuming the original request or draft', async ({ host }) => {
  const client = await host.login();
  const text = 'Keep this real fake Pi turn active until the process dies.';
  await host.rpc({ type: 'planEdit', after: 'edit happened before actual process death\n' });
  await host.rpc({ type: 'barrier', operation: 'hold', name: 'settle' });
  await host.claim(client.page);
  host.proxy.dropNextResponse('runtime.prompt');
  await client.page.getByLabel('Message to selected host session').fill(text);
  await client.page.getByRole('button', { name: 'Send prompt', exact: true }).click();
  await host.rpc({ type: 'barrier', operation: 'reached', name: 'settle' });
  await expect(client.page.getByRole('button', { name: 'Review original request', exact: true })).toBeVisible();
  const original = host.proxy.commands.find((entry) => entry.method === 'runtime.prompt')!;
  // Observe genuine automatic original-ID reconciliation before killing its
  // owner; the later explicit new-epoch review must be a separate request.
  await expect.poll(() => host.proxy.commands.some((entry) => entry.method === 'command.status'
    && object(entry.request.input).requestId === original.request.requestId
    && entry.request.serverEpoch === host.ready.serverEpoch && entry.response?.ok === true)).toBe(true);
  const oldEpoch = host.ready.serverEpoch;
  const checkpoint = object(await host.rpc({ type: 'checkpoint' }));
  expect(Array.isArray(checkpoint.records)).toBe(true);
  expect((checkpoint.records as unknown[]).some((record) => object(record).status === 'running')).toBe(true);
  const before = await host.inspect();
  expect(before.runtime.activeSessionRunning).toBe(true);
  expect(before.sentinel).toBe('edit happened before actual process death\n');
  await host.crashAndRestart();
  expect(host.ready.serverEpoch).not.toBe(oldEpoch);
  expect(host.ready.workspaces.a.workspaceId).toBe(host.boots[0]!.workspaces.a.workspaceId);
  expect(host.ready.workspaces.b.workspaceId).toBe(host.boots[0]!.workspaces.b.workspaceId);
  expect(host.ready.recovered.records.length).toBeGreaterThan(0);
  expect(host.ready.recovered.records.some((record) => record.status === 'interrupted' || record.status === 'unknown')).toBe(true);
  // Reload still uses the genuine cookie recovery and NEW socket ticket. The
  // old pending command ID remains an original-epoch status query, never a send.
  await client.page.reload();
  await expect(client.page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(client.page.getByRole('button', { name: 'Send prompt', exact: true })).toBeDisabled();
  await expect(client.page.getByRole('region', { name: 'Connection status', exact: true })).toContainText(/review|required|unknown|interrupted/i);
  await expect(client.page.getByRole('button', { name: 'Review original request', exact: true })).toBeEnabled();
  await client.page.getByRole('button', { name: 'Review original request', exact: true }).click();
  await expect.poll(() => host.proxy.commands.some((entry) => entry.method === 'command.status'
    && entry.request.serverEpoch === host.ready.serverEpoch && entry.response?.ok === true)).toBe(true);
  const queries = host.proxy.commands.filter((entry) => entry.method === 'command.status');
  expect(queries.length).toBeGreaterThanOrEqual(2);
  expect(queries.map((entry) => object(entry.request.input).requestId)).toEqual(Array(queries.length).fill(original.request.requestId));
  expect(String(original.request.requestId)).toContain(oldEpoch);
  const reviewed = queries.find((entry) => entry.request.serverEpoch === host.ready.serverEpoch && entry.response?.ok === true)!;
  expect(reviewed.request).toMatchObject({ workspaceId: host.boots[0]!.workspaces.a.workspaceId,
    input: { requestId: original.request.requestId } });
  expect(reviewed.response?.serverEpoch).toBe(host.ready.serverEpoch);
  expect(host.proxy.commands.filter((entry) => entry.method === 'runtime.prompt')).toHaveLength(1);
  const recovered = await host.inspect();
  expect(recovered.runtime.activeSessionRunning).toBe(false);
  expect(recovered.invocations.filter((entry) => entry.kind === 'prompt')).toHaveLength(0);
  expect(recovered.sentinel).toBe(before.sentinel);
  expect(recovered.head).toBe(before.head);
  expect(recovered.goal?.continuation.pending ?? false).toBe(false);
  const newestReady = [...host.proxy.frames].reverse().find((frame) => frame.direction === 'server' && frame.value.type === 'ready')!;
  expect(newestReady.value.serverEpoch).toBe(host.ready.serverEpoch);
  expect((await host.inspect('b')).sentinel).toBe(host.repositories.before.b.sentinel);
});
