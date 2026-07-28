import type { ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent';
import type { ExtensionUiState } from '../../shared/contracts/ipc';

export type ExtensionNoticeLevel = 'info' | 'warning' | 'error';

interface ExtensionUiOptions {
  notify: (message: string, level: ExtensionNoticeLevel) => void;
  onStateChange?: (state: ExtensionUiState) => void;
}

export interface PiExtensionUiBridge {
  context: ExtensionUIContext;
  getState: () => ExtensionUiState;
  clear: () => void;
}

const MAX_STATUS_KEYS = 16;
const MAX_WIDGETS = 8;
const MAX_WIDGET_LINES = 32;
const MAX_EXTENSION_KEY_CHARACTERS = 100;
const MAX_EXTENSION_LINE_CHARACTERS = 500;
const MAX_WORKING_CHARACTERS = 300;
const MAX_TITLE_CHARACTERS = 300;

const identity = (text: string): string => text;
const neutralTheme = {
  fg: (_color: unknown, text: string) => text,
  bg: (_color: unknown, text: string) => text,
  bold: identity,
  italic: identity,
  underline: identity,
  inverse: identity,
  strikethrough: identity,
  getFgAnsi: () => '',
  getBgAnsi: () => '',
  getColorMode: () => 'truecolor',
  getThinkingBorderColor: () => identity,
  getBashModeBorderColor: () => identity,
} as unknown as Theme;

function stripTerminalSequences(value: string): string {
  return value
    // OSC (window title, hyperlinks, clipboard, and similar). Treat an
    // unterminated control string as consuming the remainder of the input.
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu, '')
    // DCS/SOS/PM/APC strings, including their single-byte C1 forms.
    .replace(/(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/gu, '')
    // CSI sequences, including the single-byte C1 form.
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, '')
    // Remaining escape sequences and C0/C1 controls.
    .replace(/\u001b[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
}

function boundedString(value: unknown, inputLimit: number): string {
  try {
    return String(value ?? '').slice(0, inputLimit);
  } catch {
    return '';
  }
}

function truncateUtf16(value: string, limit: number): string {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result;
}

function cleanLine(value: unknown, limit: number): string {
  const boundedInput = boundedString(value, Math.max(4_096, limit * 8));
  const clean = stripTerminalSequences(boundedInput)
    .replace(/[\r\n\t\u2028\u2029]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return truncateUtf16(clean, limit);
}

export function emptyExtensionUiState(): ExtensionUiState {
  return { statuses: [], widgets: [], working: null, title: null };
}

export function createPiExtensionUiBridge({ notify, onStateChange }: ExtensionUiOptions): PiExtensionUiBridge {
  const statuses = new Map<string, string>();
  const widgets = new Map<string, string[]>();
  let working: string | null = null;
  let title: string | null = null;

  const snapshot = (): ExtensionUiState => ({
    statuses: [...statuses].map(([key, text]) => ({ key, text })),
    widgets: [...widgets].map(([key, lines]) => ({ key, lines: [...lines] })),
    working,
    title,
  });
  const changed = () => onStateChange?.(snapshot());
  const clear = () => {
    if (statuses.size === 0 && widgets.size === 0 && working === null && title === null) return;
    statuses.clear();
    widgets.clear();
    working = null;
    title = null;
    changed();
  };

  const context: ExtensionUIContext = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify(message, level = 'info') {
      const clean = cleanExtensionNotice(message);
      if (clean) notify(clean, level);
    },
    onTerminalInput: () => () => undefined,
    setStatus(key, text) {
      const cleanKey = cleanLine(key, MAX_EXTENSION_KEY_CHARACTERS);
      if (!cleanKey) return;
      if (text == null) {
        if (statuses.delete(cleanKey)) changed();
        return;
      }
      const cleanText = cleanLine(text, MAX_EXTENSION_LINE_CHARACTERS);
      if (!cleanText) {
        if (statuses.delete(cleanKey)) changed();
        return;
      }
      if (!statuses.has(cleanKey) && statuses.size >= MAX_STATUS_KEYS) return;
      if (statuses.get(cleanKey) === cleanText) return;
      statuses.set(cleanKey, cleanText);
      changed();
    },
    setWorkingMessage(message) {
      const next = message == null ? null : cleanLine(message, MAX_WORKING_CHARACTERS) || null;
      if (next === working) return;
      working = next;
      changed();
    },
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget(key, content) {
      if (content != null && !Array.isArray(content)) return;
      const cleanKey = cleanLine(key, MAX_EXTENSION_KEY_CHARACTERS);
      if (!cleanKey) return;
      const lines = Array.isArray(content)
        ? content.slice(0, MAX_WIDGET_LINES).map((line) => cleanLine(line, MAX_EXTENSION_LINE_CHARACTERS)).filter(Boolean)
        : undefined;
      if (!lines?.length) {
        if (widgets.delete(cleanKey)) changed();
        return;
      }
      if (!widgets.has(cleanKey) && widgets.size >= MAX_WIDGETS) return;
      const current = widgets.get(cleanKey);
      if (current?.length === lines.length && current.every((line, index) => line === lines[index])) return;
      widgets.set(cleanKey, lines);
      changed();
    },
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle(nextTitle) {
      const next = nextTitle == null ? null : cleanLine(nextTitle, MAX_TITLE_CHARACTERS) || null;
      if (next === title) return;
      title = next;
      changed();
    },
    custom: async <T>() => undefined as T,
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => '',
    editor: async () => undefined,
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    theme: neutralTheme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Theme switching is controlled by Fate UI.' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  };

  return { context, getState: snapshot, clear };
}

export function createPiExtensionUi(options: ExtensionUiOptions): ExtensionUIContext {
  return createPiExtensionUiBridge(options).context;
}

export function cleanExtensionNotice(message: string): string {
  const clean = stripTerminalSequences(boundedString(message, 128_000))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+/gu, '')
    .trim();
  return clean.length <= 64_000 ? clean : `${clean.slice(0, 64_000)}\n… extension output truncated by Fate UI`;
}
