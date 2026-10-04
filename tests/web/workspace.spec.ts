import { createMutationIdentity } from '../../src/shared/protocol/requestIds';
import { projectMonitorForNetwork } from '../../src/shared/protocol/diagnostics';
import type { TaskList } from '../../src/shared/contracts/tasks';
import { test, expect, inspector, actualTaskRow, object } from './fixture';

test('saved history pages and permission reductions use actual browser transport and host state', async ({ host }) => {
  await host.rpc({ type: 'seedHistory', count: 130 });
  const client = await host.login();
  const original = (await host.inspect()).runtime.sessionId;
  await host.claim(client.page);
  await client.page.getByRole('button', { name: 'Review controls', exact: true }).click();
  const history = client.page.getByRole('region', { name: 'Saved session history', exact: true });
  await history.getByRole('button', { name: 'Read from start', exact: true }).click();
  await expect(history.getByText('Saved fixture row 001', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'Next history page', exact: true }).click();
  await expect(history.getByText('Saved fixture row 130', { exact: true })).toBeVisible();
  await expect(history.getByText('Saved fixture row 001', { exact: true })).toHaveCount(0);
  await expect(history.getByText('End of saved history.', { exact: true })).toBeVisible();
  expect((await host.inspect()).runtime.sessionId).toBe(original);
  const pages = host.proxy.commands.filter((entry) => entry.method === 'session.history');
  expect(pages).toHaveLength(2);
  expect(object(pages[0]!.response!.result).items).toHaveLength(128);
  expect(object(pages[1]!.response!.result).items).toHaveLength(2);
  await client.page.getByRole('combobox', { name: 'Requested permission', exact: true }).selectOption('read-only');
  await client.page.getByRole('button', { name: 'Request permission review', exact: true }).click();
  await client.page.getByRole('button', { name: 'Confirm permission change', exact: true }).click();
  await expect.poll(async () => (await host.inspect()).runtime.permissionLevel).toBe('read-only');
  // The host applies the level before its reply reaches the proxy. Wait for
  // the actual recorded reply (as the later reduction below does), not for luck.
  await expect.poll(() => host.proxy.commands.filter((entry) => entry.method === 'permission.confirm' && entry.response?.ok === true).length).toBe(1);
  expect(host.captured(client, 'permission.confirm').response).toMatchObject({ ok: true, result: { level: 'read-only', applied: true } });
  expect((await host.inspect()).invocations.filter((entry) => entry.kind === 'prompt')).toHaveLength(0);

  // Elevate only while idle, then use the REAL production policy and runtime
  // transaction to reduce authority while a fake turn is actually in flight.
  await client.page.getByRole('combobox', { name: 'Requested permission', exact: true }).selectOption('edit');
  await client.page.getByRole('button', { name: 'Request permission review', exact: true }).click();
  await client.page.getByRole('button', { name: 'Confirm permission change', exact: true }).click();
  await expect.poll(async () => (await host.inspect()).runtime.permissionLevel).toBe('edit');
  await host.rpc({ type: 'barrier', operation: 'hold', name: 'emit' });
  await client.page.getByRole('button', { name: 'Hide controls', exact: true }).click();
  await client.page.getByLabel('Message to selected host session').fill('Hold one fake turn for permission fencing.');
  await client.page.getByRole('button', { name: 'Send prompt', exact: true }).click();
  await host.rpc({ type: 'barrier', operation: 'reached', name: 'emit' });
  expect((await host.inspect()).runtime.activeSessionRunning).toBe(true);
  await client.page.getByRole('button', { name: 'Review controls', exact: true }).click();
  await client.page.getByRole('combobox', { name: 'Requested permission', exact: true }).selectOption('read-only');
  await client.page.getByRole('button', { name: 'Request permission review', exact: true }).click();
  await client.page.getByRole('button', { name: 'Confirm permission change', exact: true }).click();
  await expect.poll(async () => (await host.inspect()).runtime.permissionLevel).toBe('read-only');
  expect((await host.inspect()).runtime.activeSessionRunning).toBe(true);
  await expect.poll(() => host.proxy.commands.filter((entry) => entry.method === 'permission.confirm' && entry.response?.ok === true).length).toBe(3);
  const applied = host.captured(client, 'permission.confirm');
  expect(applied.request.input).toMatchObject({ oldLevel: 'edit', newLevel: 'read-only' });
  expect(applied.response).toMatchObject({ ok: true, requestId: applied.request.requestId,
    result: { level: 'read-only', applied: true, sessionId: original } });
  const scope = { protocol: 1, serverEpoch: host.ready.serverEpoch, issuedAt: Date.now(),
    workspaceId: host.ready.workspaces.a.workspaceId, workspaceGeneration: host.ready.workspaces.a.workspaceGeneration };
  expect(await host.command(client, applied, { ...scope, method: 'command.status', requestId: crypto.randomUUID(),
    input: { requestId: applied.request.requestId } })).toMatchObject({ ok: true, result: { state: 'settled',
      receipt: { kind: 'permission', requestId: applied.request.requestId, oldLevel: 'edit', newLevel: 'read-only', outcome: 'applied', durability: 'journaled' } } });
  const issued = host.captured(client, 'permission.issue');
  expect(await host.command(client, issued, { ...scope, method: 'control.renew', requestId: crypto.randomUUID(),
    input: { generation: issued.request.controlGeneration } })).toMatchObject({ ok: true, result: { generation: issued.request.controlGeneration } });
  expect(await host.command(client, issued, { ...issued.request, requestId: crypto.randomUUID(),
    input: { ...object(issued.request.input), oldLevel: 'read-only', newLevel: 'edit' } }))
    .toMatchObject({ ok: false, error: { code: 'CONTROL_REQUIRED' } });
  expect((await host.inspect()).runtime.permissionLevel).toBe('read-only');
  await host.rpc({ type: 'barrier', operation: 'release', name: 'emit' });
  await expect.poll(async () => (await host.inspect()).runtime.activeSessionRunning).toBe(false);
  expect((await host.inspect()).invocations.filter((entry) => entry.kind === 'prompt')).toHaveLength(1);
});

