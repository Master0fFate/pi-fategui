import Editor, { DiffEditor, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
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

const commonOptions = {
  readOnly: true,
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  lineHeight: 19,
  renderWhitespace: 'selection' as const,
  padding: { top: 10, bottom: 10 },
};

export function FileMonacoViewer({ value, language, path }: { value: string; language: string; path: string }) {
  return (
    <Editor
      height="100%"
      path={`file://pi-desktop/${path}`}
      language={language}
      value={value}
      theme="vs-dark"
      options={{ ...commonOptions, wordWrap: 'off' }}
      loading={<div className="preview-loading">Loading editor…</div>}
    />
  );
}

export function DiffMonacoViewer({ original, modified, language, path }: { original: string; modified: string; language: string; path: string }) {
  return (
    <DiffEditor
      height="100%"
      original={original}
      modified={modified}
      language={language}
      theme="vs-dark"
      options={{ ...commonOptions, renderSideBySide: false, originalEditable: false }}
      loading={<div className="preview-loading">Loading diff editor…</div>}
      originalModelPath={`file://pi-desktop/original/${path}`}
      modifiedModelPath={`file://pi-desktop/modified/${path}`}
    />
  );
}
