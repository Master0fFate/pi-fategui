import { SelectControl } from '../../components/SelectControl';
import { useExecutionHost } from '../../platform/executionHost';
import { useUiStore } from '../../stores/uiStore';
import { ConnectionFeedback } from './ConnectionFeedback';
import { ConnectionProfileEditor } from './ConnectionProfileEditor';

/** Settings → Hosts. Every host choice and connection action is here; none is in the window chrome. */
export function HostSettings() {
  const host = useExecutionHost();
  const compact = useUiStore((state) => state.compactMode);
  const openSettingsSection = useUiStore((state) => state.openSettingsSection);
  const panel = { className: 'settings-panel', role: 'tabpanel', id: 'settings-panel-hosts', 'aria-labelledby': 'settings-tab-hosts' } as const;
  if (!host) {
    return <div {...panel}><div className="settings-title"><div><h3>Execution host</h3><p>This client cannot select another execution host.</p></div></div></div>;
  }
  const { state, profiles, busy, error } = host;
  const listed = state?.kind === 'local' ? 'local' : profiles.find((profile) => profile.id === state?.profile?.id)?.id ?? '';
  return (
    <div {...panel}>
      <div className="settings-title"><div><h3>Execution host</h3><p>The computer that runs Pi and holds the project. The default is this computer.</p></div></div>
      {error && <p className="settings-host-error" role="alert">{error}</p>}
      <div className="settings-group">
        <div className="settings-select-row">
          <div><strong>Active host</strong><small>{state?.kind === 'remote' ? <ConnectionFeedback state={state} />
            : state ? 'Execution stays on this computer.' : 'No local execution until a host is selected.'}</small></div>
          {profiles.length > 0 || state?.kind !== 'local'
            ? <SelectControl compact={compact} label="Execution host" className="settings-host-select" disabled={busy} value={listed}
              placeholder={`${state?.profile?.label ?? 'Selection unconfirmed'} — unavailable`}
              options={[{ value: 'local', label: 'This computer', detail: 'Local execution' },
                ...profiles.map((profile) => ({ value: profile.id, label: profile.label, detail: 'Remote execution' }))]}
              // A change of host reloads the workbench. Ask Settings to open on this page again.
              onValueChange={(id) => { if (id && id !== listed) { openSettingsSection('hosts'); host.select(id); } }} />
            : <span className="settings-host-value">This computer</span>}
        </div>
        {state?.kind === 'remote' && <div className="settings-select-row">
          <div><strong>Connection</strong><small>Remote files are not local files. Work on the host can continue after a disconnect.</small></div>
          <div className="settings-host-actions">
            <button type="button" className="settings-inline-action" disabled={busy} onClick={host.connect}>Connect selected host</button>
            <button type="button" className="settings-inline-action" disabled={busy} onClick={host.disconnect}>Disconnect selected host</button>
          </div>
        </div>}
      </div>
      <div className="settings-title settings-title--spaced"><div><h3>Saved SSH hosts</h3><p>A Fate server that already runs on another machine, reached through your SSH configuration. A saved host does not connect or start work by itself.</p></div></div>
      <div className="settings-group">
        {profiles.map((profile) => <div className="settings-select-row" key={profile.id}>
          <div><strong>{profile.label}</strong><small className="settings-host-id">{profile.hostId}</small></div>
          {state?.kind === 'remote' && state.profile?.id === profile.id && <span className="settings-host-value" data-active="true">Active</span>}
        </div>)}
        <div className="settings-select-row">
          <div><strong>{profiles.length > 0 ? 'Add another host' : 'No saved hosts'}</strong><small>You need the SSH alias, the server ID and the client credential file from the host.</small></div>
          <ConnectionProfileEditor api={host.api} onSaved={host.reloadProfiles} triggerClassName="settings-inline-action settings-host-add" />
        </div>
      </div>
    </div>
  );
}
