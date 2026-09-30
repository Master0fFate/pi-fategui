import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { mcpServerSchema, type McpServerDefinition } from '../../shared/contracts/ipc';
import { fateDataRoot } from './FateProviderStorage';
import { McpConfigService } from './McpConfigService';

const MAX_CONFIG_BYTES = 256_000;
const MAX_PROVIDER_BYTES = 4 * 1024 * 1024;
const SOURCES = ['auth.json', 'models.json'] as const;
type JsonObject = Record<string, unknown>;

async function commandAvailable(command: string): Promise<boolean> {
  const suffixes = process.platform === 'win32' && !/\.(?:exe|cmd|bat)$/iu.test(command) ? ['', '.exe', '.cmd', '.bat'] : [''];
  const roots = path.isAbsolute(command) || /[\\/]/u.test(command) ? [''] : (process.env.PATH ?? '').split(path.delimiter);
  for (const root of roots) for (const suffix of suffixes) {
    try {
      const stat = await fs.stat(root ? path.join(root.replace(/^"|"$/gu, ''), command + suffix) : command + suffix);
      if (stat.isFile()) return true;
    } catch { /* Try the next PATH entry. */ }
  }
  return false;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readObject(file: string, maxBytes: number): Promise<JsonObject | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error(`Unsafe or oversized migration file: ${file}`);
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!isObject(parsed)) throw new Error(`Invalid migration file: ${file}`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writePrivateObject(file: string, object: JsonObject): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(temp, `${JSON.stringify(object, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
    if (process.platform !== 'win32') await fs.chmod(file, 0o600);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Keep Fate's values. A provider configuration can contain credentials and custom model definitions. */
function mergeMissing(file: typeof SOURCES[number], source: JsonObject, current: JsonObject): { merged: JsonObject; added: number; conflicts: number } {
  const merged = { ...current };
  let added = 0;
  let conflicts = 0;
  if (file === 'auth.json') {
    for (const [provider, credential] of Object.entries(source)) {
      if (Object.hasOwn(current, provider)) {
        if (JSON.stringify(current[provider]) !== JSON.stringify(credential)) conflicts++;
      } else { Object.defineProperty(merged, provider, { value: credential, enumerable: true, writable: true, configurable: true }); added++; }
    }
  } else {
    const sourceProviders = isObject(source.providers) ? source.providers : {};
    const currentProviders = isObject(current.providers) ? current.providers : {};
    const providers = { ...currentProviders };
    for (const [provider, config] of Object.entries(sourceProviders)) {
      if (Object.hasOwn(currentProviders, provider)) {
        if (JSON.stringify(currentProviders[provider]) !== JSON.stringify(config)) conflicts++;
      } else { Object.defineProperty(providers, provider, { value: config, enumerable: true, writable: true, configurable: true }); added++; }
    }
    if (Object.keys(sourceProviders).length > 0) merged.providers = providers;
    for (const [key, value] of Object.entries(source)) {
      if (key === 'providers') continue;
      if (Object.hasOwn(current, key)) {
        if (JSON.stringify(current[key]) !== JSON.stringify(value)) conflicts++;
      } else { Object.defineProperty(merged, key, { value, enumerable: true, writable: true, configurable: true }); added++; }
    }
  }
  return { merged, added, conflicts };
}

export interface PiMigrationReport {
  piProfileFound: boolean;
  sharedSettings: boolean;
  sharedSessions: boolean;
  sharedExtensions: boolean;
  bridgeConfigured: boolean;
  projectExtensionsBlocked: boolean;
  projectMcpRequiresBridge: boolean;
  providerEntriesToImport: number;
  providerConflicts: number;
  mcpServersToImport: number;
  mcpServersSkipped: number;
  missingMcpCommands: string[];
  packageManagerMissing: boolean;
  warnings: string[];
}

export interface PiMigrationResult {
  providerEntriesImported: number;
  mcpServersImported: number;
  providerConflicts: number;
  mcpServersSkipped: number;
  warnings: string[];
}

/** This is a local, explicit import. It never installs software, contacts a server, or edits Pi's files. */
export class PiMigrationService {
  private readonly mcp: McpConfigService;
  private importQueue: Promise<void> = Promise.resolve();
  private readonly home: string;
  constructor(private readonly piDir = getAgentDir(), private readonly fateDir = fateDataRoot(), home = os.homedir()) {
    this.home = home;
    this.mcp = new McpConfigService(fateDir);
  }

  private mcpPaths(): string[] {
    return [
      path.join(this.home, '.config', 'mcp', 'mcp.json'),
      path.join(this.home, '.agents', 'mcp.json'),
      path.join(this.home, '.agents', 'mcp', 'mcp.json'),
      path.join(this.piDir, 'mcp.json'),
    ];
  }

  private async legacyMcp(existing: readonly McpServerDefinition[]): Promise<{ servers: McpServerDefinition[]; skipped: number; warnings: string[] }> {
    const found = new Map<string, McpServerDefinition>();
    const warnings: string[] = [];
    let skipped = 0;
    const existingNames = new Set(existing.map((server) => server.name));
    for (const file of this.mcpPaths()) {
      let config: JsonObject | null;
      try { config = await readObject(file, MAX_CONFIG_BYTES); }
      catch { warnings.push(`Could not read a Pi MCP configuration at ${file}.`); continue; }
      if (!config) continue;
      if (!isObject(config.mcpServers)) {
        warnings.push(`Pi MCP configuration has no supported mcpServers object: ${file}.`);
        continue;
      }
      for (const [name, entry] of Object.entries(config.mcpServers)) {
        if (existingNames.has(name)) continue;
        if (found.has(name)) { skipped++; warnings.push(`Multiple Pi MCP definitions exist for ${name}; resolve the conflict before import.`); found.delete(name); existingNames.add(name); continue; }
        if (!isObject(entry)) { skipped++; continue; }
        // The built-in client cannot preserve auth, env, custom headers, SSE, or adapter-only policy.
        // Keep these on the original global bridge rather than silently losing security settings.
        const supportedKeys = new Set(['command', 'args', 'url', 'disabled', 'protocolVersion']);
        if (Object.keys(entry).some((key) => !supportedKeys.has(key)) || (entry.protocolVersion && entry.protocolVersion !== 'legacy')) { skipped++; warnings.push(`${name} needs its Pi MCP bridge or manual setup; Fate cannot preserve all its options.`); continue; }
        const candidate = typeof entry.command === 'string' && !entry.url
          ? { name, enabled: entry.disabled !== true, transport: 'stdio', command: entry.command, args: entry.args ?? [] }
          : typeof entry.url === 'string' && !entry.command
            ? { name, enabled: entry.disabled !== true, transport: 'http', url: entry.url }
            : null;
        const parsed = mcpServerSchema.safeParse(candidate);
        if (!parsed.success) { skipped++; warnings.push(`${name} needs its Pi MCP bridge or manual setup; Fate cannot import this server.`); continue; }
        found.set(name, parsed.data);
      }
    }
    return { servers: [...found.values()].slice(0, Math.max(0, 32 - existing.length)), skipped: skipped + Math.max(0, found.size - (32 - existing.length)), warnings };
  }

  async inspect(projectPath?: string): Promise<PiMigrationReport> {
    const warnings: string[] = [];
    const source = await Promise.all(SOURCES.map(async (file) => {
      try { return await readObject(path.join(this.piDir, file), MAX_PROVIDER_BYTES); }
      catch { warnings.push(`Could not read Pi ${file}; check the file format and permissions.`); return null; }
    }));
    const current = await Promise.all(SOURCES.map(async (file) => {
      try { return await readObject(path.join(this.fateDir, file), MAX_PROVIDER_BYTES) ?? {}; }
      catch { warnings.push(`Could not read Fate ${file}; import is blocked until it is repaired.`); return {}; }
    }));
    const auth = source[0] ? mergeMissing('auth.json', source[0], current[0]!) : { added: 0, conflicts: 0 };
    const models = source[1] ? mergeMissing('models.json', source[1], current[1]!) : { added: 0, conflicts: 0 };
    let settings: JsonObject | null = null;
    try { settings = await readObject(path.join(this.piDir, 'settings.json'), MAX_CONFIG_BYTES); }
    catch { warnings.push('Could not inspect shared Pi settings.'); }
    const packages = Array.isArray(settings?.packages) ? settings.packages : [];
    const bridgeConfigured = packages.some((item: unknown) => {
      const sourceName = typeof item === 'string' ? item : isObject(item) ? item.source : null;
      return typeof sourceName === 'string' && /(?:^|[/:])pi-mcp-adapter(?:@|$)/u.test(sourceName);
    });
    const exists = async (file: string): Promise<boolean> => {
      try { await fs.lstat(file); return true; } catch { return false; }
    };
    let existing: McpServerDefinition[] = [];
    try { existing = await this.mcp.list(); }
    catch { warnings.push('Fate MCP config cannot be read; import is blocked until it is repaired.'); }
    const mcp = await this.legacyMcp(existing);
    warnings.push(...mcp.warnings);
    const missingMcpCommands: string[] = [];
    for (const server of mcp.servers) {
      if (server.transport === 'stdio' && !await commandAvailable(server.command)) missingMcpCommands.push(server.name);
    }
    if (missingMcpCommands.length) warnings.push(`Local MCP commands are not available for: ${missingMcpCommands.join(', ')}. Install their runtimes before using them.`);
    const npmCommand = Array.isArray(settings?.npmCommand) && typeof settings.npmCommand[0] === 'string' ? settings.npmCommand[0] : 'npm';
    const packageManagerMissing = packages.length > 0 && !await commandAvailable(npmCommand);
    if (packageManagerMissing) warnings.push('The configured Pi package manager is not on Fate UI’s PATH. Existing packages may load, but missing packages and updates will fail.');
    if (bridgeConfigured && mcp.servers.length) warnings.push('A Pi MCP bridge is configured. Test its servers before removing Pi CLI; Fate will not add duplicates.');
    let projectExtensionsBlocked = false;
    let projectMcpRequiresBridge = false;
    if (projectPath) {
      try { projectExtensionsBlocked = (await fs.readdir(path.join(projectPath, '.pi', 'extensions'))).length > 0; } catch { /* No project extensions. */ }
      try {
        const projectSettings = await readObject(path.join(projectPath, '.pi', 'settings.json'), MAX_CONFIG_BYTES);
        projectExtensionsBlocked ||= Array.isArray(projectSettings?.extensions) && projectSettings.extensions.length > 0;
        if (Array.isArray(projectSettings?.packages) && projectSettings.packages.length > 0) warnings.push('Project Pi packages may include executable extensions; Fate does not load project-local extensions.');
      } catch { warnings.push('Project Pi settings could not be inspected.'); }
      projectMcpRequiresBridge = await exists(path.join(projectPath, '.mcp.json')) || await exists(path.join(projectPath, '.pi', 'mcp.json'));
    }
    if (projectExtensionsBlocked) warnings.push('Project-local Pi extensions are blocked in Fate, even for trusted projects.');
    if (projectMcpRequiresBridge && !bridgeConfigured) warnings.push('Project MCP config requires a trusted global Pi MCP bridge; Fate does not import project servers into its global list.');
    return {
      piProfileFound: source.some(Boolean) || Boolean(settings) || await exists(path.join(this.piDir, 'sessions'))
        || await exists(path.join(this.piDir, 'extensions')) || await exists(path.join(this.piDir, 'skills'))
        || await exists(path.join(this.piDir, 'mcp.json')),
      sharedSettings: Boolean(settings),
      sharedSessions: await exists(path.join(this.piDir, 'sessions')),
      sharedExtensions: await exists(path.join(this.piDir, 'extensions')) || packages.length > 0,
      bridgeConfigured,
      projectExtensionsBlocked,
      projectMcpRequiresBridge,
      providerEntriesToImport: auth.added + models.added,
      providerConflicts: auth.conflicts + models.conflicts,
      mcpServersToImport: mcp.servers.length,
      mcpServersSkipped: mcp.skipped,
      missingMcpCommands,
      packageManagerMissing,
      warnings,
    };
  }

  importMissing(): Promise<PiMigrationResult> {
    const work = this.importQueue.then(() => this.importOnce());
    this.importQueue = work.then(() => undefined, () => undefined);
    return work;
  }

  private async importOnce(): Promise<PiMigrationResult> {
    const warnings: string[] = [];
    // Validate all inputs before making the first change. A corrupt later file
    // must not turn an ordinary import into a predictable partial migration.
    const providerChanges = await Promise.all(SOURCES.map(async (file) => {
      const source = await readObject(path.join(this.piDir, file), MAX_PROVIDER_BYTES);
      if (!source) return null;
      const target = path.join(this.fateDir, file);
      const current = await readObject(target, MAX_PROVIDER_BYTES) ?? {};
      return { target, ...mergeMissing(file, source, current) };
    }));
    const settings = await readObject(path.join(this.piDir, 'settings.json'), MAX_CONFIG_BYTES);
    const packages = Array.isArray(settings?.packages) ? settings.packages : [];
    const bridge = packages.some((item: unknown) => {
      const sourceName = typeof item === 'string' ? item : isObject(item) ? item.source : null;
      return typeof sourceName === 'string' && /(?:^|[/:])pi-mcp-adapter(?:@|$)/u.test(sourceName);
    });
    const existing = bridge ? [] : await this.mcp.list();
    const discovered = bridge ? null : await this.legacyMcp(existing);
    let providerEntriesImported = 0;
    let providerConflicts = 0;
    for (const change of providerChanges) {
      if (!change) continue;
      if (change.added) await writePrivateObject(change.target, change.merged);
      providerEntriesImported += change.added;
      providerConflicts += change.conflicts;
    }
    let mcpServersImported = 0;
    let mcpServersSkipped = 0;
    if (bridge) {
      warnings.push('Existing Pi MCP bridge kept. Fate did not add duplicate MCP servers.');
    } else if (discovered) {
      mcpServersSkipped = discovered.skipped;
      warnings.push(...discovered.warnings);
      if (discovered.servers.length) {
        await this.mcp.save([...existing, ...discovered.servers]);
        mcpServersImported = discovered.servers.length;
      }
    }
    if (providerConflicts) warnings.push('Some provider values differ. Fate kept its existing values; review them before uninstalling Pi.');
    return { providerEntriesImported, providerConflicts, mcpServersImported, mcpServersSkipped, warnings };
  }
}
