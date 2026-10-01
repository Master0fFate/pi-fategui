import * as Dialog from '@radix-ui/react-dialog';
import { Check, FolderClosed, KeyRound, LoaderCircle, Plus, Server, ShieldCheck, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { saveSshProfileSchema } from '../../../shared/contracts/connectionEditor';
import type { DesktopConnectionApi } from '../../../shared/contracts/connections';
import { useSkinComponents } from '../../skins/SkinProvider';

type ProfileEditorApi = Pick<DesktopConnectionApi, 'pickConnectionCredential' | 'saveSshConnectionProfile'>;
type Pending = 'pick' | 'save' | 'refresh' | null;
export function ConnectionProfileEditor({ api, onSaved }: { api: ProfileEditorApi; onSaved: () => Promise<void> }) {
  const { ActionContent } = useSkinComponents();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), firstField = useRef<HTMLInputElement>(null), pendingRef = useRef(false);
  const [open, setOpen] = useState(false), [pending, setPending] = useState<Pending>(null), [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState(''), [alias, setAlias] = useState(''), [hostId, setHostId] = useState('');
  const [workspaceId, setWorkspaceId] = useState(''), [generation, setGeneration] = useState('1'), [remotePort, setRemotePort] = useState('47119');
  const [selectionId, setSelectionId] = useState<string | null>(null), [trust, setTrust] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [saved, setSaved] = useState(false);
  const savedRef = useRef(false);
  const busy = pending !== null, locked = busy || saved;
  const refreshError = 'Host profile was saved, but the host list could not be refreshed. Retry refresh; do not save it again.';
  const number = (value: string) => value.trim() ? Number(value) : Number.NaN;
  const input = { label, hostId, sshAlias: alias, remotePort: number(remotePort), workspaceId,
    workspaceGeneration: number(generation), selectionId, trust };
  const parsed = saveSshProfileSchema.safeParse(input);
  const ready = parsed.success && label.trim().length > 0;
  const invalid = new Set(parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0])));
  if (!label.trim()) invalid.add('label');
  const showInvalid = (field: string) => touched.has(field) && invalid.has(field);
  const markTouched = (field: string) => setTouched((previous) => new Set([...previous, field]));
  if (!api.pickConnectionCredential || !api.saveSshConnectionProfile) return null;
  const close = () => {
    if (pendingRef.current) return;
    setOpen(false); setSelectionId(null); setTrust(false); setError(null); setTouched(new Set()); setSaved(false); savedRef.current = false;
  };
  const refreshSaved = async () => {
    await onSaved();
    setOpen(false); setSelectionId(null); setTrust(false); setTouched(new Set()); setSaved(false); savedRef.current = false;
  };
  const act = async (operation: Exclude<Pending, null>, action: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(operation); setError(null);
    try { await action(); }
    catch { setError(operation === 'pick'
      ? 'The private client credential could not be selected. Choose a private Fate client file issued by the execution host.'
      : savedRef.current ? refreshError : 'Profile was not saved. Choose the private client file again, then check the host identity and workspace.'); }
    finally { pendingRef.current = false; setPending(null); }
  };
  return <Dialog.Root open={open} onOpenChange={(next) => {
    if (!next) close();
    else if (!pendingRef.current) { setOpen(true); setSelectionId(null); setTrust(false); setError(null); setTouched(new Set()); }
  }}>
    <Dialog.Trigger asChild>
      <button ref={trigger} className="desktop-host-action" type="button" disabled={busy} aria-label="Add SSH host">
        <Plus size={13} aria-hidden="true" /><ActionContent text="add ssh host">Add SSH host</ActionContent>
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay ssh-profile-overlay" />
      <Dialog.Content className="agent-workspace-dialog ssh-profile-dialog" aria-busy={busy}
        onOpenAutoFocus={(event) => { event.preventDefault(); firstField.current?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}
        onEscapeKeyDown={(event) => { if (pendingRef.current) event.preventDefault(); }}
        onInteractOutside={(event) => { if (pendingRef.current) event.preventDefault(); }}>
        <header className="agent-workspace-dialog-header ssh-profile-header">
          <span className="ssh-profile-mark"><Server size={20} aria-hidden="true" /></span>
          <div><Dialog.Title>Add SSH host</Dialog.Title>
            <Dialog.Description>Connect to an existing Fate server through your SSH configuration.</Dialog.Description></div>
          <button type="button" aria-label="Cancel profile" disabled={busy} onClick={close}><ActionContent text="x"><X size={16} /></ActionContent></button>
        </header>
        <form className="ssh-profile-form" noValidate onSubmit={(event) => {
          event.preventDefault();
          if (!parsed.success || !ready || pendingRef.current || savedRef.current) return;
          void act('save', async () => {
            // Native main consumes a submitted opaque choice even if its
            // subsequent checks fail. Keep the draft, never replay that choice.
            setSelectionId(null);
            await api.saveSshConnectionProfile!(parsed.data);
            // Main has consumed this choice. A failed list refresh must never
            // imply save failure or allow replay of the successful write.
            savedRef.current = true; setSaved(true); setSelectionId(null); setTrust(false);
            await refreshSaved();
          });
        }}>
          <div className="ssh-profile-cards">
            <section className="ssh-profile-card" aria-labelledby={`${id}-endpoint`}>
              <header className="ssh-profile-card-heading"><span><Server size={15} aria-hidden="true" /></span>
                <div><small>01 · ENDPOINT</small><h3 id={`${id}-endpoint`}>SSH connection</h3></div></header>
              <label className="ssh-profile-field">Host label
                <input ref={firstField} aria-label="Host label" value={label} maxLength={128} placeholder="Build workstation" disabled={locked}
                  aria-invalid={showInvalid('label')} aria-describedby={showInvalid('label') ? `${id}-label-error` : undefined}
                  onBlur={() => markTouched('label')} onChange={(event) => setLabel(event.target.value)} />
                {showInvalid('label') && <small id={`${id}-label-error`} className="ssh-profile-field-error">Use a host name, not a path or credential value.</small>}
              </label>
              <div className="ssh-profile-endpoint-fields">
                <label className="ssh-profile-field">SSH config alias
                  <input aria-label="SSH config alias" value={alias} maxLength={128} placeholder="my-build-host" disabled={locked} spellCheck={false}
                    aria-invalid={showInvalid('sshAlias')} aria-describedby={`${id}-alias-help`}
                    onBlur={() => markTouched('sshAlias')} onChange={(event) => setAlias(event.target.value)} />
                  <small id={`${id}-alias-help`} className={showInvalid('sshAlias') ? 'ssh-profile-field-error' : ''}>{showInvalid('sshAlias') ? 'Use an SSH alias, not a command or URL.' : 'An existing alias in your SSH config.'}</small>
                </label>
                <label className="ssh-profile-field">Remote loopback port
                  <input aria-label="Remote loopback port" inputMode="numeric" value={remotePort} disabled={locked} aria-invalid={showInvalid('remotePort')}
                    aria-describedby={showInvalid('remotePort') ? `${id}-port-error` : undefined}
                    onBlur={() => markTouched('remotePort')} onChange={(event) => setRemotePort(event.target.value)} />
                  {showInvalid('remotePort') && <small id={`${id}-port-error`} className="ssh-profile-field-error">Use a port from 1–65535.</small>}
                </label>
              </div>
              <p className="ssh-profile-note">Verify the SSH host key with your SSH tools first. The server must already be installed and running.</p>
            </section>
            <section className="ssh-profile-card" aria-labelledby={`${id}-identity`}>
              <header className="ssh-profile-card-heading"><span><ShieldCheck size={15} aria-hidden="true" /></span>
                <div><small>02 · IDENTITY & WORKSPACE</small><h3 id={`${id}-identity`}>Pin the execution host</h3></div></header>
              <label className="ssh-profile-field">Verified server ID
                <input aria-label="Verified server ID" className="ssh-profile-id" value={hostId} placeholder="Server UUID from the execution host" disabled={locked} spellCheck={false}
                  aria-invalid={showInvalid('hostId')} aria-describedby={`${id}-host-help`}
                  onBlur={() => markTouched('hostId')} onChange={(event) => { setHostId(event.target.value); setTrust(false); }} />
                <small id={`${id}-host-help`} className={showInvalid('hostId') ? 'ssh-profile-field-error' : ''}>{showInvalid('hostId') ? 'Enter the verified server UUID.' : 'Compare with the server identity on the host.'}</small>
              </label>
              <label className="ssh-profile-field">Host workspace ID
                <input aria-label="Host workspace ID" className="ssh-profile-id" value={workspaceId} placeholder="Registered workspace UUID" disabled={locked} spellCheck={false}
                  aria-invalid={showInvalid('workspaceId')} aria-describedby={showInvalid('workspaceId') ? `${id}-workspace-error` : undefined}
                  onBlur={() => markTouched('workspaceId')} onChange={(event) => setWorkspaceId(event.target.value)} />
                {showInvalid('workspaceId') && <small id={`${id}-workspace-error`} className="ssh-profile-field-error">Enter the registered workspace UUID.</small>}
              </label>
              <label className="ssh-profile-field ssh-profile-generation">Workspace generation
                <input aria-label="Workspace generation" inputMode="numeric" value={generation} disabled={locked} aria-invalid={showInvalid('workspaceGeneration')}
                  aria-describedby={`${id}-generation-help`} onBlur={() => markTouched('workspaceGeneration')} onChange={(event) => setGeneration(event.target.value)} />
                <small id={`${id}-generation-help`} className={showInvalid('workspaceGeneration') ? 'ssh-profile-field-error' : ''}>{showInvalid('workspaceGeneration') ? 'Use a non-negative whole number.' : 'Use the generation reported by the host.'}</small>
              </label>
            </section>
            <section className="ssh-profile-card ssh-profile-card--wide" aria-labelledby={`${id}-access`}>
              <header className="ssh-profile-card-heading"><span><KeyRound size={15} aria-hidden="true" /></span>
                <div><small>03 · PRIVATE FATE CLIENT ACCESS</small><h3 id={`${id}-access`}>Choose the client credential</h3></div>
                <span className={`ssh-profile-badge${saved || selectionId ? ' ssh-profile-badge--ready' : ''}`} role="status">{saved ? <><Check size={12} aria-hidden="true" />Client access saved</> : selectionId ? <><Check size={12} aria-hidden="true" />Private file selected</> : 'No private file selected'}</span>
              </header>
              <div className="ssh-profile-access">
                <p>This is a <strong>Fate client credential</strong>, not your SSH private key or the server owner credential. Its contents and path stay in native main, never in this form.</p>
                <button className="ssh-profile-secondary" type="button" aria-label="Choose private client credential" disabled={locked} aria-busy={pending === 'pick'}
                  onClick={() => void act('pick', async () => { const choice = await api.pickConnectionCredential!(); setSelectionId(choice?.selectionId ?? null); })}>
                  {pending === 'pick' ? <LoaderCircle className="tool-spinner" size={14} aria-hidden="true" /> : <FolderClosed size={14} aria-hidden="true" />}
                  <ActionContent text="choose client file">{pending === 'pick' ? 'Choosing private file…' : 'Choose private client credential'}</ActionContent>
                </button>
              </div>
            </section>
            <section className="ssh-profile-card ssh-profile-card--wide ssh-profile-review" aria-labelledby={`${id}-review`}>
              <header className="ssh-profile-card-heading"><span><ShieldCheck size={15} aria-hidden="true" /></span>
                <div><small>04 · REVIEW & SAVE</small><h3 id={`${id}-review`}>Confirm the trusted destination</h3></div></header>
              <dl className="ssh-profile-facts"><dt>Profile</dt><dd>{label.trim() || 'Name this host above'}</dd>
                <dt>SSH route</dt><dd><code>{alias || 'SSH config alias'} → 127.0.0.1:{remotePort || 'port'}</code></dd></dl>
              <label className="ssh-profile-trust"><input type="checkbox" checked={trust} disabled={locked} onChange={(event) => setTrust(event.target.checked)} />
                <span>I verified this server ID on the execution host.<small>Changing the server ID clears this confirmation.</small></span></label>
              <p className="ssh-profile-note">Saving adds a profile only. No deployment, connection, local fallback or agent work is started.</p>
            </section>
          </div>
          <footer className="ssh-profile-footer">
            <div className="ssh-profile-feedback" aria-live="polite">{error ? <p className="ssh-profile-error" role="alert">{error}</p>
              : <p>{pending === 'pick' ? 'Waiting for the native private-file picker…' : saved ? 'Refreshing the saved host list…' : pending === 'save' ? 'Saving the host profile…' : !ready ? 'Complete the host details, choose a client file and confirm the server ID.' : 'Ready to save. You can connect from the host selector afterward.'}</p>}</div>
            <div className="agent-workspace-actions"><button type="button" disabled={busy} onClick={close}><ActionContent text={saved ? 'close' : 'cancel'}>{saved ? 'Close' : 'Cancel'}</ActionContent></button>
              {saved ? <button className="agent-workspace-primary" type="button" aria-label="Retry refresh" aria-busy={busy} disabled={busy}
                onClick={() => { if (savedRef.current) void act('refresh', refreshSaved); }}>
                {busy && <LoaderCircle className="tool-spinner" size={14} aria-hidden="true" />}<ActionContent text={busy ? 'refreshing...' : 'retry refresh'}>{busy ? 'Refreshing…' : 'Retry refresh'}</ActionContent>
              </button> : <button className="agent-workspace-primary" type="submit" aria-label="Save host profile" aria-busy={pending === 'save'} disabled={busy || !ready}>
                {pending === 'save' && <LoaderCircle className="tool-spinner" size={14} aria-hidden="true" />}<ActionContent text={pending === 'save' ? 'saving...' : 'save host'}>{pending === 'save' ? 'Saving…' : 'Save host profile'}</ActionContent>
              </button>}</div>
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