// These tests deliberately keep the backend assertions beside DOM assertions.
// An enabled button, toast, sanitized fake row or mocked success is not evidence.
test('distinct browser identities start as observers; takeover fences the stale controller and preserves its draft', async ({ host }) => {
  const first = await host.login();
  const second = await host.login();
  expect(first.sessionId).not.toBe(second.sessionId);
  const readyFrames = host.proxy.frames.filter((frame) => frame.direction === 'server' && frame.value.type === 'ready');
  expect(new Set(readyFrames.map((frame) => frame.value.clientId)).size).toBe(2);
  const snapshot = host.captured(first, 'workspace.snapshot');
  const header = object(object(snapshot.response!.result).header);
  const firstScope = { workspaceId: host.ready.workspaces.a.workspaceId, workspaceGeneration: host.ready.workspaces.a.workspaceGeneration };
  const observerRequest = { protocol: 1, method: 'runtime.prompt', ...createMutationIdentity(host.ready.serverEpoch),
    ...firstScope, expectedSessionId: host.ready.workspaces.a.sessionId,
    selectionRevision: header.selectionRevision, controlGeneration: 1, input: { text: 'Observer must not execute.' } };
  await expect(first.page.getByRole('button', { name: 'Send prompt', exact: true })).toBeDisabled();
  await expect(second.page.getByRole('button', { name: 'Send prompt', exact: true })).toBeDisabled();
  expect(await host.command(second, host.captured(second, 'workspace.snapshot'), observerRequest))
    .toMatchObject({ ok: false, execution: 'not-started', error: { code: 'CONTROL_REQUIRED' } });
  expect((await host.inspect()).invocations.filter((entry) => entry.kind === 'prompt')).toHaveLength(0);
  const claim = await host.claim(first.page);
  const generation = object(claim.response!.result).generation;
  await first.page.getByLabel('Message to selected host session').fill('Preserve this original controller draft.');
  await second.page.getByRole('button', { name: 'Review controls', exact: true }).click();
  await second.page.getByRole('button', { name: 'Take over control', exact: true }).click();
  await second.page.getByRole('button', { name: 'Confirm takeover', exact: true }).click();
  await expect(second.page.getByRole('button', { name: 'Release control', exact: true })).toBeEnabled();
  await expect(second.page.getByRole('region', { name: 'Connection status', exact: true })).toBeVisible();
  await second.page.getByRole('button', { name: 'Hide controls', exact: true }).click();
  await expect(second.page.getByRole('button', { name: 'Review controls', exact: true })).toBeVisible();
  await expect(second.page.getByRole('button', { name: 'Release control', exact: true })).toBeEnabled();
  await expect(first.page.getByRole('button', { name: 'Send prompt', exact: true })).toBeDisabled();
  await expect(first.page.getByLabel('Message to selected host session')).toHaveValue('Preserve this original controller draft.');
  const takeover = host.captured(second, 'control.takeover');
  expect(Number(object(takeover.response!.result).generation)).toBeGreaterThan(Number(generation));
  const stale = { ...observerRequest, ...createMutationIdentity(host.ready.serverEpoch),
    controlGeneration: generation, input: { text: 'The stale controller must not execute.' } };
  expect(await host.command(first, claim, stale))
    .toMatchObject({ ok: false, execution: 'not-started', error: { code: 'CONTROL_REQUIRED' } });
  const backend = await host.inspect();
  expect(backend.invocations.filter((entry) => entry.kind === 'prompt')).toHaveLength(0);
  expect(backend.sentinel).toBe(host.repositories.before.a.sentinel);
  expect(backend.head).toBe(host.repositories.before.a.head);
  expect((await host.inspect('b')).sentinel).toBe(host.repositories.before.b.sentinel);
});

