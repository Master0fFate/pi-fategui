import { useEffect, useRef, useState } from 'react';
import type { NetworkWorkspaceApi } from '../../../client/NetworkWorkspaceApi';
import type { WebWorkspace } from '../../../client/WebFateApi';
import type { HistoryPage } from '../../../shared/protocol/snapshots';

/** A bounded saved-history reader. It never merges archived rows into the live
 * transcript or changes the host's selected session. Each page replaces the last. */
export function NetworkHistory({ api, workspace, sessionId }: {
  api: Pick<NetworkWorkspaceApi, 'readHistory' | 'supports'>; workspace: WebWorkspace; sessionId: string;
}) {
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [number, setNumber] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const revision = useRef(0);
  const inFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => { revision.current++; }, []);
  const read = async (pageId?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = ++revision.current;
    setBusy(true); setError(false);
    try {
      const result = await api.readHistory(workspace, pageId);
      if (request !== revision.current) return;
      if (result.sessionId !== sessionId) throw new Error('Session changed');
      setPage(result); setNumber((value) => pageId ? value + 1 : 1);
      heading.current?.focus();
    } catch {
      if (request === revision.current) { setPage(null); setError(true); }
    } finally {
      if (request === revision.current) { inFlight.current = false; setBusy(false); }
    }
  };
  if (!api.supports('session.history')) return null;
  return <section aria-label="Saved session history" className="connection-inline-review">
    <h3 ref={heading} tabIndex={-1}>Saved history{page ? ` · Page ${number}` : ''}</h3>
    <div className="connection-actions">
      <button type="button" disabled={busy} onClick={() => void read()}>Read from start</button>
      {page?.nextPageId && <button type="button" disabled={busy} onClick={() => void read(page.nextPageId!)}>Next history page</button>}
      {page && <button type="button" disabled={busy} onClick={() => { setPage(null); setNumber(0); }}>Close history</button>}
    </div>
    {busy && <p role="status">Reading saved history…</p>}
    {error && <p role="alert">History changed or could not be read. Refresh the workspace, then read from start.</p>}
    {page && <>
      <p>Saved text only. This does not change the live conversation.</p>
      {(page.mediaOmitted || page.oversizedItems > 0) && <p role="status">Some media or large items are omitted.</p>}
      <div style={{ maxHeight: '50vh', overflow: 'auto', overflowWrap: 'anywhere' }} tabIndex={0} aria-label="History page text">
        {page.items.map((item, index) => <article key={`${item.kind}:${item.id}:${index}`}>
          <strong>{item.role ?? item.name ?? item.kind}</strong>
          <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit' }}>{item.text}</pre>
          {(item.clipped || item.mediaOmitted) && <small>Partial item · some content omitted</small>}
        </article>)}
        {page.items.length === 0 && <p>No saved items on this page.</p>}
      </div>
      {!page.nextPageId && <p>End of saved history.</p>}
    </>}
  </section>;
}
