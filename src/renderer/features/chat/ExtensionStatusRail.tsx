import * as Popover from '@radix-ui/react-popover';
import { Activity, ChevronUp } from 'lucide-react';
import { memo, useMemo } from 'react';
import type { ExtensionUiState } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';

const MAX_STATUS_ITEMS = 16;
const MAX_WIDGET_ITEMS = 8;
const MAX_WIDGET_LINES = 32;

function cleanText(value: string | null, limit: number): string | null {
  const clean = value?.trim().slice(0, limit) ?? '';
  return clean || null;
}

function normalizedExtensionState(state: ExtensionUiState | undefined): ExtensionUiState | null {
  if (!state) return null;
  const statuses = new Map<string, string>();
  for (const status of state.statuses.slice(0, MAX_STATUS_ITEMS)) {
    const key = cleanText(status.key, 100);
    const text = cleanText(status.text, 500);
    if (!key || !text) continue;
    // Malformed duplicate keys cannot create duplicate React keys; the final
    // value wins while valid bridge snapshots retain their insertion order.
    statuses.set(key, text);
  }
  const widgets = new Map<string, string[]>();
  for (const widget of state.widgets.slice(0, MAX_WIDGET_ITEMS)) {
    const key = cleanText(widget.key, 100);
    const lines = widget.lines.slice(0, MAX_WIDGET_LINES)
      .flatMap((line) => cleanText(line, 500) ?? []);
    if (key && lines.length > 0) widgets.set(key, lines);
  }
  const normalized: ExtensionUiState = {
    statuses: [...statuses].map(([key, text]) => ({ key, text })),
    widgets: [...widgets].map(([key, lines]) => ({ key, lines })),
    working: cleanText(state.working, 300),
    title: cleanText(state.title, 300),
  };
  return normalized.working || normalized.title || normalized.statuses.length > 0 || normalized.widgets.length > 0
    ? normalized
    : null;
}

function primaryText(state: ExtensionUiState): string {
  return state.working
    ?? state.statuses.at(-1)?.text
    ?? state.title
    ?? state.widgets.at(-1)?.lines.at(-1)
    ?? '';
}

function detailCount(state: ExtensionUiState): number {
  return Number(Boolean(state.title))
    + Number(Boolean(state.working))
    + state.statuses.length
    + state.widgets.reduce((count, widget) => count + widget.lines.length, 0);
}

export const ExtensionStatusRail = memo(function ExtensionStatusRail() {
  const extensionUi = useRuntimeStore((state) => state.runtime.extensionUi);
  const content = useMemo(() => {
    const normalized = normalizedExtensionState(extensionUi);
    if (!normalized) return null;
    const latestStatus = normalized.statuses.at(-1);
    const latestWidget = normalized.widgets.at(-1);
    return {
      state: normalized,
      primary: primaryText(normalized),
      count: detailCount(normalized),
      // Announce category/key changes, not status text updates that extensions
      // may emit token-by-token. The visible line remains available on demand.
      announcement: normalized.working
        ? 'Pi extension is working'
        : latestStatus
          ? `Pi extension status available: ${latestStatus.key}`
          : normalized.title
            ? 'Pi extension title available'
            : latestWidget
              ? `Pi extension widget available: ${latestWidget.key}`
              : 'Pi extension activity available',
    };
  }, [extensionUi]);

  if (!content) return null;
  const { state } = content;

  return (
    <>
      <div className="extension-status-rail" role="status" aria-label="Pi extension status" aria-live="off">
        <Activity className="extension-status-mark" size={11} aria-hidden="true" />
        <span className="extension-status-primary">{content.primary}</span>
        {content.count > 1 && (
          <Popover.Root>
            <Popover.Trigger asChild>
              <button className="extension-status-details-trigger" type="button" aria-label={`Show ${content.count} extension details`}>
                {content.count} details <ChevronUp size={10} aria-hidden="true" />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content className="extension-status-popover" role="dialog" aria-label="Extension details" side="top" align="end" sideOffset={7} collisionPadding={12}>
                <div className="extension-status-popover-heading">Pi extension output</div>
                <dl>
                  {state.working && <div><dt>Working</dt><dd>{state.working}</dd></div>}
                  {state.statuses.map((status) => <div key={`status:${status.key}`}><dt>Status · {status.key}</dt><dd>{status.text}</dd></div>)}
                  {state.title && <div><dt>Title</dt><dd>{state.title}</dd></div>}
                  {state.widgets.map((widget) => (
                    <div key={`widget:${widget.key}`}><dt>Widget · {widget.key}</dt><dd>{widget.lines.join('\n')}</dd></div>
                  ))}
                </dl>
                <Popover.Arrow className="extension-status-popover-arrow" width={10} height={5} />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        )}
      </div>
      <span className="visually-hidden" aria-live="polite">{content.announcement}</span>
    </>
  );
});
