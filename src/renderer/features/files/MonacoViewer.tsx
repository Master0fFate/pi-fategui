import Editor, { loader } from '@monaco-editor/react';
import * as monaco from './monacoRuntime';
import { useEffect, useId, useRef, useState } from 'react';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

loader.config({ monaco });

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
    return new EditorWorker();
  },
};

const readMonacoAppearance = () => ({
  theme: document.documentElement.dataset.themeTone === 'light' ? 'vs' : 'vs-dark',
  fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim()
    || '"JetBrains Mono Variable", "Noto Sans Mono Variable", ui-monospace, Consolas, monospace',
});

const useMonacoAppearance = () => {
  const [appearance, setAppearance] = useState(readMonacoAppearance);
  useEffect(() => {
    const sync = () => setAppearance(readMonacoAppearance());
    window.addEventListener('fate-theme-change', sync);
    window.addEventListener('fate-font-change', sync);
    return () => {
      window.removeEventListener('fate-theme-change', sync);
      window.removeEventListener('fate-font-change', sync);
    };
  }, []);
  return appearance;
};

const commonOptions = {
  readOnly: true,
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  lineHeight: 19,
  renderWhitespace: 'selection' as const,
  fontLigatures: true,
  padding: { top: 10, bottom: 10 },
};

export function FileMonacoViewer({ value, language, path }: { value: string; language: string; path: string }) {
  const { theme, fontFamily } = useMonacoAppearance();
  return (
    <Editor
      height="100%"
      path={`file://pi-desktop/${path}`}
      language={language}
      value={value}
      theme={theme}
      options={{ ...commonOptions, fontFamily, wordWrap: 'off' }}
      loading={<div className="preview-loading">Loading editor…</div>}
    />
  );
}

export function DiffMonacoViewer({ original, modified, language, path }: { original: string; modified: string; language: string; path: string }) {
  const { theme, fontFamily } = useMonacoAppearance();
  const viewerId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    // Each viewer owns its models, even when two previews show the same path.
    const modelUri = (side: string) => monaco.Uri.from({
      scheme: 'file', authority: 'pi-desktop',
      path: `/diff/${encodeURIComponent(viewerId)}/${side}/${path}`,
    });
    const originalModel = monaco.editor.createModel('', undefined, modelUri('original'));
    const modifiedModel = monaco.editor.createModel('', undefined, modelUri('modified'));
    const editor = monaco.editor.createDiffEditor(containerRef.current, {
      ...commonOptions, renderSideBySide: false, originalEditable: false,
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
      // Monaco requires reset before either attached text model is disposed.
      // Own the whole teardown rather than relying on React DiffEditor's order.
      editor.setModel(null);
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [path, viewerId]);

  useEffect(() => {
    const models = editorRef.current?.getModel();
    if (!models) return;
    // A same-path refresh updates live models without replacing or disposing them.
    if (models.original.getValue() !== original) models.original.setValue(original);
    if (models.modified.getValue() !== modified) models.modified.setValue(modified);
    monaco.editor.setModelLanguage(models.original, language);
    monaco.editor.setModelLanguage(models.modified, language);
  }, [original, modified, language, path]);

  useEffect(() => {
    monaco.editor.setTheme(theme);
    editorRef.current?.updateOptions({ fontFamily });
  }, [theme, fontFamily, path]);

  return <div ref={containerRef} style={{ height: '100%', width: '100%' }} />;
}
