import { ArrowUp, AtSign, ImagePlus, LoaderCircle, Square, X } from 'lucide-react';
import { type ChangeEvent, type KeyboardEvent, useMemo, useRef, useState } from 'react';
import type { PromptInput } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';

interface Attachment {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
}

const supportedImageTypes = new Set<Attachment['mimeType']>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function Composer({ onOpenProject }: { onOpenProject: () => void }) {
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<Attachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const runtime = useRuntimeStore((state) => state.runtime);
  const queue = useRuntimeStore((state) => state.queue);
  const connected = runtime.status === 'ready';
  const imageCapable = connected && runtime.model?.supportsImages === true;

  const commandQuery = draft.match(/^\/(\S*)$/)?.[1]?.toLocaleLowerCase();
  const commandSuggestions = useMemo(() => {
    if (commandQuery === undefined) return [];
    return (runtime.commands ?? []).filter((command) => command.name.toLocaleLowerCase().includes(commandQuery)).slice(0, 8);
  }, [commandQuery, runtime.commands]);

  const submit = async (behavior: PromptInput['behavior']) => {
    const text = draft.trim();
    if (!text || !connected || !('piDesktop' in window)) return;
    setSubmitting(true);
    setComposerError(null);
    try {
      const acceptance = await window.piDesktop.prompt({ text, behavior, ...(images.length ? { images } : {}) });
      if (acceptance.accepted) {
        setDraft('');
        setImages([]);
      }
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : 'Pi could not accept this message.');
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit(runtime.streaming ? 'steer' : 'prompt');
    }
  };

  const addReference = async () => {
    const input = textarea.current;
    if (!input || !('piDesktop' in window)) return;
    setComposerError(null);
    try {
      const relativePath = await window.piDesktop.selectProjectFile();
      if (!relativePath) return;
      const reference = relativePath.includes(' ') ? `@"${relativePath}"` : `@${relativePath}`;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const leadingSpace = start > 0 && !/\s/.test(draft[start - 1] ?? '') ? ' ' : '';
      const trailingSpace = end < draft.length && !/\s/.test(draft[end] ?? '') ? ' ' : '';
      const insertion = `${leadingSpace}${reference}${trailingSpace}`;
      setDraft(`${draft.slice(0, start)}${insertion}${draft.slice(end)}`);
      requestAnimationFrame(() => {
        input.focus();
        const cursor = start + insertion.length;
        input.setSelectionRange(cursor, cursor);
      });
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : 'Could not reference that project file.');
    }
  };

  const attachImages = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])].slice(0, Math.max(0, 4 - images.length));
    event.target.value = '';
    for (const file of files) {
      if (!supportedImageTypes.has(file.type as Attachment['mimeType']) || file.size > 15_000_000) {
        setComposerError(`${file.name} is not a supported image under 15 MB.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const data = result.slice(result.indexOf(',') + 1);
        setImages((current) => current.length >= 4 ? current : [...current, { name: file.name, mimeType: file.type as Attachment['mimeType'], data }]);
      };
      reader.onerror = () => setComposerError(`Could not read ${file.name}.`);
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="composer-wrap">
      {commandSuggestions.length > 0 && (
        <div className="slash-suggestions" role="listbox" aria-label="Slash commands" id="slash-suggestions">
          {commandSuggestions.map((command) => (
            <button key={command.name} type="button" role="option" onClick={() => { setDraft(`/${command.name} `); textarea.current?.focus(); }}>
              <strong>/{command.name}</strong><span>{command.description || 'Prompt template'}</span>
            </button>
          ))}
        </div>
      )}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); if (!runtime.streaming) void submit('prompt'); }}>
        {images.length > 0 && <div className="composer-attachments">{images.map((image, index) => (
          <span key={`${image.name}-${index}`}><img alt="" src={`data:${image.mimeType};base64,${image.data}`} /><em>{image.name}</em><button type="button" aria-label={`Remove ${image.name}`} onClick={() => setImages((current) => current.filter((_item, itemIndex) => itemIndex !== index))}><X size={12} /></button></span>
        ))}</div>}
        <textarea
          ref={textarea}
          aria-label="Message Pi"
          aria-controls={commandSuggestions.length ? 'slash-suggestions' : undefined}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={connected ? 'Ask Pi about your project…' : 'Open and trust a project to begin…'}
          rows={2}
          disabled={!connected}
        />
        <div className="composer-toolbar">
          <div>
            <button type="button" onClick={onOpenProject}>{runtime.project?.name ?? 'Project'}</button>
            <span className="toolbar-divider" />
            <button type="button" aria-label="Add file reference" title="Insert a project-relative file reference" disabled={!connected} onClick={() => void addReference()}><AtSign size={15} /> File</button>
            <input ref={fileInput} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={attachImages} />
            <button type="button" aria-label="Attach image" title={imageCapable ? 'Attach up to four images' : 'The active model does not support images'} disabled={!imageCapable || images.length >= 4} onClick={() => fileInput.current?.click()}><ImagePlus size={15} /> Image</button>
          </div>
          <div>
            {runtime.streaming && draft.trim() && (
              <>
                <button type="button" disabled={submitting} onClick={() => void submit('steer')}>Steer{queue.steering ? ` (${queue.steering})` : ''}</button>
                <button type="button" disabled={submitting} onClick={() => void submit('followUp')}>Follow up{queue.followUp ? ` (${queue.followUp})` : ''}</button>
              </>
            )}
            <span className="shortcut">Ctrl/⌘ ↵</span>
            {runtime.streaming ? (
              <button className="send-button stop-button" type="button" aria-label="Stop Pi" onClick={() => { if ('piDesktop' in window) void window.piDesktop.abort(); }}><Square size={14} fill="currentColor" /></button>
            ) : (
              <button className="send-button" type="submit" aria-label="Send message" disabled={!connected || !draft.trim() || submitting}>{submitting ? <LoaderCircle className="tool-spinner" size={16} /> : <ArrowUp size={18} />}</button>
            )}
          </div>
        </div>
      </form>
      {composerError && <p className="composer-error" role="alert">{composerError}</p>}
      <p className="composer-caption">{runtime.project?.trusted ? 'Trusted project · Pi tools run in the selected directory.' : 'Pi can inspect files and run tools only after you trust a project.'}</p>
    </div>
  );
}
