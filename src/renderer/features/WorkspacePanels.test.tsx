import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi } from '../../shared/contracts/ipc';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { ChangesPanel } from './diffs/ChangesPanel';
import { FilesPanel } from './files/FilesPanel';

vi.mock('./files/LazyMonaco', () => ({
  LazyFileViewer: ({ path }: { path: string }) => <div data-testid="file-monaco">file:{path}</div>,
  LazyDiffViewer: ({ path }: { path: string }) => <div data-testid="diff-monaco">diff:{path}</div>,
}));

const reset = () => useWorkspaceStore.setState({
  projectPath: 'C:/project', directories: {}, expanded: new Set(), loadingDirectories: new Set(), treeTruncated: new Set(),
  query: '', searchResults: [], searchTruncated: false, searching: false, selectedFile: null, preview: null,
  previewLoading: false, git: null, gitLoading: false, selectedChange: null, diff: null, diffLoading: false, error: null,
});

describe('workspace inspector panels', () => {
  beforeEach(reset);
  afterEach(() => Reflect.deleteProperty(window, 'piDesktop'));

  it('renders changed-file and line counts and opens a bounded lazy diff preview', async () => {
    const getGitDiff = vi.fn(async () => ({ path: 'src/hello world ü.ts', state: 'text' as const, original: 'old', modified: 'new', language: 'typescript' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { getGitDiff } as unknown as PiDesktopApi });
    useWorkspaceStore.setState({
      git: {
        repository: true, branch: 'main', ahead: 0, behind: 0, additions: 3, deletions: 2, truncated: false,
        changes: [
          { path: 'src/hello world ü.ts', indexStatus: ' ', workTreeStatus: 'M', additions: 3, deletions: 2, binary: false },
          ...Array.from({ length: 999 }, (_value, index) => ({ path: `src/generated-${index}.ts`, indexStatus: ' ', workTreeStatus: 'M', additions: 0, deletions: 0, binary: false })),
        ],
      },
    });
    await useWorkspaceStore.getState().selectChange('src/hello world ü.ts');
    render(<div style={{ height: 700 }}><ChangesPanel /></div>);
    expect(screen.getByText('1000 changed')).toBeInTheDocument();
    expect(screen.getAllByText('+3').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Changed files').querySelector('[data-virtuoso-scroller]')).toBeInTheDocument();
    expect(await screen.findByTestId('diff-monaco')).toHaveTextContent('src/hello world ü.ts');
    expect(getGitDiff).toHaveBeenCalledWith('src/hello world ü.ts');
    expect(screen.queryByRole('button', { name: /revert|accept/i })).not.toBeInTheDocument();
  });

  it('browses incremental tree entries and shows a lazy text file preview', async () => {
    const readFile = vi.fn(async () => ({ path: 'src/app.ts', name: 'app.ts', size: 12, state: 'text' as const, content: 'export {};', language: 'typescript' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { readFile } as unknown as PiDesktopApi });
    useWorkspaceStore.setState({ directories: { '': [{ path: 'src/app.ts', name: 'app.ts', kind: 'file', symlink: false }] } });
    await useWorkspaceStore.getState().selectFile('src/app.ts');
    render(<div style={{ height: 700 }}><FilesPanel /></div>);
    expect(screen.getByLabelText('Project file tree').querySelector('[data-virtuoso-scroller]')).toBeInTheDocument();
    expect(await screen.findByTestId('file-monaco')).toHaveTextContent('src/app.ts');
    expect(readFile).toHaveBeenCalledWith('src/app.ts');
  });
});