test('real prompt edits one private sentinel; browser review reads the actual diff and never retargets repository B', async ({ host }) => {
  const client = await host.login();
  const prompt = 'Apply the private fixture edit once and show its actual diff.';
  const after = 'repository A changed by actual fake Pi edit\n';
  await host.rpc({ type: 'planEdit', after });
  await host.rpc({ type: 'barrier', operation: 'hold', name: 'settle' });
  await host.claim(client.page);
  await client.page.getByLabel('Message to selected host session').fill(prompt);
  await client.page.getByRole('button', { name: 'Send prompt', exact: true }).click();
  await host.rpc({ type: 'barrier', operation: 'reached', name: 'settle' });
  const active = await host.inspect();
  expect(active.runtime.activeSessionRunning).toBe(true);
  expect(active.sentinel).toBe(after);
  expect(active.head).toBe(host.repositories.before.a.head);
  expect(active.diff).toContain('-repository A only');
  expect(active.diff).toContain('+repository A changed by actual fake Pi edit');
  expect(active.invocations.filter((entry) => entry.kind === 'prompt' && entry.input === prompt)).toHaveLength(1);
  expect(active.invocations.filter((entry) => entry.kind === 'toolResult' && entry.name === 'edit')).toHaveLength(1);
  await inspector(client.page, 'Work', 'Changes');
  await expect(client.page.getByRole('region', { name: 'Host Git details' })).toContainText('sentinel.txt');
  // Required browser diff capability. If the integrated App only has a status
  // count/"Diff unavailable" notice, this must fail, not silently pass as review.
  await client.page.getByRole('button', { name: 'Review diff sentinel.txt', exact: true }).click();
  await expect(client.page.getByRole('region', { name: 'Host Git diff' })).toContainText('repository A only');
  await expect(client.page.getByRole('region', { name: 'Host Git diff' })).toContainText('repository A changed by actual fake Pi edit');
  await host.rpc({ type: 'barrier', operation: 'release', name: 'settle' });
  await expect.poll(async () => (await host.inspect()).runtime.activeSessionRunning).toBe(false);
  const b = await host.inspect('b');
  expect(b.head).toBe(host.repositories.before.b.head);
  expect(b.sentinel).toBe(host.repositories.before.b.sentinel);
  expect(b.status).toBe('');
  expect(b.diff).toBe('');
  expect(host.proxy.commands.some((entry) => entry.method === 'git.diff')).toBe(true);
});

