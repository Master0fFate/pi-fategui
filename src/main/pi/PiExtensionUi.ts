import type { ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent';

export type ExtensionNoticeLevel = 'info' | 'warning' | 'error';

interface ExtensionUiOptions {
  notify: (message: string, level: ExtensionNoticeLevel) => void;
}

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

export function createPiExtensionUi({ notify }: ExtensionUiOptions): ExtensionUIContext {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify(message, level = 'info') {
      const clean = cleanExtensionNotice(message);
      if (clean) notify(clean, level);
    },
    onTerminalInput: () => () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
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
}

export function cleanExtensionNotice(message: string): string {
  const withoutAnsi = String(message).replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
  const clean = withoutAnsi.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu, '').trim();
  return clean.length <= 64_000 ? clean : `${clean.slice(0, 64_000)}\n… extension output truncated by Fate UI`;
}
