import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, Check, ExternalLink, KeyRound, LoaderCircle, LogOut, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ModelsDevListResult,
  ModelsDevMutationResult,
  ModelsDevProviderDetail,
  ModelsDevProviderSummary,
  ProviderLoginState,
} from '../../shared/contracts/ipc';
import { useRuntimeStore } from '../stores/runtimeStore';
import { ipcErrorMessage } from '../lib/ipcError';
import { ProviderLogo, prefetchProviderLogos } from './ProviderLogo';

/**
 * The one provider window in Fate UI. Used by /login ("Connect a provider",
 * including the first-run flow) and by Settings → Agent → Add provider.
 *
 * A single searchable list holds every provider two ways:
 * - Sign-in providers from the Pi runtime (OAuth / API key methods, sign-out).
 * - The live models.dev catalog (~190 providers); picking one adds it with
 *   its full model list and an optional API key.
 *
 * The visual language follows the models.dev picker: logo · name · right-side
 * status, a detail page with a back button, and a foot note about live data.
 */

interface ProviderConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional settings-style toast for add/remove outcomes. */
  onNotice?: (kind: 'success' | 'error', title: string, message: string) => void;
  /** Fires after a models.dev provider was added (models refresh themselves through RuntimeState). */
  onAdded?: () => void;
}

interface SelectableProvider {
  readonly kind: 'builtin' | 'catalog';
  readonly id: string;
  readonly name: string;
  readonly methods: readonly ('oauth' | 'api_key')[];
  readonly configured: boolean;
  readonly managed: boolean;
  readonly modelCount: number | null;
}

const API_LABELS: Record<string, string> = {
  'openai-completions': 'OpenAI-compatible',
  'anthropic-messages': 'Anthropic',
  'google-generative-ai': 'Google',
  'google-vertex': 'Vertex AI',
  'bedrock-converse-stream': 'Bedrock',
  'mistral-conversations': 'Mistral',
};

export const modelsDevApiLabel = (api: string): string => API_LABELS[api] ?? api;

function methodLabel(methods: readonly ('oauth' | 'api_key')[]): string {
  const parts = methods.map((method) => (method === 'oauth' ? 'OAuth' : 'API key'));
  return parts.join(' · ');
}

