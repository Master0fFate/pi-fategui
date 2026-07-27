import * as Dialog from '@radix-ui/react-dialog';
import { Check, Download, Expand, Image as ImageIcon, ImageOff, X } from 'lucide-react';
import { Children, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RuntimeImage } from '../../../shared/contracts/ipc';
import { AppTooltip } from '../../components/AppTooltip';

let mermaidQueue: Promise<void> = Promise.resolve();
let pendingMermaidRenders = 0;
const MAX_MERMAID_SOURCE_LENGTH = 20_000;
const MAX_MERMAID_OUTPUT_LENGTH = 2_000_000;
const MAX_PENDING_MERMAID_RENDERS = 16;
const MAX_INLINE_IMAGE_URL_LENGTH = 20_000_000;
const MERMAID_RENDER_DEBOUNCE_MS = 140;
const unsafeMermaidResourcePattern = /(?:https?|ftp|file|data|blob):|(?:^|[\s("'=\[])\/\/|url\s*\(|\\[\da-f]{1,6}\s?|(?:^|[\s{,])(?:img|image)\s*:/iu;
const unsafeMermaidMarkupPattern = /%%\{|<|&(?:#\d+|#x[\da-f]+|colon|sol);?/iu;

function decodeNumericEntities(source: string): string {
  return source.replace(/&#(?:x([\da-f]+)|(\d+));?/giu, (_match, hex: string | undefined, decimal: string | undefined) => {
    const value = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10);
    return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
  });
}

export function isSafeMermaidSource(source: string): boolean {
  return source.length <= MAX_MERMAID_SOURCE_LENGTH
    && source.split('\n', 1_002).length <= 1_000
    && !unsafeMermaidMarkupPattern.test(source)
    && !unsafeMermaidResourcePattern.test(decodeNumericEntities(source));
}

function themeValue(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hasUnsafeSvgResource(svg: string): boolean {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.querySelector('parsererror')) return true;
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.localName.toLocaleLowerCase();
      const value = attribute.value.trim();
      if ((name === 'href' || name === 'src') && value && !value.startsWith('#')) return true;
      if (/^(?:style|fill|stroke|filter|clip-path|mask|marker-start|marker-mid|marker-end)$/u.test(name)) {
        for (const match of value.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/giu)) if (!match[2]?.trim().startsWith('#')) return true;
      }
    }
    if (element.localName.toLocaleLowerCase() === 'style') {
      for (const match of (element.textContent ?? '').matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/giu)) if (!match[2]?.trim().startsWith('#')) return true;
    }
  }
  return false;
}

async function renderMermaid(id: string, source: string, isCurrent: () => boolean): Promise<string> {
  if (pendingMermaidRenders >= MAX_PENDING_MERMAID_RENDERS) throw new Error('Too many diagrams are waiting to render.');
  pendingMermaidRenders += 1;
  let svg = '';
  const task = mermaidQueue.then(async () => {
    if (!isCurrent()) return;
    const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([import('mermaid'), import('dompurify')]);
    if (!isCurrent()) return;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      secure: ['securityLevel', 'startOnLoad', 'flowchart', 'htmlLabels'],
      suppressErrorRendering: true,
      theme: 'base',
      fontFamily: themeValue('--font-interface') || 'Noto Sans, ui-sans-serif, system-ui, sans-serif',
      flowchart: { htmlLabels: false },
      themeVariables: {
        background: themeValue('--theme-raised'),
        primaryColor: themeValue('--theme-accent-soft'),
        primaryTextColor: themeValue('--theme-text'),
        primaryBorderColor: themeValue('--theme-border-strong'),
        lineColor: themeValue('--theme-muted'),
        secondaryColor: themeValue('--theme-panel'),
        tertiaryColor: themeValue('--theme-canvas'),
      },
    });
    const rendered = await mermaid.render(id, source);
    if (!isCurrent()) return;
    svg = DOMPurify.sanitize(rendered.svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['foreignObject', 'script'],
    });
    if (!svg.includes('<svg') || svg.length > MAX_MERMAID_OUTPUT_LENGTH || hasUnsafeSvgResource(svg)) {
      throw new Error('Mermaid did not produce a bounded, local-only SVG diagram.');
    }
  });
  mermaidQueue = task.then(() => undefined, () => undefined);
  try {
    await task;
    return svg;
  } finally {
    pendingMermaidRenders -= 1;
  }
}

