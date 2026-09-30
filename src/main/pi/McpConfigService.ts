import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mcpServerListSchema, type McpServerDefinition } from '../../shared/contracts/ipc';

export class McpConfigService {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly root = process.env.FATE_GUI_DATA_DIR
    ? path.resolve(process.env.FATE_GUI_DATA_DIR)
    : path.join(os.homedir(), '.pi', 'fateGUI')) {}

  private file(): string { return path.join(this.root, 'mcp-servers.json'); }

  async list(): Promise<McpServerDefinition[]> {
    await this.queue;
    try {
      const stat = await fs.lstat(this.file());
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) throw new Error('MCP config is not a valid regular file.');
      return mcpServerListSchema.parse(JSON.parse(await fs.readFile(this.file(), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async save(input: readonly McpServerDefinition[]): Promise<McpServerDefinition[]> {
    const servers = mcpServerListSchema.parse(input);
    if (new Set(servers.map((server) => server.name)).size !== servers.length) throw new Error('MCP server names must be unique.');
    const work = this.queue.then(async () => {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const temp = `${this.file()}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, `${JSON.stringify(servers, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await fs.rename(temp, this.file());
      } finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
      }
    });
    this.queue = work.catch(() => undefined);
    await work;
    return servers;
  }
}
