import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getAppliedSkin, subscribeSkinChanges } from '../skin';

interface Hint { text: string; left: number; top: number; above?: number }
const tooltipId = 'skin-native-title-tooltip';

export function NativeTitleTooltips() {
  const skin = useSyncExternalStore(subscribeSkinChanges, getAppliedSkin, getAppliedSkin);
  const enabled = skin.base === 'dreamcore' || Boolean(skin.styles);
  const [hint, setHint] = useState<Hint | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled) { setHint(null); return; }
    let active: Element | null = null;
    let titleNode: Element | null = null;
    let original = '';
    let describedBy: string | null = null;
    let observer: MutationObserver | null = null;
    const clear = () => {
      observer?.disconnect(); observer = null;
      if (active) {
        if (titleNode) { if (!titleNode.textContent) titleNode.textContent = original; }
        else if (!active.hasAttribute('title')) active.setAttribute('title', original);
        if (active.getAttribute('aria-describedby')?.includes(tooltipId)) {
          if (describedBy) active.setAttribute('aria-describedby', describedBy);
          else active.removeAttribute('aria-describedby');
        }
      }
      active = null; titleNode = null; setHint(null);
    };
    const show = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('.tooltip')) return;
      let candidate = target.closest('[title]');
      const svgTitle = candidate ? null : target.querySelector(':scope > title');
      if (!candidate && svgTitle) candidate = target;
      if (!candidate && active?.contains(target)) return;
      if (!candidate) { clear(); return; }
      if (candidate === active) return;
      clear();
      const text = candidate.getAttribute('title') ?? svgTitle?.textContent ?? '';
      if (!text.trim()) return;
      active = candidate; titleNode = svgTitle; original = text;
      describedBy = candidate.getAttribute('aria-describedby');
      candidate.setAttribute('aria-describedby', [describedBy, tooltipId].filter(Boolean).join(' '));
      const position = () => {
        if (!active?.isConnected) { clear(); return; }
        const rect = active.getBoundingClientRect();
        const above = active.closest('.browser-workspace') ? rect.top : undefined;
        setHint({ text: original.slice(0, 2000), left: Math.max(12, Math.min(rect.left, window.innerWidth - 432)), top: above === undefined ? Math.min(rect.bottom + 8, window.innerHeight - 48) : Math.max(12, above - 32), ...(above === undefined ? {} : { above }) });
      };
      if (titleNode) titleNode.textContent = '';
      else candidate.removeAttribute('title');
      observer = new MutationObserver(() => {
        const updated = titleNode ? titleNode.textContent : active?.getAttribute('title');
        if (!updated) return;
        original = updated;
        if (titleNode) titleNode.textContent = '';
        else active?.removeAttribute('title');
        position();
      });
      observer.observe(titleNode ?? candidate, titleNode ? { childList: true, characterData: true, subtree: true } : { attributes: true, attributeFilter: ['title'] });
      position();
    };
    const leave = (event: Event) => {
      const related = (event as MouseEvent | FocusEvent).relatedTarget;
      if (!(related instanceof Node) || !active?.contains(related)) clear();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    document.addEventListener('mouseover', show);
    document.addEventListener('focusin', show);
    document.addEventListener('mouseout', leave);
    document.addEventListener('focusout', leave);
    document.addEventListener('pointerdown', clear);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', clear);
    window.addEventListener('scroll', clear, true);
    return () => {
      clear();
      document.removeEventListener('mouseover', show); document.removeEventListener('focusin', show);
      document.removeEventListener('mouseout', leave); document.removeEventListener('focusout', leave);
      document.removeEventListener('pointerdown', clear); document.removeEventListener('keydown', key);
      window.removeEventListener('resize', clear); window.removeEventListener('scroll', clear, true);
    };
  }, [enabled]);
  useLayoutEffect(() => {
    if (!hint || !box.current) return;
    if (hint.above !== undefined) {
      const top = Math.max(12, hint.above - box.current.getBoundingClientRect().height - 8);
      if (Math.abs(top - hint.top) > 0.5) setHint((current) => current ? { ...current, top } : null);
      return;
    }
    const overflow = box.current.getBoundingClientRect().bottom - window.innerHeight + 12;
    if (overflow > 0.5 && hint.top > 12) setHint((current) => current ? { ...current, top: Math.max(12, current.top - overflow) } : null);
  }, [hint]);
  return hint ? createPortal(<div ref={box} id={tooltipId} role="tooltip" className="tooltip skin-native-tooltip" style={{ position: 'fixed', left: hint.left, top: hint.top, maxWidth: 'min(420px, calc(100vw - 24px))', maxHeight: hint.above === undefined ? 'calc(100vh - 24px)' : `${Math.max(28, hint.above - 24)}px`, overflow: 'hidden', pointerEvents: 'none' }}>{hint.text}</div>, document.body) : null;
}