export function MermaidDiagram({ source }: { source: string }) {
  const diagramId = `mermaid-${useId().replace(/:/g, '')}`;
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const sourceAllowed = isSafeMermaidSource(source);

  useEffect(() => {
    let cancelled = false;
    const currentGeneration = ++generation.current;
    const isCurrent = () => !cancelled && generation.current === currentGeneration;
    setSvg('');
    setError(!sourceAllowed);
    if (!sourceAllowed) return () => { cancelled = true; };
    const timeout = window.setTimeout(() => {
      void renderMermaid(diagramId, source, isCurrent).then((output) => {
        if (isCurrent() && output) setSvg(output);
      }).catch(() => {
        if (isCurrent()) setError(true);
      });
    }, MERMAID_RENDER_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [diagramId, source, sourceAllowed]);

  if (error) {
    return (
      <details className="mermaid-error">
        <summary>Diagram could not be rendered</summary>
        <pre><code>{sourceAllowed ? source : `${source.slice(0, 2_000)}\n… diagram source truncated …`}</code></pre>
      </details>
    );
  }
  if (!svg) return <div className="mermaid-loading" role="status">Rendering diagram…</div>;
  return <div className="mermaid-diagram" role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function inlineRasterSource(src: string): { data: string; mimeType: RuntimeImage['mimeType'] } | null {
  const prefix = /^data:(image\/(?:png|jpe?g|gif|webp));base64,/iu.exec(src);
  if (!prefix?.[1]) return null;
  const mimeType = prefix[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : prefix[1].toLowerCase();
  return { data: src.slice(prefix[0].length), mimeType: mimeType as RuntimeImage['mimeType'] };
}

function ChatImage({ src, alt = '' }: { src?: string | undefined; alt?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [remoteAllowed, setRemoteAllowed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const label = alt.trim() || 'Generated image';
  const downloadable = src ? inlineRasterSource(src) : null;
  const saveImage = async () => {
    if (!downloadable || saving) return;
    setSaving(true);
    setSaved(false);
    try {
      const result = await window.piDesktop.saveImageAs({ ...downloadable, suggestedName: label });
      setSaved(result.saved);
    } catch {
      // Keep the action available so the user can retry.
    } finally {
      setSaving(false);
    }
  };
  if (!src || failed) {
    return <span className="chat-image-error"><ImageOff size={16} /> Image unavailable{alt ? `: ${alt}` : ''}</span>;
  }
  if (/^https:/i.test(src) && !remoteAllowed) {
    return (
      <button className="chat-image-consent" type="button" onClick={() => setRemoteAllowed(true)} aria-label={`Load remote image: ${label}`}>
        <ImageIcon size={17} />
        <span><strong>{label}</strong><small>Load remote image</small></span>
      </button>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="chat-image-trigger" type="button" aria-label={`Expand image: ${label}`}>
          <img src={src} alt={label} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
          <span aria-hidden="true"><Expand size={14} /> View</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="cinematic-image-overlay" />
        <Dialog.Content
          className="cinematic-image-viewer"
          aria-describedby={undefined}
          onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
        >
          <Dialog.Title className="visually-hidden">{label}</Dialog.Title>
          <img src={src} alt={label} referrerPolicy="no-referrer" />
          <footer><span>{label}</span><small>Click outside or press Esc to close</small></footer>
          {downloadable ? (
            <AppTooltip content={saved ? 'Image saved' : 'Save image as…'}>
              <button
                className="cinematic-image-save"
                type="button"
                disabled={saving}
                aria-label={saving ? 'Saving image' : saved ? 'Image saved' : 'Save image as'}
                onClick={() => { void saveImage(); }}
              >
                {saved ? <Check size={18} /> : <Download size={18} />}
              </button>
            </AppTooltip>
          ) : null}
          <Dialog.Close className="cinematic-image-close" aria-label="Close image viewer"><X size={18} /></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function safeMarkdownUrl(url: string): string {
  const trimmed = url.trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(trimmed)) return trimmed.length <= MAX_INLINE_IMAGE_URL_LENGTH ? trimmed : '';
  if (/^blob:/i.test(trimmed) || trimmed.startsWith('#')) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'mailto:') return parsed.toString();
  } catch { /* Relative and scheme-relative resources are intentionally blocked. */ }
  return '';
}

function MermaidAwarePre({ children }: { children?: ReactNode }) {
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  if (isValidElement<{ className?: string; children?: ReactNode }>(child) && child.props.className?.split(' ').includes('language-mermaid')) {
    return <MermaidDiagram source={String(child.props.children ?? '').replace(/\n$/, '')} />;
  }
  return <pre>{children}</pre>;
}

export function MessageImages({ images }: { images: RuntimeImage[] }) {
  return <>{images.map((image, index) => (
    <ChatImage
      key={`${image.mimeType}:${index}`}
      src={`data:${image.mimeType};base64,${image.data}`}
      alt={image.alt ?? `Generated image ${index + 1}`}
    />
  ))}</>;
}

export function AssistantMarkdown({ text, images = [] }: { text: string; images?: RuntimeImage[] | undefined }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeMarkdownUrl}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
          img: ({ src, alt }) => <ChatImage src={src} alt={alt ?? ''} />,
          pre: MermaidAwarePre,
        }}
      >
        {text}
      </ReactMarkdown>
      <MessageImages images={images} />
    </div>
  );
}
