import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpService } from './McpService';
import type { McpServerDefinition } from '../../shared/contracts/ipc';

const fixture = fileURLToPath(new URL('../../../tests/fixtures/mcp-echo.mjs', import.meta.url));
const server: McpServerDefinition = { name: 'echo', enabled: true, transport: 'stdio', command: process.execPath, args: [fixture] };

describe('MCP bridge', () => {
  it('blocks low-permission calls before starting a subprocess', async () => {
    const service = new McpService([server], () => false);
    await expect(service.list('echo')).rejects.toThrow(/Full access/u);
  });

  it('connects to a real local Streamable HTTP server', async () => {
    const app = createMcpExpressApp();
    app.post('/mcp', async (request: IncomingMessage & { body?: unknown }, response: ServerResponse) => {
      const instance = new McpServer({ name: 'http-fixture', version: '1.0.0' });
      instance.registerTool('ping', { description: 'respond' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
      const transport = new StreamableHTTPServerTransport({});
      await instance.connect(transport as Transport);
      await transport.handleRequest(request, response, request.body);
      response.on('close', () => { void transport.close(); void instance.close(); });
    });
    app.get('/mcp', (_request: IncomingMessage, response: ServerResponse) => { response.writeHead(405).end(); });
    const listener: Server = app.listen(0, '127.0.0.1');
    try {
      await once(listener, 'listening');
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('No loopback port.');
      const service = new McpService([{ name: 'local', enabled: true, transport: 'http', url: `http://127.0.0.1:${address.port}/mcp` }], () => true);
      expect(await service.probe('local')).toEqual(['ping']);
      expect(await service.call('local', 'ping', {})).toContain('pong');
    } finally { await new Promise<void>((resolve) => listener.close(() => resolve())); }
  }, 20_000);

  it('rejects a permission downgrade while the connection is starting', async () => {
    let checks = 0;
    const service = new McpService([server], () => ++checks === 1);
    await expect(service.probe('echo')).rejects.toThrow(/access changed/u);
  }, 20_000);

  it('connects to a real stdio server, lists its tools, calls it and closes the process', async () => {
    const service = new McpService([server], () => true);
    expect(await service.probe('echo')).toEqual(['echo']);
    expect(JSON.parse(await service.list('echo'))).toEqual([expect.objectContaining({ name: 'echo' })]);
    expect(await service.call('echo', 'echo', { text: 'hello' })).toContain('hello');
    await expect(service.call('echo', 'invented', {})).rejects.toThrow(/does not advertise/u);
  }, 20_000);
});
