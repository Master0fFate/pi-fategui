import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerDefinition } from '../../shared/contracts/ipc';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 24_000;
const MAX_TOOLS = 100;

/** Each invocation owns its connection. This prevents orphaned server processes on session switches. */
export class McpService {
  constructor(private readonly servers: readonly McpServerDefinition[], private readonly fullAccess: () => boolean) {}

  private server(name: string): McpServerDefinition {
    const server = this.servers.find((item) => item.name === name && item.enabled);
    if (!server) throw new Error(`MCP server ${name} is not enabled. Check Settings > MCP.`);
    return server;
  }

  private async withClient<T>(name: string, signal: AbortSignal | undefined, run: (client: Client) => Promise<T>): Promise<T> {
    if (!this.fullAccess()) throw new Error('MCP tools require Full access. MCP servers run outside Fate UI’s file and command gates.');
    const server = this.server(name);
    const client = new Client({ name: 'fate-ui', version: '1.0.0' });
    const transport = server.transport === 'stdio'
      ? new StdioClientTransport({ command: server.command, args: server.args, stderr: 'ignore' })
      : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { redirect: 'error' } });
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      await client.connect(transport as Transport, { signal: abort });
      if (!this.fullAccess()) throw new Error('MCP access changed while connecting.');
      return await run(client);
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }

  private async catalog(client: Client, signal?: AbortSignal): Promise<Awaited<ReturnType<Client['listTools']>>['tools']> {
    const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { ...(signal ? { signal } : {}), timeout: REQUEST_TIMEOUT_MS });
      tools.push(...result.tools);
      if (tools.length > 1_000) throw new Error('MCP tool catalog exceeds the 1,000-tool limit.');
      if (!result.nextCursor) return tools;
      if (seen.has(result.nextCursor)) throw new Error('MCP server repeated a tool catalog cursor.');
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error('MCP server tool catalog has too many pages.');
  }

  async probe(name: string, signal?: AbortSignal): Promise<string[]> {
    return this.withClient(name, signal, async (client) => (await this.catalog(client, signal)).slice(0, MAX_TOOLS).map((tool) => tool.name.slice(0, 200)));
  }

  async list(name: string, signal?: AbortSignal): Promise<string> {
    return this.withClient(name, signal, async (client) => {
      const tools = await this.catalog(client, signal);
      const text = JSON.stringify(tools.slice(0, MAX_TOOLS).map((tool) => ({ name: tool.name, description: tool.description?.slice(0, 400), inputSchema: tool.inputSchema })));
      return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[Tool catalog truncated]` : text;
    });
  }

  async call(name: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    return this.withClient(name, signal, async (client) => {
      // Never execute an invented tool name. The server's current catalog is authoritative.
      const catalog = await this.catalog(client, signal);
      if (!catalog.some((entry) => entry.name === tool)) throw new Error(`MCP server ${name} does not advertise ${tool}.`);
      if (!this.fullAccess()) throw new Error('MCP access changed before the call.');
      const result = await client.callTool({ name: tool, arguments: args }, undefined, { ...(signal ? { signal } : {}), timeout: REQUEST_TIMEOUT_MS });
      const text = JSON.stringify(result);
      return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[Result truncated]` : text;
    });
  }
}

export function createMcpTool(servers: readonly McpServerDefinition[], fullAccess: () => boolean): ToolDefinition {
  const service = new McpService(servers, fullAccess);
  return defineTool({
    name: 'fate_mcp',
    label: 'Fate MCP',
    promptSnippet: 'List and call user-enabled MCP server tools (Full access only)',
    description: `Use an enabled MCP server. First list tools, then call a named tool. Requires Full access. Servers: ${servers.filter((server) => server.enabled).map((server) => server.name).join(', ')}`,
    parameters: Type.Object({
      action: StringEnum(['list', 'call'] as const),
      server: Type.String(),
      tool: Type.Optional(Type.String()),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_id, params, signal) {
      const text = params.action === 'list'
        ? await service.list(params.server, signal)
        : params.tool ? await service.call(params.server, params.tool, params.args ?? {}, signal)
          : (() => { throw new Error('A tool name is required for an MCP call.'); })();
      return { content: [{ type: 'text', text }], details: {} };
    },
  });
}
