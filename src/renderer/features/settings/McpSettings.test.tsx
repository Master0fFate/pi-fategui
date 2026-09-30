import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { PiDesktopApi } from '../../../shared/contracts/ipc';
import { McpSettings } from './McpSettings';

afterEach(() => { Reflect.deleteProperty(window, 'piDesktop'); });

it('imports a detected Pi profile without launching MCP servers or losing the saved list', async () => {
  const report = { piProfileFound: true, sharedSettings: true, sharedSessions: true, sharedExtensions: true, bridgeConfigured: false, projectExtensionsBlocked: false, projectMcpRequiresBridge: false, providerEntriesToImport: 1, providerConflicts: 0, mcpServersToImport: 1, mcpServersSkipped: 0, missingMcpCommands: [], packageManagerMissing: false, warnings: [] };
  const imported = { name: 'docs', enabled: true, transport: 'stdio' as const, command: 'node', args: ['fixture.js'] };
  const getMcpServers = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([imported]);
  const importPiMigration = vi.fn(async () => ({ providerEntriesImported: 1, providerConflicts: 0, mcpServersImported: 1, mcpServersSkipped: 0, warnings: [] }));
  Object.defineProperty(window, 'piDesktop', { configurable: true, value: {
    getMcpServers, setMcpServers: vi.fn(), testMcpServer: vi.fn(),
    inspectPiMigration: vi.fn(async () => report), importPiMigration,
  } as unknown as PiDesktopApi });
  const user = userEvent.setup();
  render(<McpSettings />);
  await user.click(await screen.findByRole('button', { name: 'Import missing Pi providers and MCP servers' }));
  await waitFor(() => expect(importPiMigration).toHaveBeenCalledOnce());
  expect(await screen.findByText(/Imported 1 provider entries and 1 MCP servers/u)).toBeInTheDocument();
  expect(await screen.findByRole('textbox', { name: 'MCP server 1 name' })).toHaveValue('docs');
});

it('adds and saves an opt-in MCP server from the settings panel', async () => {
  const save = vi.fn(async (servers) => servers);
  const probe = vi.fn(async () => ({ tools: ['echo'] }));
  Object.defineProperty(window, 'piDesktop', { configurable: true, value: {
    getMcpServers: vi.fn(async () => []), setMcpServers: save, testMcpServer: probe,
    inspectPiMigration: vi.fn(async () => ({ piProfileFound: false, sharedSettings: false, sharedSessions: false, sharedExtensions: false, bridgeConfigured: false, projectExtensionsBlocked: false, projectMcpRequiresBridge: false, providerEntriesToImport: 0, providerConflicts: 0, mcpServersToImport: 0, mcpServersSkipped: 0, missingMcpCommands: [], packageManagerMissing: false, warnings: [] })),
    importPiMigration: vi.fn(),
  } as unknown as PiDesktopApi });
  const user = userEvent.setup();
  render(<McpSettings />);
  await screen.findByText('No servers configured.');
  await user.click(screen.getByRole('button', { name: 'Add server' }));
  await user.type(screen.getByRole('textbox', { name: 'MCP server 1 name' }), 'docs');
  await user.type(screen.getByRole('textbox', { name: 'MCP server 1 command' }), 'node');
  await user.click(screen.getByRole('checkbox', { name: 'Enable MCP server 1' }));
  await user.click(screen.getByRole('button', { name: 'Save MCP servers' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith([{
    name: 'docs', enabled: true, transport: 'stdio', command: 'node', args: [],
  }]));
  expect(await screen.findByText(/Reopen this project/u)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Test saved server' }));
  await waitFor(() => expect(probe).toHaveBeenCalledWith('docs'));
  expect(await screen.findByText(/connected: 1 tools available/u)).toBeInTheDocument();
});
