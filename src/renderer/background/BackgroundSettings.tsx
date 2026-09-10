import { useRef, useState, useSyncExternalStore } from 'react';
import { getAppliedSkin, subscribeSkinChanges } from '../skin';
import { SelectControl } from '../components/SelectControl';
import { useBackground } from './BackgroundProvider';
import { prepareBackground } from './dither';

export function BackgroundSettings() {
  const { record, ready, error: storageError, save } = useBackground();
  const skin = useSyncExternalStore(subscribeSkinChanges, getAppliedSkin, getAppliedSkin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const change = async (operation: () => Promise<void>) => {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The background could not be changed.'); }
    finally { setBusy(false); }
  };
  return (
    <section className="background-settings" aria-label="Conversation background">
      <div className="settings-title settings-title--spaced"><div><h3>Background</h3><p>Your image, converted to a still, palette-tinted dither behind the conversation.</p></div></div>
      <div className="settings-group">
        <div className="settings-theme-row"><div><strong>{record?.name ?? (skin.background ? `${skin.name} pack background` : 'No image selected')}</strong><small>PNG, JPEG, or WebP · up to 12 MB / 32 megapixels. The original image is never uploaded or retained.</small></div></div>
        <div className="background-actions">
          <button className="settings-inline-action" type="button" disabled={!ready || busy} onClick={() => picker.current?.click()}>{busy ? 'Processing...' : 'Choose image'}</button>
          <button className="settings-inline-action" type="button" disabled={!record || busy} onClick={() => void change(() => save(null))}>Remove background</button>
          <input ref={picker} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Background image file" disabled={!ready || busy} onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void change(async () => { const image = await prepareBackground(file); await save({ image, name: file.name.slice(0, 160), opacity: record?.opacity ?? 0.1 }); });
          }} />
        </div>
        {record && <div className="settings-theme-row"><div><strong>Image strength</strong><small>Keep the image quiet enough to read over.</small></div><SelectControl label="Background strength" value={String(record.opacity)} disabled={busy} options={[{ value: '0.06', label: 'Subtle · 6%' }, { value: '0.1', label: 'Balanced · 10%' }, { value: '0.16', label: 'Visible · 16%' }]} onValueChange={(value) => void change(() => save({ ...record, opacity: Number(value) }))} /></div>}
        {skin.background && <p className="background-help">This skin supplies a background. A personal image overrides it; removing the personal image restores the pack background.</p>}
        <p className="background-help">Background changes save immediately on this device, separately from the skin and color settings.</p>
        {(error ?? storageError) && <p role="alert" className="settings-error">{error ?? storageError}</p>}
      </div>
    </section>
  );
}
