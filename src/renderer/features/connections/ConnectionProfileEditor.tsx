import { useState } from 'react';
import { saveSshProfileSchema } from '../../../shared/contracts/connectionEditor';
import type { DesktopConnectionApi } from '../../../shared/contracts/connections';

type ProfileEditorApi = Pick<DesktopConnectionApi, 'pickConnectionCredential' | 'saveSshConnectionProfile'>;
export function ConnectionProfileEditor({ api, onSaved }: { api: ProfileEditorApi; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState(''), [alias, setAlias] = useState(''), [hostId, setHostId] = useState('');
  const [workspaceId, setWorkspaceId] = useState(''), [generation, setGeneration] = useState('1'), [remotePort, setRemotePort] = useState('47119');
  const [selectionId, setSelectionId] = useState<string | null>(null), [trust, setTrust] = useState(false);
  if (!api.pickConnectionCredential || !api.saveSshConnectionProfile) return null;
  const act = async (action: () => Promise<void>) => { setBusy(true); setError(null); try { await action(); }
    catch { setError('Profile was not saved. Check the host identity, workspace and private client credential.'); }
    finally { setBusy(false); } };
  return <section aria-label="SSH connection profile">
    <button type="button" onClick={() => { setOpen(!open); setSelectionId(null); setTrust(false); }} disabled={busy}>{open ? 'Cancel profile' : 'Add SSH host'}</button>
    {open && <form onSubmit={(event) => { event.preventDefault(); void act(async () => {
      const input = saveSshProfileSchema.parse({ label, hostId, sshAlias: alias, remotePort: Number(remotePort), workspaceId,
        workspaceGeneration: Number(generation), selectionId, trust });
      await api.saveSshConnectionProfile!(input); await onSaved(); setOpen(false); setSelectionId(null); setTrust(false);
    }); }}>
      <label>Host label<input value={label} onChange={(event) => setLabel(event.target.value)} disabled={busy} /></label>
      <label>SSH config alias<input value={alias} onChange={(event) => setAlias(event.target.value)} disabled={busy} /></label>
      <label>Remote loopback port<input inputMode="numeric" value={remotePort} onChange={(event) => setRemotePort(event.target.value)} disabled={busy} /></label>
      <label>Verified server ID<input value={hostId} onChange={(event) => { setHostId(event.target.value); setTrust(false); }} disabled={busy} /></label>
      <label>Host workspace ID<input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} disabled={busy} /></label>
      <label>Workspace generation<input inputMode="numeric" value={generation} onChange={(event) => setGeneration(event.target.value)} disabled={busy} /></label>
      <button type="button" disabled={busy} onClick={() => void act(async () => { const choice = await api.pickConnectionCredential!(); setSelectionId(choice?.selectionId ?? null); })}>Choose private client credential</button>
      <span>{selectionId ? 'Private file selected' : 'No private file selected'}</span>
      <label><input type="checkbox" checked={trust} onChange={(event) => setTrust(event.target.checked)} disabled={busy} />I verified this server ID on the execution host.</label>
      <p>Verify the SSH host key with your SSH tools first. The server must already be installed and running.</p>
      <button type="submit" disabled={busy || !selectionId || !trust}>Save host profile</button>
      {error && <p role="alert">{error}</p>}
    </form>}
  </section>;
}
