import { cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffMonacoViewer } from './MonacoViewer';

const runtime = vi.hoisted(() => {
  type Model = { id: number; uri: string; value: string; disposed: boolean;
    getValue: () => string; setValue: (value: string) => void; dispose: () => void };
  type Pair = { original: Model; modified: Model };
  type Editor = { id: number; model: Pair | null; disposed: boolean;
    setModel: (model: Pair | null) => void; getModel: () => Pair | null;
    updateOptions: ReturnType<typeof vi.fn>; dispose: () => void };
  const models: Model[] = [];
  const editors: Editor[] = [];
  const events: string[] = [];
  return {
    models, editors, events,
    Uri: { from: ({ scheme, authority, path }: { scheme: string; authority: string; path: string }) => `${scheme}://${authority}${path}` },
    editor: {
      createModel: vi.fn((value: string, _language: unknown, uri: string) => {
        const model: Model = {
          id: models.length, uri, value, disposed: false,
          getValue: () => model.value,
          setValue: (next) => {
            if (model.disposed) throw new Error('Updating a disposed model');
            model.value = next;
          },
          dispose: () => {
            if (editors.some((editor) => editor.model?.original === model || editor.model?.modified === model)) {
              throw new Error('TextModel got disposed before DiffEditorWidget model got reset');
            }
            if (model.disposed) throw new Error('Model disposed twice');
            events.push(`model:${model.id}:dispose`);
            model.disposed = true;
          },
        };
        models.push(model);
        return model;
      }),
      createDiffEditor: vi.fn(() => {
        const editor: Editor = {
          id: editors.length, model: null, disposed: false,
          setModel: (model) => {
            if (editor.disposed) throw new Error('Resetting a disposed editor');
            if (model?.original.disposed || model?.modified.disposed) throw new Error('Attaching disposed models');
            events.push(`editor:${editor.id}:${model ? 'attach' : 'reset'}`);
            editor.model = model;
          },
          getModel: () => {
            if (editor.disposed) throw new Error('Reading a disposed editor');
            return editor.model;
          },
          updateOptions: vi.fn(),
          dispose: () => {
            if (editor.model) throw new Error('Editor disposed before model reset');
            if (editor.disposed) throw new Error('Editor disposed twice');
            events.push(`editor:${editor.id}:dispose`);
            editor.disposed = true;
          },
        };
        editors.push(editor);
        return editor;
      }),
      setModelLanguage: vi.fn(),
      setTheme: vi.fn(),
    },
  };
});

vi.mock('./monacoRuntime', () => runtime);
vi.mock('@monaco-editor/react', () => ({ default: () => null, loader: { config: vi.fn() } }));
vi.mock('monaco-editor/language/css/css.worker.js?worker', () => ({ default: vi.fn() }));
vi.mock('monaco-editor/editor/editor.worker.js?worker', () => ({ default: vi.fn() }));
vi.mock('monaco-editor/language/html/html.worker.js?worker', () => ({ default: vi.fn() }));
vi.mock('monaco-editor/language/json/json.worker.js?worker', () => ({ default: vi.fn() }));
vi.mock('monaco-editor/language/typescript/ts.worker.js?worker', () => ({ default: vi.fn() }));

const props = { original: 'before', modified: 'after', language: 'typescript', path: 'sentinel.ts' };
const teardown = (editor: number, original: number, modified: number) => [
  `editor:${editor}:reset`, `editor:${editor}:dispose`, `model:${original}:dispose`, `model:${modified}:dispose`,
];

describe('DiffMonacoViewer lifecycle', () => {
  beforeEach(() => {
    runtime.models.length = 0;
    runtime.editors.length = 0;
    runtime.events.length = 0;
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('refreshes same-path text and language without disposing live models', () => {
    const view = render(<DiffMonacoViewer {...props} />);
    view.rerender(<DiffMonacoViewer {...props} original="new before" modified="new after" language="javascript" />);
    expect(runtime.models).toHaveLength(2);
    expect(runtime.editors).toHaveLength(1);
    expect(runtime.models.map((model) => model.value)).toEqual(['new before', 'new after']);
    expect(runtime.models.every((model) => !model.disposed)).toBe(true);
    expect(runtime.editor.setModelLanguage).toHaveBeenCalledWith(runtime.models[0], 'javascript');
    expect(runtime.editor.setModelLanguage).toHaveBeenCalledWith(runtime.models[1], 'javascript');
    view.unmount();
    expect(runtime.events).toEqual(['editor:0:attach', ...teardown(0, 0, 1)]);
  });

  it('resets and releases the old editor and models before switching paths', () => {
    const view = render(<DiffMonacoViewer {...props} />);
    view.rerender(<DiffMonacoViewer {...props} path="other.ts" modified="other after" />);
    expect(runtime.events).toEqual(['editor:0:attach', ...teardown(0, 0, 1), 'editor:1:attach']);
    expect(runtime.models.slice(0, 2).every((model) => model.disposed)).toBe(true);
    expect(runtime.models.slice(2).map((model) => model.value)).toEqual(['before', 'other after']);
    view.unmount();
    expect(runtime.events.slice(-4)).toEqual(teardown(1, 2, 3));
  });

  it('keeps same-path viewers independently owned when either closes', () => {
    const first = render(<DiffMonacoViewer {...props} />);
    const second = render(<DiffMonacoViewer {...props} />);
    expect(new Set(runtime.models.map((model) => model.uri)).size).toBe(4);
    first.unmount();
    expect(runtime.models.slice(0, 2).every((model) => model.disposed)).toBe(true);
    expect(runtime.models.slice(2).every((model) => !model.disposed)).toBe(true);
    expect(runtime.editors[1]?.model?.modified.value).toBe('after');
    second.unmount();
    expect(runtime.models.every((model) => model.disposed)).toBe(true);
  });

  it('resets before disposal during StrictMode replay and final unmount', () => {
    const view = render(<StrictMode><DiffMonacoViewer {...props} /></StrictMode>);
    expect(runtime.events).toEqual(['editor:0:attach', ...teardown(0, 0, 1), 'editor:1:attach']);
    view.unmount();
    expect(runtime.events.slice(-4)).toEqual(teardown(1, 2, 3));
    expect(runtime.models.every((model) => model.disposed)).toBe(true);
    expect(runtime.editors.every((editor) => editor.disposed)).toBe(true);
  });
});
