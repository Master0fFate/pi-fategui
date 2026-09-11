import { useState } from 'react';
import type { AppSettings } from '../../../shared/contracts/ipc';
import { builtInSkinName, type SkinCatalog } from '../../../shared/skins';
import { InlineConfirm } from '../../components/InlineConfirm';

export interface RemovedSkin { id: string; settings: AppSettings }
interface Props {
  catalog: SkinCatalog;
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onCatalog: (catalog: SkinCatalog, removed?: RemovedSkin) => Promise<void>;
}

export function SkinPackSettings({ catalog, selectedId, disabled, onSelect, onCatalog }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const available = typeof window.piDesktop?.importSkinPack === 'function';
  const perform = async (operation: () => Promise<void>) => {
    if (busy || disabled) return;
    setBusy(true); setError(null); setNotice(null);
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The skin pack operation failed.'); }
    finally { setBusy(false); }
  };
  const packs = catalog.skins.filter((skin) => skin.origin === 'pack');
  return <section aria-label="Installed skin packs">
    <div className="skin-pack-actions">
      <button className="settings-inline-action" type="button" disabled={!available || disabled || busy} onClick={() => void perform(async () => {
        const result = await window.piDesktop.importSkinPack();
        if (!result) return;
        await onCatalog(result.catalog);
        setNotice('Skin imported. Select it above or preview it below, then Save changes to keep it.');
      })}>Import skin folder</button>
      <button className="settings-inline-action" type="button" disabled={!available || disabled || busy} onClick={() => void perform(async () => { await window.piDesktop.openSkinsFolder(); })}>Open skins folder</button>
      <button className="settings-inline-action" type="button" disabled={!available || disabled || busy} onClick={() => void perform(async () => { await onCatalog(await window.piDesktop.getSkins()); })}>Refresh packs</button>
    </div>
    {catalog.storagePath && <code className="skin-pack-storage">{catalog.storagePath}</code>}
    <p className="skin-pack-help">Packs use existing components and approved styles. Version 2 adds local fonts, embedded PNGs, and per-surface density styles. No scripts, CSS, or remote assets. Import and removal take effect on disk immediately.</p>
    {packs.map((skin) => <div className="skin-pack-row" key={skin.id}>
      <strong>{skin.name}</strong><small>{skin.version} · {builtInSkinName(skin.base)}</small>
      <p>{skin.description}</p>
      <div className="skin-pack-actions">
        <button className="settings-inline-action" type="button" disabled={disabled || busy || selectedId === skin.id} onClick={() => onSelect(skin.id)}>Preview {skin.name}</button>
        <button className="settings-inline-action" type="button" disabled={disabled || busy} onClick={() => void perform(async () => {
          const result = await window.piDesktop.exportSkinPack(skin.id);
          if (result) setNotice(`Exported to ${result.path}`);
        })}>Export {skin.name}</button>
        <button className="settings-inline-action" type="button" disabled={disabled || busy} onClick={() => setRemoveId(skin.id)}>Remove {skin.name}</button>
      </div>
      {removeId === skin.id && <InlineConfirm title={`Remove ${skin.name}?`} message="Deletes this installed pack folder. Active users of this pack return to Default; its palette returns to the default palette if selected." confirmLabel="Remove skin pack" busy={busy} onCancel={() => setRemoveId(null)} onConfirm={() => void perform(async () => {
        const result = await window.piDesktop.removeSkinPack(skin.id);
        await onCatalog(result.catalog, { id: skin.id, settings: result.settings });
        setRemoveId(null); setNotice('Skin pack removed.');
      })} />}
    </div>)}
    {catalog.diagnostics.map((diagnostic) => <p className="skin-pack-warning" key={diagnostic}>{diagnostic}</p>)}
    {notice && <p className="skin-pack-help">{notice}</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </section>;
}
