import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('MCP settings save an opt-in global server and persist across restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fate-mcp-e2e-'));
  const launch = () => electron.launch({
    args: [`--user-data-dir=${path.join(root, 'chromium')}`, path.resolve('.'), '--new-instance'],
    env: { ...process.env, VITE_DEV_SERVER_URL: '', FATE_GUI_DATA_DIR: path.join(root, 'data'), PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_OFFLINE: '1' },
  });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    let page = await app.firstWindow();
    await expect(page.locator('[data-bridge-status="ready"]')).toBeVisible();
    await page.keyboard.press('Control+K');
    await page.getByLabel('Search commands').fill('settings');
    await page.getByLabel('Search commands').press('Enter');
    let dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: /MCP/ }).click();
    await expect(dialog.getByText('No servers configured.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Add server' }).click();
    await dialog.getByRole('textbox', { name: 'MCP server 1 name' }).fill('docs');
    const command = process.execPath;
    const fixture = path.resolve('tests/fixtures/mcp-echo.mjs');
    await dialog.getByRole('textbox', { name: 'MCP server 1 command' }).fill(command);
    await dialog.getByRole('textbox', { name: 'MCP server 1 arguments' }).fill(JSON.stringify([fixture]));
    await dialog.getByRole('checkbox', { name: 'Enable MCP server 1' }).check();
    await dialog.getByRole('button', { name: 'Save MCP servers' }).click();
    await expect(dialog.getByRole('status')).toContainText('Saved. Reopen this project');
    await dialog.getByRole('button', { name: 'Test saved server' }).click();
    await expect(dialog.getByRole('status')).toContainText('docs connected: 1 tools available (echo).');
    const config = JSON.parse(await readFile(path.join(root, 'data', 'mcp-servers.json'), 'utf8'));
    expect(config).toEqual([{ name: 'docs', enabled: true, transport: 'stdio', command, args: [fixture] }]);
    await app.close(); app = await launch();
    page = await app.firstWindow();
    await expect(page.locator('[data-bridge-status="ready"]')).toBeVisible();
    await page.keyboard.press('Control+K');
    await page.getByLabel('Search commands').fill('settings');
    await page.getByLabel('Search commands').press('Enter');
    dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: /MCP/ }).click();
    await expect(dialog.getByRole('textbox', { name: 'MCP server 1 command' })).toHaveValue(command);
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
});
