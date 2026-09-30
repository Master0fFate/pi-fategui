import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('an existing Fate profile imports missing Pi providers and a local MCP server without the Pi CLI', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fate-pi-switch-e2e-'));
  const data = path.join(root, 'data');
  const agent = path.join(root, 'agent');
  await Promise.all([mkdir(data), mkdir(agent)]);
  await writeFile(path.join(data, 'auth.json'), JSON.stringify({ fate: { type: 'api_key', key: 'FATE-SYNTHETIC' } }));
  await writeFile(path.join(agent, 'auth.json'), JSON.stringify({ pi: { type: 'api_key', key: 'PI-SYNTHETIC' } }));
  await writeFile(path.join(agent, 'mcp.json'), JSON.stringify({ mcpServers: {
    echo: { command: process.execPath, args: [path.resolve('tests/fixtures/mcp-echo.mjs')] },
  } }));
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(root, 'chromium')}`, path.resolve('.'), '--new-instance'],
    env: { ...process.env, VITE_DEV_SERVER_URL: '', FATE_GUI_DATA_DIR: data, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('[data-bridge-status="ready"]')).toBeVisible();
    await page.keyboard.press('Control+K');
    await page.getByLabel('Search commands').fill('settings');
    await page.getByLabel('Search commands').press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: /MCP/ }).click();
    await expect(dialog.getByText(/1 provider entries can be imported/u)).toBeVisible();
    await dialog.getByRole('button', { name: 'Import missing Pi providers and MCP servers' }).click();
    await expect(dialog.getByText(/Imported 1 provider entries and 1 MCP servers/u)).toBeVisible();
    const auth = JSON.parse(await readFile(path.join(data, 'auth.json'), 'utf8'));
    expect(Object.keys(auth).sort()).toEqual(['fate', 'pi']);
    const saved = JSON.parse(await readFile(path.join(data, 'mcp-servers.json'), 'utf8'));
    expect(saved).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Test saved server' }).click();
    await expect(dialog.getByRole('status').last()).toContainText('echo connected: 1 tools available (echo).');
    expect((await readFile(path.join(agent, 'mcp.json'), 'utf8'))).toContain('mcpServers');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