export function ProviderConnectDialog({ open, onOpenChange, onNotice, onAdded }: ProviderConnectDialogProps) {
  const providerLogin = useRuntimeStore((state) => state.runtime.providerLogin);
  const managedProviders = useRuntimeStore((state) => state.runtime.modelsDevManaged) ?? [];
  const [catalog, setCatalog] = useState<ModelsDevProviderSummary[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ModelsDevProviderDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  // Sign-in flow state (ported from the former provider-login dialog).
  const [value, setValue] = useState('');
  const [started, setStarted] = useState(false);
  const [pendingStart, setPendingStart] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Auto-close may only fire after the flow went active (working /
  // awaiting-input) and settled back to idle — otherwise a stale pre-start
  // snapshot plus an already-configured provider would close instantly.
  const sawActiveLoginRef = useRef(false);

  const login: ProviderLoginState = providerLogin ?? { status: 'idle', providers: [], providerId: null, providerName: null, method: null, prompt: null, message: null, deviceCode: null };
  const loginActive = login.status === 'working' || login.status === 'awaiting-input';
  // Opening gate: logos for every provider we can already name are prefetched
  // (capped at 200ms) before the window mounts, so it appears fully formed
  // instead of visibly downloading logos. Catalog logos prefetch in the
  // background as soon as their ids arrive.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const knownIds = [...login.providers.map((provider) => provider.id), ...managedProviders.map((managed) => managed.id)];
    void prefetchProviderLogos(knownIds, 200).finally(() => { if (active) setReady(true); });
    // Fresh provider lists every open: Pi sign-in options and the live
    // models.dev catalog. Neither is cached by the renderer. The sign-in
    // refresh is skipped when a list is already present (for example the
    // /login trigger just fetched it) to avoid a redundant round-trip.
    if ((useRuntimeStore.getState().runtime.providerLogin?.providers?.length ?? 0) === 0) {
      void window.piDesktop?.initializeProviderLogin().catch(() => undefined);
    }
    loadCatalog();
    return () => {
      active = false;
      setQuery(''); setSelectedId(null); setDetail(null); setDetailError(null);
      setApiKey(''); setAdding(false); setAddError(null); setRemoving(false);
      setValue(''); setStarted(false); setPendingStart(false); setStartError(null);
      sawActiveLoginRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Warm catalog logos without gating the already-open window.
  useEffect(() => {
    if (!catalog) return;
    void prefetchProviderLogos(catalog.map((summary) => summary.id), 200);
  }, [catalog]);

  useEffect(() => {
    if (loginActive) sawActiveLoginRef.current = true;
    if (started && sawActiveLoginRef.current && login.status === 'idle' && login.providers.some((provider) => provider.configured)) {
      onOpenChange(false);
    }
  }, [login.status, login.providers, onOpenChange, started, loginActive]);

  const loadCatalog = () => {
    setCatalogLoading(true); setCatalogError(null);
    // Older bridges without the models.dev surface still serve sign-in rows.
    if (typeof window.piDesktop?.listModelsDevProviders !== 'function') {
      setCatalog(null);
      setCatalogLoading(false);
      return;
    }
    window.piDesktop.listModelsDevProviders()
      .then((result: ModelsDevListResult) => { setCatalog(result.providers); setCatalogLoading(false); })
      .catch((error: unknown) => {
        setCatalogError(ipcErrorMessage(error, 'The models.dev catalog could not load. Check your connection and try again.'));
        setCatalogLoading(false);
      });
  };

  const builtinById = useMemo(() => new Map(login.providers.map((provider) => [provider.id, provider])), [login.providers]);
  const managedIds = useMemo(() => new Set(managedProviders.map((managed) => managed.id)), [managedProviders]);

  const rows = useMemo<SelectableProvider[]>(() => {
    const merged: SelectableProvider[] = login.providers.map((provider) => ({
      kind: 'builtin' as const,
      id: provider.id,
      name: provider.name,
      methods: provider.methods,
      configured: provider.configured,
      managed: managedIds.has(provider.id),
      modelCount: null,
    }));
    for (const summary of catalog ?? []) {
      // Providers the Pi runtime already serves are reached through their
      // sign-in row; showing a second disabled catalog row is noise.
      if (builtinById.has(summary.id)) continue;
      merged.push({
        kind: 'catalog' as const,
        id: summary.id,
        name: summary.name,
        methods: summary.envVar ? ['api_key' as const] : [],
        configured: summary.status !== 'available',
        managed: summary.status === 'managed',
        modelCount: summary.modelCount,
      });
    }
    return merged.sort((left, right) => left.name.localeCompare(right.name));
  }, [login.providers, catalog, builtinById, managedIds]);

  const trimmedQuery = query.trim().toLowerCase();
  const visible = trimmedQuery
    ? rows.filter((row) => row.name.toLowerCase().includes(trimmedQuery) || row.id.toLowerCase().includes(trimmedQuery))
    : rows;
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const selectedBuiltin = selected?.kind === 'builtin' ? builtinById.get(selected.id) ?? null : null;
  const selectedManaged = managedProviders.find((managed) => managed.id === selectedId) ?? null;

  const openDetail = (row: SelectableProvider) => {
    setSelectedId(row.id);
    setDetail(null); setDetailError(null); setApiKey(''); setAddError(null);
    setValue(''); setStartError(null);
    if (row.kind === 'catalog' && typeof window.piDesktop?.getModelsDevProvider === 'function') {
      window.piDesktop.getModelsDevProvider(row.id)
        .then((result: ModelsDevProviderDetail) => setDetail(result))
        .catch((error: unknown) => setDetailError(ipcErrorMessage(error, 'This provider could not load. Try again.')));
    }
  };

  const add = () => {
    if (!selectedId || adding) return;
    setAdding(true); setAddError(null);
    const trimmedKey = apiKey.trim();
    window.piDesktop?.addModelsDevProvider(trimmedKey ? { providerId: selectedId, apiKey: trimmedKey } : { providerId: selectedId })
      .then((result: ModelsDevMutationResult) => {
        onNotice?.('success', `${result.providerName} added`, `${result.modelCount} models are now available in Fate UI.`);
        onAdded?.();
        onOpenChange(false);
      })
      .catch((error: unknown) => setAddError(ipcErrorMessage(error, 'The provider could not be added. Try again.')))
      .finally(() => setAdding(false));
  };

  const removeManaged = () => {
    if (!selectedId || removing) return;
    setRemoving(true);
    window.piDesktop?.removeModelsDevProvider(selectedId)
      .then((result: ModelsDevMutationResult) => {
        onNotice?.('success', `${result.providerName} removed`, 'The provider and its models were removed from Fate UI provider storage.');
        setSelectedId(null);
      })
      .catch((error: unknown) => setAddError(ipcErrorMessage(error, 'The provider could not be removed. Try again.')))
      .finally(() => setRemoving(false));
  };

  const start = (method: 'oauth' | 'api_key') => {
    if (!selectedBuiltin || !window.piDesktop) return;
    setStarted(true);
    setValue('');
    setStartError(null);
    setPendingStart(true);
    void window.piDesktop.startProviderLogin({ providerId: selectedBuiltin.id, method })
      .catch((error: unknown) => setStartError(ipcErrorMessage(error, 'Provider sign-in could not start. Try again.')))
      .finally(() => setPendingStart(false));
  };

  const respond = () => {
    if (!login.prompt || !window.piDesktop) return;
    const answer = value;
    setValue('');
    void window.piDesktop.respondProviderLogin({ promptId: login.prompt.id, value: answer }).catch(() => undefined);
  };

  const cancelLogin = () => {
    if (loginActive || pendingStart) void window.piDesktop?.cancelProviderLogin();
  };

  const close = () => {
    cancelLogin();
    onOpenChange(false);
  };

  const blockingPrompt = login.status === 'awaiting-input' && login.prompt && login.prompt.type !== 'manual_code' ? login.prompt : null;
  const working = pendingStart || login.status === 'working' || (login.status === 'awaiting-input' && login.prompt?.type === 'manual_code');
  const manualPrompt = login.prompt?.type === 'manual_code' ? login.prompt : null;
  const workingMessage = pendingStart && login.status === 'idle' ? 'Starting secure provider sign-in…' : login.message ?? 'Working…';

  return (
    <Dialog.Root open={open && ready} onOpenChange={(next) => { if (!next) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="provider-dialog-overlay" />
        <Dialog.Content className="provider-dialog-content" aria-describedby={undefined}>
          <div className="provider-dialog-head">
            {selected ? (
              <button type="button" className="provider-dialog-back" onClick={() => { setSelectedId(null); setDetail(null); setDetailError(null); cancelLogin(); }}>
                <ArrowLeft size={15} /><span>Back</span>
              </button>
            ) : (
              <Dialog.Title className="provider-dialog-title">Connect a provider</Dialog.Title>
            )}
            <Dialog.Close className="provider-dialog-close" aria-label="Close"><X size={15} /></Dialog.Close>
          </div>

          {!selected && (
            <>
              <div className="provider-dialog-search">
                <Search size={14} aria-hidden="true" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={catalogLoading ? 'Loading the models.dev catalog…' : `${rows.length} providers · sign-in or add · search by name or id`}
                  autoFocus
                  aria-label="Search providers"
                />
              </div>
              <div className="provider-dialog-list" role="listbox" aria-label="Providers">
                {catalogLoading && !catalog && (
                  <div className="provider-dialog-state"><LoaderCircle className="provider-dialog-spinner" size={16} aria-hidden="true" /><span>Loading the live catalog from models.dev…</span></div>
                )}
                {catalogError && (
                  <div className="provider-dialog-state provider-dialog-state--error" role="alert">
                    <span>{catalogError}</span>
                    <button type="button" className="provider-dialog-retry" onClick={loadCatalog}><RefreshCw size={13} /> Retry</button>
                  </div>
                )}
                {visible.map((row) => (
                  <button
                    key={`${row.kind}:${row.id}`}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="provider-dialog-row"
                    data-kind={row.kind}
                    data-configured={row.configured || undefined}
                    onClick={() => openDetail(row)}
                  >
                    <ProviderLogo providerId={row.id} size={16} />
                    <span className="provider-dialog-row-name">{row.name}</span>
                    <span className="provider-dialog-row-meta">
                      {row.configured ? 'Connected' : row.kind === 'builtin' ? methodLabel(row.methods) : `${row.modelCount} models`}
                    </span>
                  </button>
                ))}
                {trimmedQuery && visible.length === 0 && !catalogError && (
                  <div className="provider-dialog-state"><span>No provider matches “{query.trim()}”.</span></div>
                )}
              </div>
              <p className="provider-dialog-foot">Sign-in providers come from the embedded Pi runtime · provider data from <a href="https://models.dev" target="_blank" rel="noreferrer">models.dev</a> loads live and nothing is cached.</p>
            </>
          )}

          {selected && selected.kind === 'builtin' && (
            <div className="provider-dialog-detail">
              <div className="provider-dialog-detail-head">
                <ProviderLogo providerId={selected.id} size={22} />
                <div>
                  <strong>{selected.name}</strong>
                  <small>{selected.id} · {methodLabel(selected.methods) || 'Sign-in'}</small>
                </div>
              </div>
              {login.status === 'error' && <p className="provider-dialog-error" role="alert">{login.message}</p>}
              {startError && <p className="provider-dialog-error" role="alert">{startError}</p>}
              {blockingPrompt ? (
                <form className="provider-dialog-prompt" onSubmit={(event) => { event.preventDefault(); respond(); }}>
                  <p className="provider-dialog-prompt-message">{blockingPrompt.message}</p>
                  {blockingPrompt.type === 'select' ? (
                    <label className="provider-dialog-key provider-dialog-key--form">
                      <span>Choose an option</span>
                      <select value={value} autoFocus onChange={(event) => setValue(event.target.value)}>
                        <option value="" disabled>Select…</option>
                        {blockingPrompt.options?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                      </select>
                    </label>
                  ) : (
                    <label className="provider-dialog-key provider-dialog-key--form">
                      <span>{blockingPrompt.type === 'secret' ? 'Credential' : 'Response'}</span>
                      <input autoFocus type={blockingPrompt.type === 'secret' ? 'password' : 'text'} value={value} maxLength={20_000} placeholder={blockingPrompt.placeholder} autoComplete="off" onChange={(event) => setValue(event.target.value)} />
                    </label>
                  )}
                  <div className="provider-dialog-actions">
                    <span className="provider-dialog-assurance"><ShieldCheck size={13} aria-hidden="true" /> Credentials stay in Fate UI’s local provider store.</span>
                    <button className="provider-dialog-add" type="submit" disabled={!value}>Continue</button>
                  </div>
                </form>
              ) : working ? (
                <div className="provider-dialog-working">
                  <LoaderCircle className="provider-dialog-spinner" size={17} aria-hidden="true" />
                  <div>
                    <strong>{login.providerName ?? selected.name} sign-in</strong>
                    <p>{workingMessage}</p>
                    {login.deviceCode && <code>{login.deviceCode.userCode}</code>}
                  </div>
                  <button type="button" className="provider-dialog-retry" onClick={close}>Cancel</button>
                </div>
              ) : (
                <div className="provider-dialog-methods">
                  {selected.methods.map((method) => (
                    <button key={method} type="button" className="provider-dialog-method" onClick={() => start(method)}>
                      {method === 'oauth' ? <ExternalLink size={15} /> : <KeyRound size={15} />}
                      <span>
                        <strong>{method === 'oauth' ? 'Sign in in browser' : 'Use an API key'}</strong>
                        <small>{method === 'oauth' ? 'Continue with the provider’s secure sign-in page' : 'Send a one-time credential to Fate UI’s local provider store'}</small>
                      </span>
                    </button>
                  ))}
                  {selected.configured && (
                    <button type="button" className="provider-dialog-signout" onClick={() => void window.piDesktop?.logoutProvider(selected.id).catch(() => undefined)}>
                      <LogOut size={14} /> Sign out of {selected.name}
                    </button>
                  )}
                  {selectedManaged && (
                    <button type="button" className="provider-dialog-signout provider-dialog-signout--danger" disabled={removing} onClick={removeManaged}>
                      {removing ? <LoaderCircle className="provider-dialog-spinner" size={14} /> : <X size={14} />} Remove from Fate UI
                    </button>
                  )}
                </div>
              )}
              {manualPrompt && (
                <details className="provider-dialog-manual">
                  <summary>Browser sign-in did not finish automatically</summary>
                  <form onSubmit={(event) => { event.preventDefault(); respond(); }}>
                    <p>{manualPrompt.message}</p>
                    <label className="provider-dialog-key provider-dialog-key--form">
                      <span>Authorization code or redirect URL</span>
                      <input type="text" value={value} maxLength={20_000} placeholder={manualPrompt.placeholder} autoComplete="off" onChange={(event) => setValue(event.target.value)} />
                    </label>
                    <div className="provider-dialog-actions">
                      <button className="provider-dialog-add" type="submit" disabled={!value}>Submit code</button>
                    </div>
                  </form>
                </details>
              )}
            </div>
          )}

          {selected && selected.kind === 'catalog' && (
            <div className="provider-dialog-detail">
              <div className="provider-dialog-detail-head">
                <ProviderLogo providerId={selected.id} size={22} />
                <div>
                  <strong>{detail?.name ?? selected.name}</strong>
                  <small>{selected.id} · {detail ? modelsDevApiLabel(detail.api) : '…'}</small>
                </div>
              </div>
              {!detail && !detailError && <div className="provider-dialog-state"><LoaderCircle className="provider-dialog-spinner" size={16} aria-hidden="true" /><span>Loading provider details…</span></div>}
              {detailError && (
                <div className="provider-dialog-state provider-dialog-state--error" role="alert">
                  <span>{detailError}</span>
                  <button type="button" className="provider-dialog-retry" onClick={() => openDetail(selected)}><RefreshCw size={13} /> Retry</button>
                </div>
              )}
              {detail && (
                <>
                  <dl className="provider-dialog-facts">
                    <div><dt>Endpoint</dt><dd><code>{detail.baseUrl}</code></dd></div>
                    <div><dt>API key</dt><dd>{detail.envVar ? <code>{detail.envVar}</code> : 'Not published'}</dd></div>
                    {detail.docUrl && <div><dt>Docs</dt><dd><a href={detail.docUrl} target="_blank" rel="noreferrer">Provider page <ExternalLink size={11} /></a></dd></div>}
                  </dl>
                  <div className="provider-dialog-models" aria-label="Models">
                    {detail.models.slice(0, 8).map((model) => (
                      <div className="provider-dialog-model" key={model.id}>
                        <span className="provider-dialog-model-name">{model.name}</span>
                        <span className="provider-dialog-model-meta">
                          {model.reasoning ? 'reasoning' : 'standard'}
                          {model.imageInput ? ' · images' : ''}
                          {model.toolCall ? ' · tools' : ''}
                          {` · ${Math.round(model.contextWindow / 1000)}k`}
                          {model.costInput > 0 || model.costOutput > 0 ? ` · $${model.costInput}/$${model.costOutput} per M` : ''}
                        </span>
                      </div>
                    ))}
                    {detail.models.length > 8 && <div className="provider-dialog-model provider-dialog-model--more">+ {detail.models.length - 8} more models</div>}
                  </div>
                  {selectedManaged ? (
                    <>
                      {addError && <p className="provider-dialog-error" role="alert">{addError}</p>}
                      <div className="provider-dialog-actions">
                        <span className="provider-dialog-assurance"><ShieldCheck size={13} aria-hidden="true" /> Added to Fate UI provider storage. Sign in through its row, or remove it here.</span>
                        <button type="button" className="provider-dialog-signout provider-dialog-signout--danger" disabled={removing} onClick={removeManaged}>
                          {removing ? <LoaderCircle className="provider-dialog-spinner" size={14} /> : <X size={14} />} Remove from Fate UI
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <label className="provider-dialog-key">
                        <KeyRound size={14} aria-hidden="true" />
                        <span>API key <em>optional now · or set <code>{detail.envVar ?? 'the provider env var'}</code> before starting Fate UI</em></span>
                        <input
                          type="password"
                          value={apiKey}
                          onChange={(event) => setApiKey(event.target.value)}
                          placeholder={detail.envVar ? `${detail.envVar} value` : 'Provider API key'}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </label>
                      {addError && <p className="provider-dialog-error" role="alert">{addError}</p>}
                      <div className="provider-dialog-actions">
                        <span className="provider-dialog-assurance"><ShieldCheck size={13} aria-hidden="true" /> The key goes to Fate UI’s local credential store only.</span>
                        <button type="button" className="provider-dialog-add" onClick={add} disabled={adding || detail.models.length === 0}>
                          {adding ? <><LoaderCircle className="provider-dialog-spinner" size={14} /> Adding…</> : <><Check size={14} /> Add {detail.models.length} models</>}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
