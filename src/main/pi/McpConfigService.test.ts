import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpConfigService } from './McpConfigService';
import { mcpServerListSchema } from '../../shared/contracts/ipc';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('MCP config', () => {
  it('starts empty, saves a validated global config, and refuses duplicates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fate-mcp-')); roots.push(root);
    const config = new McpConfigService(root);
    expect(await config.list()).toEqual([]);
    const server = { name: 'docs', enabled: false, transport: 'http', url: 'https://example.com/mcp' } as const;
    await config.save([server]);
    expect(await config.list()).toEqual([server]);
    await expect(config.save([server, server])).rejects.toThrow();
    expect(await config.list()).toEqual([server]);
    expect(JSON.parse(await readFile(path.join(root, 'mcp-servers.json'), 'utf8'))).toEqual([server]);
  });
  it('refuses insecure remote HTTP and unexpected fields', () => {
    expect(mcpServerListSchema.safeParse([{ name: 'x', enabled: true, transport: 'http', url: 'http://example.com/mcp' }]).success).toBe(false);
    expect(mcpServerListSchema.safeParse([{ name: 'x', enabled: true, transport: 'http', url: 'https://user:secret@example.com/mcp' }]).success).toBe(false);
    expect(mcpServerListSchema.safeParse([{ name: 'x', enabled: true, transport: 'stdio', command: 'node', args: [], env: { TOKEN: 'secret' } }]).success).toBe(false);
  });
});
