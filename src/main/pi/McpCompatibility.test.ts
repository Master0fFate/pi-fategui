import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentSessionFromServices, createAgentSessionServices, DefaultPackageManager, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { activeToolsForPermission, selectUserExtensionPaths } from './PiRuntimeService';
import { createMcpTool } from './McpService';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('Pi MCP extension compatibility', () => {
  it('loads a global Pi extension with its own mcp tool alongside Fate MCP without loading a project extension', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fate-pi-mcp-')); roots.push(root);
    const agentDir = path.join(root, 'agent');
    const project = path.join(root, 'project');
    await mkdir(agentDir); await mkdir(path.join(project, '.pi', 'extensions'), { recursive: true });
    const packageRoot = path.join(agentDir, 'bridge-package');
    await mkdir(packageRoot);
    const globalExtension = path.join(packageRoot, 'bridge.js');
    const projectExtension = path.join(project, '.pi', 'extensions', 'bridge.js');
    const extension = `export default function(pi) { pi.registerTool({ name: 'mcp', label: 'Existing Pi MCP bridge', description: 'Existing global Pi MCP tool', parameters: { type: 'object', properties: {} }, async execute() { return { content: [{ type: 'text', text: 'legacy bridge works' }] }; } }); }`;
    await writeFile(globalExtension, extension);
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'test-pi-mcp-bridge', version: '1.0.0', pi: { extensions: ['./bridge.js'] } }));
    await writeFile(projectExtension, extension.replaceAll("name: 'mcp'", "name: 'project_mcp'"));
    const settings = SettingsManager.inMemory({ packages: [packageRoot] });
    const resources = await new DefaultPackageManager({ cwd: project, agentDir, settingsManager: settings }).resolve();
    const extensions = selectUserExtensionPaths(resources.extensions);
    expect(extensions).toContain(globalExtension);
    expect(extensions).not.toContain(projectExtension);
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: null, modelsStorePath: path.join(root, 'models.json'), allowModelNetwork: false });
    const services = await createAgentSessionServices({
      cwd: project, modelRuntime, settingsManager: settings,
      resourceLoaderOptions: { noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true, additionalExtensionPaths: extensions },
    });
    const fateTool = createMcpTool([{ name: 'docs', enabled: true, transport: 'http', url: 'https://example.com/mcp' }], () => true);
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(project), customTools: [fateTool] });
    try {
      expect(session.getToolDefinition('mcp')?.name).toBe('mcp');
      expect(session.getToolDefinition('fate_mcp')).toBe(fateTool);
      expect(session.getToolDefinition('project_mcp')).toBeUndefined();
      // Fate's old policy leaves user-installed Pi extension tools available.
      expect(activeToolsForPermission(['mcp', 'fate_mcp'], 'read-only')).toEqual(expect.arrayContaining(['mcp', 'fate_mcp']));
    } finally { session.dispose(); }
  });
});