test('actual Goal/task transitions and paged Monitor rows agree with the desktop projection; source failures stay unknown', async ({ host }) => {
  let tasks = await host.rpc<TaskList>({ type: 'seedTasks', count: 27 });
  // Monitor orders normal rows by update time, not canonical task order. Make
  // task 02 genuinely the second Monitor row while task 01 stays active/current.
  // Use actual TaskService commits and a named observable condition, no clock
  // patch, artificial projection, sleep or invented token-to-task mapping.
  const seededUpdatedAt = Math.max(...tasks.tasks.map((task) => task.updatedAt));
  await expect.poll(async () => {
    tasks = await host.rpc<TaskList>({ type: 'taskStatus', id: tasks.tasks[1]!.id, status: 'todo' });
    return tasks.tasks[1]!.updatedAt;
  }, { message: 'Actual second todo task commit is newer than every seeded normal row.' }).toBeGreaterThan(seededUpdatedAt);
  const client = await host.login();
  await inspector(client.page, 'Run', 'Agents / Tasks');
  await actualTaskRow(client.page, tasks.tasks[0]!.title, 'in-progress');
  await inspector(client.page, 'Run', 'Monitor');
  const monitor = client.page.getByRole('region', { name: 'Monitoring dashboard' });
  await monitor.getByRole('button', { name: /^Tasks/ }).click();
  await expect(monitor.locator('.monitor-dashboard-row')).toHaveCount(25);
  await expect(monitor.locator('.monitor-dashboard-row-state').first()).toHaveText('active');
  const desktop = await host.inspect('a', 'tasks');
  const captured = host.captured(client, 'workspace.monitor');
  const network = object(captured.response!.result);
  const projected = await projectMonitorForNetwork(desktop.monitor, { sessionId: host.ready.workspaces.a.sessionId,
    selectionRevision: Number(network.selectionRevision) });
  const rows = (network.items as unknown[]).map(object);
  // Random source-bound host tokens/navigation are not deterministic projection
  // values. Compare ALL row facts plus scope/page/counts, then prove real tokens
  // by navigation and cross-scope/principal rejection below.
  const facts = (row: { source?: unknown; state?: unknown; title?: unknown; updatedAt?: unknown }) => ({
    source: row.source, state: row.state, title: row.title, updatedAt: row.updatedAt });
  expect(rows.map(facts)).toEqual(projected.items.map(facts));
  expect(network.counts).toEqual(projected.counts);
  expect(network).toMatchObject({ sessionId: host.ready.workspaces.a.sessionId, section: 'tasks', total: 27, offset: 0, limit: 25 });
  expect(new Set(rows.map((row) => row.id)).size).toBe(25);
  for (const row of rows) {
    expect(row.id).toMatch(/^[a-f0-9]{32}$/u);
    const navigation = object(row.navigation);
    expect(navigation.kind).toBe('task');
    expect(Number.isSafeInteger(navigation.expiresAt)).toBe(true);
    expect(Number(navigation.expiresAt)).toBeGreaterThan(Number(network.checkedAt));
    expect(tasks.tasks.some((task) => row.id === task.id || row.id === `task:${task.id}`)).toBe(false);
  }
  const pageWire = JSON.stringify(network);
  expect(pageWire).not.toContain(tasks.tasks[0]!.title);
  expect(pageWire).not.toContain(tasks.tasks[0]!.detail);
  expect(pageWire).not.toContain(tasks.tasks[0]!.id);
  expect(pageWire).not.toContain(host.ready.workspaces.a.path);
  expect(rows.every((row) => !('detail' in row) && !('ref' in row))).toBe(true);
  expect(desktop.monitor.items[0]?.ref).toMatchObject({ kind: 'task', id: tasks.tasks[0]!.id });
  expect(desktop.monitor.items[1]?.ref).toMatchObject({ kind: 'task', id: tasks.tasks[1]!.id });
  const targetTask = tasks.tasks[1]!;
  const targetRowId = String(rows[1]!.id);
  expect(targetTask.id).not.toBe(tasks.tasks[0]!.id);
  expect(targetRowId).not.toBe(rows[0]!.id);
  await monitor.getByRole('button', { name: `Open Monitor row ${targetRowId}`, exact: true }).click();
  const rowDetail = client.page.getByRole('region', { name: 'Monitor row details' });
  await expect(rowDetail).toContainText('normal');
  await expect(rowDetail.getByRole('button', { name: 'Open corresponding work', exact: true })).toBeVisible();
  const detailCapture = host.captured(client, 'workspace.monitorDetail');
  const detail = object(detailCapture.response!.result);
  expect(detail).toMatchObject({ id: targetRowId, sessionId: host.ready.workspaces.a.sessionId,
    selectionRevision: network.selectionRevision, state: 'normal', kind: 'task',
    updatedAt: rows[1]!.updatedAt, title: targetTask.title,
    detail: targetTask.detail, redacted: false });
  expect(detail.target).toEqual({ kind: 'task', taskId: targetTask.id });
  expect(detailCapture.request).toMatchObject({ serverEpoch: host.ready.serverEpoch, workspaceId: host.ready.workspaces.a.workspaceId,
    workspaceGeneration: host.ready.workspaces.a.workspaceGeneration,
    expectedSessionId: host.ready.workspaces.a.sessionId,
    selectionRevision: network.selectionRevision, input: { id: targetRowId } });
  // The same opaque token must not authorize another authenticated browser or
  // another registered project; no invented mapping is supplied by the test.
  const other = await host.login();
  const wrongClient = await host.command(other, host.captured(other, 'workspace.snapshot'), {
    ...detailCapture.request, requestId: crypto.randomUUID(), issuedAt: Date.now() });
  expect(wrongClient).toMatchObject({ ok: false, execution: 'not-started', error: { code: 'FORBIDDEN' } });
  expect(wrongClient).not.toHaveProperty('result');
  await inspector(other.page, 'Run', 'Monitor');
  const otherMonitor = other.page.getByRole('region', { name: 'Monitoring dashboard' });
  await otherMonitor.getByRole('button', { name: /^Tasks/ }).click();
  await expect(otherMonitor.locator('.monitor-dashboard-row')).toHaveCount(25);
  const otherRows = (object(host.captured(other, 'workspace.monitor').response!.result).items as unknown[]).map(object);
  expect(otherRows.map(facts)).toEqual(rows.map(facts));
  expect(new Set(otherRows.map((row) => row.id)).size).toBe(25);
  expect(otherRows.every((row) => row.navigation && !rows.some((original) => original.id === row.id))).toBe(true);
  const unknownId = `${targetRowId.slice(0, -1)}${targetRowId.endsWith('a') ? 'b' : 'a'}`;
  const unknownInput = Object.fromEntries(Object.entries(object(detailCapture.request.input))
    .map(([key, value]) => [key, value === targetRowId ? unknownId : value]));
  const unknownRow = await host.command(client, captured, { ...detailCapture.request,
    requestId: crypto.randomUUID(), issuedAt: Date.now(), input: unknownInput });
  expect(unknownRow).toMatchObject({ ok: false, execution: 'not-started', error: { code: 'FORBIDDEN' } });
  expect(unknownRow).not.toHaveProperty('result');
  const b = host.ready.workspaces.b;
  const bSnapshot = await host.command(client, captured, { ...host.captured(client, 'workspace.snapshot').request,
    requestId: crypto.randomUUID(), issuedAt: Date.now(), workspaceId: b.workspaceId, workspaceGeneration: b.workspaceGeneration });
  expect(bSnapshot.ok).toBe(true);
  const bHeader = object(object(bSnapshot.result).header);
  const wrongWorkspace = await host.command(client, captured, { ...detailCapture.request, requestId: crypto.randomUUID(),
    issuedAt: Date.now(), workspaceId: b.workspaceId, workspaceGeneration: b.workspaceGeneration,
    expectedSessionId: b.sessionId, selectionRevision: bHeader.selectionRevision });
  expect(wrongWorkspace).toMatchObject({ ok: false, execution: 'not-started', error: { code: 'FORBIDDEN' } });
  expect(wrongWorkspace).not.toHaveProperty('result');
  const navigationStart = host.proxy.commands.length;
  await rowDetail.getByRole('button', { name: 'Open corresponding work', exact: true }).click();
  const navigationReads = () => host.proxy.commands.slice(navigationStart).filter((entry) =>
    entry.method === 'workspace.monitorDetail' && entry.headers['x-fate-csrf'] === client.csrf && entry.response?.ok === true);
  await expect.poll(() => navigationReads().length).toBe(1);
  const navigationRead = navigationReads()[0]!;
  expect(navigationRead.request.requestId).not.toBe(detailCapture.request.requestId);
  expect(navigationRead.request).toMatchObject({ serverEpoch: host.ready.serverEpoch, workspaceId: host.ready.workspaces.a.workspaceId,
    workspaceGeneration: host.ready.workspaces.a.workspaceGeneration,
    expectedSessionId: host.ready.workspaces.a.sessionId,
    selectionRevision: network.selectionRevision, input: { id: targetRowId } });
  expect(navigationRead.response!.result).toEqual(detail);
  // Merely opening the generic tab or showing the first/current task cannot
  // pass: the second canonical row must be the ONLY network-focused task.
  await actualTaskRow(client.page, targetTask.title, 'todo');
  const taskList = client.page.getByRole('region', { name: 'Host agents and tasks' })
    .getByRole('region', { name: 'Task list strip', exact: true }).getByRole('list', { name: 'Task status' });
  await expect(taskList.getByRole('listitem')).toHaveCount(27);
  const firstTaskRow = taskList.getByRole('listitem').nth(0);
  const secondTaskRow = taskList.getByRole('listitem').nth(1);
  await expect(firstTaskRow).toHaveAttribute('data-task-id', tasks.tasks[0]!.id);
  await expect(firstTaskRow).toHaveAttribute('data-status', 'in-progress');
  await expect(firstTaskRow.getByText(tasks.tasks[0]!.title, { exact: true })).toBeVisible();
  await expect(firstTaskRow).not.toHaveAttribute('data-network-focus', 'true');
  await expect(secondTaskRow).toHaveAttribute('data-task-id', targetTask.id);
  await expect(secondTaskRow).toHaveAttribute('data-network-focus', 'true');
  const focusedTask = taskList.locator('li[data-network-focus="true"]');
  await expect(focusedTask).toHaveCount(1);
  await expect(focusedTask).toHaveAttribute('data-task-id', targetTask.id);
  await expect(focusedTask.getByText(targetTask.title, { exact: true })).toBeVisible();
  await inspector(client.page, 'Run', 'Monitor');
  await monitor.getByRole('button', { name: /^Tasks/ }).click();
  await expect(monitor.locator('.monitor-dashboard-row')).toHaveCount(25);
  await monitor.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(monitor.locator('.monitor-dashboard-row')).toHaveCount(2);
  await expect(monitor).toContainText('26–27 / 27');
  expect(object(host.captured(client, 'workspace.monitor').request.input)).toMatchObject({ section: 'tasks', offset: 25, limit: 25 });
  const detailPage = await host.inspect('a', 'tasks', 25);
  expect(detailPage.monitor.items).toHaveLength(2);
  expect(detailPage.monitor.total).toBe(27);
  const nextPage = object(host.captured(client, 'workspace.monitor').response!.result);
  const nextRows = (nextPage.items as unknown[]).map(object);
  expect(nextRows.map(facts)).toEqual((await projectMonitorForNetwork(detailPage.monitor, {
    sessionId: host.ready.workspaces.a.sessionId, selectionRevision: Number(nextPage.selectionRevision) })).items.map(facts));
  expect(new Set(nextRows.map((row) => row.id)).size).toBe(2);
  expect(nextRows.every((row) => row.navigation && !rows.some((previous) => previous.id === row.id))).toBe(true);
  await monitor.getByRole('button', { name: 'Previous', exact: true }).click();
  await host.rpc({ type: 'taskStatus', id: tasks.tasks[0]!.id, status: 'blocked' });
  await monitor.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(monitor.locator('.monitor-dashboard-row-state').first()).toHaveText('attention');
  expect((await host.inspect('a', 'tasks')).monitor.items[0]).toMatchObject({ state: 'attention', ref: { id: tasks.tasks[0]!.id } });
  await host.rpc({ type: 'taskStatus', id: tasks.tasks[0]!.id, status: 'done' });
  await host.rpc({ type: 'monitorSource', state: 'partial' });
  await monitor.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(monitor).toContainText('Runs: latest 1,000 only.');
  await expect(monitor.locator('.monitor-state')).toHaveText('unknown');
  expect((await host.inspect()).monitor.sources.runs).toBe('partial');
  await host.rpc({ type: 'monitorSource', state: 'failure' });
  await monitor.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(monitor).toContainText('Unavailable: runs');
  await expect(monitor.locator('.monitor-state')).toHaveText('unknown');
  expect(await monitor.innerText()).not.toContain('Private fixture source failure');
  expect((await host.inspect()).monitor.sources.runs).toBe('unknown');
  const failedSource = object(host.captured(client, 'workspace.monitor').response!.result);
  expect(object(failedSource.sources).runs).toBe('unknown');
  expect(JSON.stringify(failedSource)).not.toContain('Private fixture source failure');
  // Goal creation/pausing is a host-side operator action, not an invented browser
  // mutation route. It uses the real GoalMax coordinator and persistence.
  await host.rpc({ type: 'barrier', operation: 'hold', name: 'emit' });
  await host.rpc({ type: 'goal', operation: 'create', objective: 'Actual browser GoalMax visibility sentinel' });
  await host.rpc({ type: 'barrier', operation: 'reached', name: 'emit' });
  await inspector(client.page, 'Run', 'Goal');
  const goal = client.page.getByRole('region', { name: 'Host goal details' });
  await expect(goal).toContainText('Actual browser GoalMax visibility sentinel');
  await expect(goal.locator('.goalmax-deck-header')).toHaveAttribute('data-status', 'active');
  expect((await host.inspect()).goal?.status).toBe('active');
  await host.rpc({ type: 'goal', operation: 'pause' });
  await expect(goal.locator('.goalmax-deck-header')).toHaveAttribute('data-status', 'paused');
  const paused = await host.inspect();
  expect(paused.goal?.status).toBe('paused');
  expect(paused.goal?.continuation.pending).toBe(false);
  // Goal pause stops future scheduling; it does not invent a stop for the
  // already admitted turn. Preserve the real coordinator's existing contract.
  expect(paused.runtime.activeSessionRunning).toBe(true);
  expect(paused.invocations.filter((entry) => entry.kind === 'cancel')).toHaveLength(0);
  await host.rpc({ type: 'barrier', operation: 'release', name: 'emit' });
  await expect.poll(async () => (await host.inspect()).runtime.activeSessionRunning).toBe(false);
  const settledGoal = await host.inspect();
  expect(settledGoal.goal?.status).toBe('paused');
  expect(settledGoal.goal?.continuation.pending).toBe(false);
  await inspector(client.page, 'Run', 'Agents / Tasks');
  await actualTaskRow(client.page, tasks.tasks[0]!.title, 'done');
  expect(host.proxy.commands.map((entry) => entry.method)).toEqual(expect.arrayContaining(['goal.get', 'task.list', 'workspace.monitor']));
});
