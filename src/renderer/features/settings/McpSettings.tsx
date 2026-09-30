import { getDesktopApi } from '../../platform/api';
import { useEffect, useState } from 'react';
import type { McpServerDefinition, PiMigrationReport } from '../../../shared/contracts/ipc';
import { ipcErrorMessage } from '../../lib/ipcError';

type Draft = { name: string; enabled: boolean; transport: 'stdio' | 'http'; command: string; args: string; url: string };
const draftFor = (server: McpServerDefinition): Draft => ({
  name: server.name, enabled: server.enabled, transport: server.transport,
  command: server.transport === 'stdio' ? server.command : '',
  args: server.transport === 'stdio' ? JSON.stringify(server.args) : '[]',
  url: server.transport === 'http' ? server.url : '',
});

export function McpSettings() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [message, setMessage] = useState('Loading MCP servers…');
  const [saving, setSaving] = useState(false);
  const [savedNames, setSavedNames] = useState<string[]>([]);
  const [migration, setMigration] = useState<PiMigrationReport | null>(null);
  const [migrationMessage, setMigrationMessage] = useState('');
  const [migrating, setMigrating] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    let active = true;
    void getDesktopApi().getMcpServers().then((servers) => {
      if (!active) return;
      setDrafts(servers.map(draftFor));
      setSavedNames(servers.filter((server) => server.enabled).map((server) => server.name));
      setMessage(servers.length ? '' : 'No servers configured.');
    }).catch((error: unknown) => { if (active) setMessage(ipcErrorMessage(error, 'MCP settings could not be loaded.')); });
    void getDesktopApi().inspectPiMigration().then((report) => { if (active) setMigration(report); })
      .catch((error: unknown) => { if (active) setMigrationMessage(ipcErrorMessage(error, 'Pi migration could not be inspected.')); });
    return () => { active = false; };
  }, []);
  const update = (index: number, patch: Partial<Draft>) => { setDirty(true); setDrafts((current) => current.map((item, position) => position === index ? { ...item, ...patch } : item)); };
  const save = async () => {
    setSaving(true);
    try {
      const servers: McpServerDefinition[] = drafts.map((draft) => {
        if (draft.transport === 'http') return { name: draft.name.trim(), enabled: draft.enabled, transport: 'http', url: draft.url.trim() };
        const args: unknown = JSON.parse(draft.args);
        if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error('Arguments must be a JSON array of strings.');
        return { name: draft.name.trim(), enabled: draft.enabled, transport: 'stdio', command: draft.command.trim(), args };
      });
      const saved = await getDesktopApi().setMcpServers(servers);
      setDrafts(saved.map(draftFor));
      setSavedNames(saved.filter((server) => server.enabled).map((server) => server.name));
      setDirty(false);
      setMessage('Saved. Reopen this project to load the new server list.');
    } catch (error) {
      setMessage(ipcErrorMessage(error, 'MCP settings could not be saved.'));
    } finally { setSaving(false); }
  };
  const probe = async (name: string) => {
    setMessage(`Connecting to ${name}…`);
    try {
      const result = await getDesktopApi().testMcpServer(name);
      setMessage(`${name} connected: ${result.tools.length} tools available${result.tools.length ? ` (${result.tools.slice(0, 5).join(', ')})` : ''}.`);
    } catch (error) { setMessage(ipcErrorMessage(error, `${name} could not connect.`)); }
  };
  const importPi = async () => {
    if (dirty || migrating) return;
    setMigrating(true);
    try {
      const result = await getDesktopApi().importPiMigration();
      setMigrationMessage(`Imported ${result.providerEntriesImported} provider entries and ${result.mcpServersImported} MCP servers. Restart Fate UI to reload providers; reopen the project to load MCP tools.${result.providerConflicts || result.mcpServersSkipped ? ` ${result.providerConflicts} provider conflicts and ${result.mcpServersSkipped} MCP servers still need review.` : ''}`);
      const [report, servers] = await Promise.all([getDesktopApi().inspectPiMigration(), getDesktopApi().getMcpServers()]);
      setMigration(report);
      setDrafts(servers.map(draftFor));
      setSavedNames(servers.filter((server) => server.enabled).map((server) => server.name));
    } catch (error) { setMigrationMessage(`${ipcErrorMessage(error, 'Pi migration stopped.')} Reopen this panel to check for any partial changes before retrying.`); }
    finally { setMigrating(false); }
  };
  return (
    <div className="settings-panel" role="tabpanel" id="settings-panel-mcp" aria-labelledby="settings-tab-mcp">
      <div className="settings-title"><div><h3>MCP servers</h3><p>Connect tools to this device. Only Full access sessions can use them.</p></div></div>
      <div className="settings-group">
        <h4>Switch from Pi Terminal</h4>
        {migration && <>
          <p>{migration.piProfileFound ? 'Pi profile found. Settings, sessions, skills, and global extensions use the same Pi directory; no copy is needed.' : 'No Pi profile found.'} {migration.bridgeConfigured ? 'A Pi MCP bridge is configured. Fate will not make duplicate servers; test the bridge before removing Pi CLI.' : `${migration.mcpServersToImport} compatible global Pi MCP servers can be imported.`} {migration.providerEntriesToImport} provider entries can be imported without replacing Fate values.</p>
          {migration.providerConflicts > 0 && <p>{migration.providerConflicts} provider values differ; Fate keeps its existing values.</p>}
          {migration.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
          <button type="button" className="settings-inline-action" disabled={migrating || dirty || (!migration.providerEntriesToImport && (!migration.mcpServersToImport || migration.bridgeConfigured))} onClick={() => void importPi()}>Import missing Pi providers and MCP servers</button>
          {dirty && <p>Save or discard your MCP edits before import.</p>}
        </>}
        {migrationMessage && <p role="status">{migrationMessage}</p>}
        <p>Local servers run commands with your user account. Remote servers receive tool inputs. Only add servers you trust. Do not put secrets in URLs or arguments. Global Pi MCP bridge extensions still use their own settings; no copy is needed. Project files cannot add servers to Fate's bridge. A separate Pi extension may use project config. OAuth is not supported yet.</p>
        {drafts.map((draft, index) => (
          <div className="settings-group" key={index}>
            <label className="settings-input-row"><span>Server name</span><input aria-label={`MCP server ${index + 1} name`} value={draft.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="docs" /></label>
            <label className="settings-input-row"><span>Enabled</span><input aria-label={`Enable MCP server ${index + 1}`} type="checkbox" checked={draft.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} /></label>
            <label className="settings-input-row"><span>Connection</span><select aria-label={`MCP server ${index + 1} connection`} value={draft.transport} onChange={(event) => update(index, { transport: event.target.value as Draft['transport'] })}><option value="stdio">Local command</option><option value="http">HTTPS endpoint</option></select></label>
            {draft.transport === 'stdio' ? <>
              <label className="settings-input-row"><span>Command</span><input aria-label={`MCP server ${index + 1} command`} value={draft.command} onChange={(event) => update(index, { command: event.target.value })} placeholder="npx" /></label>
              <label className="settings-input-row"><span>Arguments (JSON array)</span><input aria-label={`MCP server ${index + 1} arguments`} value={draft.args} onChange={(event) => update(index, { args: event.target.value })} placeholder={'["-y", "server-package@1.0.0"]'} /></label>
            </> : <label className="settings-input-row"><span>URL</span><input aria-label={`MCP server ${index + 1} URL`} value={draft.url} onChange={(event) => update(index, { url: event.target.value })} placeholder="https://example.com/mcp" /></label>}
            {draft.enabled && savedNames.includes(draft.name) && <button type="button" className="settings-inline-action" onClick={() => void probe(draft.name)}>Test saved server</button>}
            <button type="button" className="settings-inline-action" onClick={() => { setDirty(true); setDrafts((items) => items.filter((_, position) => position !== index)); }}>Remove server</button>
          </div>
        ))}
        <button type="button" className="settings-inline-action" onClick={() => { setDirty(true); setDrafts((items) => [...items, { name: '', enabled: false, transport: 'stdio', command: '', args: '[]', url: '' }]); }}>Add server</button>
        <button type="button" className="settings-inline-action" disabled={saving} onClick={() => void save()}>Save MCP servers</button>
        {message && <p role="status">{message}</p>}
      </div>
    </div>
  );
}
